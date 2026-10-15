import { BadRequestException, Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import { sensitive } from "../crypto/sensitive-fields";

type PersonIdentity = {
  firstName: string;
  lastName: string;
  cnic: string | null | undefined;
  dateOfBirth: string | null | undefined;
  gender: string | null | undefined;
  maritalStatus?: string | null;
  /** EMP-02: link to this existing person instead of matching/creating one. */
  personId?: string | null;
  /** EMP-02: the caller confirms a possible-duplicate warning is a different human. */
  confirmNotDuplicate?: boolean;
};

export type PersonDuplicateCandidate = {
  personId: string;
  fullName: string;
  matchedOn: "cnic" | "date_of_birth_and_name";
  employeeNumbers: string[];
  hasActiveEmployment: boolean;
};

function normalizeName(n: string): string {
  return n.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, " ").trim();
}

/**
 * Core Employee Enterprise, Phase 1 (0081_person_identity.sql) — the
 * derived-shadow-record half of the Person/Employment split. See that
 * migration's own header comment for the full design, including the
 * deliberate deviation from this initiative's own gap-analysis doc:
 * `employees` stays the real base table; `persons` is additive, not a
 * replacement.
 *
 * Deliberately NOT its own top-level module/controller yet: there is no
 * Person UI or API surface anywhere in this codebase to justify one. It
 * lives inside EmployeesModule and is only ever called from
 * EmployeesService.create()/update(), which already hold
 * employee.manage.all — promote this to a real top-level module once a
 * later phase actually needs direct Person access (this initiative's own
 * Section 5 "Person" concept becoming a first-class screen).
 *
 * SYNC DIRECTION — the opposite way round from this module's own
 * resolveDepartment()/resolveLocation(): those two derive a legacy
 * free-text field FROM a canonical linked entity. Here it runs the other
 * way: `employees` stays authoritative for identity fields (first/last
 * name, cnic, dateOfBirth, gender — still what every screen reads and
 * writes), and `persons` is the derived shadow, kept in sync from it.
 * This is temporary by design — once a real Person UI/API exists,
 * authority can move onto `persons` without another schema change, only
 * a service-layer cutover.
 *
 * Every method here takes the caller's own transaction `client` directly
 * (this module's own EmployeesService.create()/update() convention) —
 * this service holds no state and no dependencies of its own, so a fresh
 * `new PersonsService()` is a fully real, working instance (see
 * EmployeesService's own constructor doc comment for why that matters).
 */
@Injectable()
export class PersonsService {
  /**
   * Called from EmployeesService.create(). Deterministic matching by
   * CNIC only — the one identifier this codebase already treats as a
   * real, stable national ID (0010_employee_core.sql's own header
   * comment) — never by name, which is neither unique nor stable. A
   * confirmed CNIC match against an existing person IS a rehire (or,
   * later, a genuine second concurrent employment) of that same person:
   * link to them rather than create a duplicate. An employee hired with
   * no CNIC on file gets a brand-new person; there is no safe signal to
   * match them to an existing one.
   */
  async findOrCreateForHire(client: PoolClient, companyId: string, identity: PersonIdentity): Promise<string> {
    if (identity.personId) {
      const linked = await client.query<{ id: string }>("SELECT id FROM persons WHERE id = $1 AND company_id = $2", [identity.personId, companyId]);
      if (linked.rowCount === 0) throw new BadRequestException("personId does not belong to this company");
      return linked.rows[0].id;
    }
    if (identity.cnic) {
      // SEC-02: match on the blind index; `OR cnic = $3` keeps legacy
      // plaintext rows (not yet backfilled) matchable during the transition.
      const existing = await client.query<{ id: string; date_of_birth_enc: string | null; date_of_birth: Date | string | null }>(
        "SELECT id, date_of_birth_enc, date_of_birth FROM persons WHERE company_id = $1 AND (cnic_bidx = $2 OR cnic = $3)",
        [companyId, sensitive.cnicIndex(companyId, identity.cnic), identity.cnic]
      );
      if (existing.rowCount && existing.rowCount > 0) {
        // EMP-02: a CNIC match is a rehire of that person - but a DIFFERENT
        // date of birth on the same CNIC is an identity conflict that HR must
        // resolve explicitly, never something a hire form overwrites silently.
        const onFile = sensitive.readDob(companyId, existing.rows[0].date_of_birth_enc, existing.rows[0].date_of_birth);
        if (onFile && identity.dateOfBirth && onFile !== String(identity.dateOfBirth).slice(0, 10) && !identity.confirmNotDuplicate) {
          throw new BadRequestException(
            "This CNIC is already on file for a person with a different date of birth. Correct the date of birth or resolve the person record before hiring."
          );
        }
        // Deliberately does NOT overwrite the existing person's
        // name/DOB/gender from this new hire's data: a genuine correction is
        // a Person-record edit (PersonDirectoryService.update), not a
        // hire-time side effect.
        return existing.rows[0].id;
      }
    } else if (identity.dateOfBirth && !identity.confirmNotDuplicate) {
      // No CNIC: block an obvious duplicate (same DOB blind index + same name).
      const candidates = await this.findDuplicateCandidates(client, companyId, {
        firstName: identity.firstName,
        lastName: identity.lastName,
        cnic: null,
        dateOfBirth: identity.dateOfBirth,
      });
      if (candidates.length > 0) {
        throw new BadRequestException(
          "A person with the same name and date of birth already exists in this company. If this is the same person, hire them with that person's id (personId); if not, confirm they are a different person (confirmNotDuplicate)."
        );
      }
    }
    const dob = identity.dateOfBirth ? String(identity.dateOfBirth).slice(0, 10) : null;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO persons (company_id, full_name, first_name, last_name, cnic, cnic_bidx, date_of_birth, date_of_birth_enc, date_of_birth_bidx, gender, marital_status)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10)
       RETURNING id`,
      [
        companyId,
        `${identity.firstName} ${identity.lastName}`,
        identity.firstName,
        identity.lastName,
        sensitive.encrypt(companyId, identity.cnic),
        sensitive.cnicIndex(companyId, identity.cnic),
        sensitive.encryptDob(companyId, dob),
        sensitive.dobIndex(companyId, dob),
        identity.gender ?? null,
        identity.maritalStatus ?? null,
      ]
    );
    return inserted.rows[0].id;
  }

  /**
   * EMP-02 duplicate candidates. CNIC (blind index) is an exact match;
   * date of birth (blind index) + a normalised full-name match is a
   * "possible duplicate". Never matches on name alone.
   */
  async findDuplicateCandidates(
    client: PoolClient,
    companyId: string,
    probe: { firstName?: string | null; lastName?: string | null; cnic?: string | null; dateOfBirth?: string | null },
    excludePersonId?: string
  ): Promise<PersonDuplicateCandidate[]> {
    const found = new Map<string, PersonDuplicateCandidate>();
    const add = async (row: { id: string; full_name: string }, matchedOn: PersonDuplicateCandidate["matchedOn"]) => {
      if (found.has(row.id) || row.id === excludePersonId) return;
      const emps = await client.query<{ employee_number: string; employment_status: string }>(
        "SELECT employee_number, employment_status FROM employees WHERE person_id = $1 ORDER BY date_of_joining",
        [row.id]
      );
      found.set(row.id, {
        personId: row.id,
        fullName: row.full_name,
        matchedOn,
        employeeNumbers: emps.rows.map((e) => e.employee_number),
        hasActiveEmployment: emps.rows.some((e) => e.employment_status !== "terminated"),
      });
    };
    if (probe.cnic) {
      const r = await client.query<{ id: string; full_name: string }>(
        "SELECT id, full_name FROM persons WHERE company_id = $1 AND (cnic_bidx = $2 OR cnic = $3)",
        [companyId, sensitive.cnicIndex(companyId, probe.cnic), probe.cnic]
      );
      for (const row of r.rows) await add(row, "cnic");
    }
    if (probe.dateOfBirth && (probe.firstName || probe.lastName)) {
      const wanted = normalizeName(`${probe.firstName ?? ""} ${probe.lastName ?? ""}`);
      const r = await client.query<{ id: string; full_name: string }>(
        "SELECT id, full_name FROM persons WHERE company_id = $1 AND date_of_birth_bidx = $2",
        [companyId, sensitive.dobIndex(companyId, probe.dateOfBirth)]
      );
      for (const row of r.rows) if (normalizeName(row.full_name) === wanted) await add(row, "date_of_birth_and_name");
    }
    return [...found.values()];
  }

  /**
   * Called from EmployeesService.update() only when an identity field
   * `persons` also carries has actually changed — keeps the shadow
   * record from drifting out of sync with its authoritative source,
   * mirroring resolveDepartment()/resolveLocation()'s "keep the derived
   * field in sync on every write" discipline, just running in the
   * opposite direction (see this class's own doc comment).
   *
   * Deliberately does NOT re-run CNIC matching on update: changing an
   * existing employee's CNIC to match a DIFFERENT person's is an
   * identity-merge decision (two employee rows both now claiming to be
   * the same actual human being), not a plain field edit — out of scope
   * for this phase, and dangerous to do implicitly. Instead this updates
   * the CURRENT person's own record in place, and rejects the edit
   * outright if the new CNIC is already on file for a different person
   * in this tenant, the same "throw a clear BadRequestException on
   * conflict" convention resolveDepartment()/resolveLocation() already
   * use for a not-found link target.
   */
  async syncFromEmployee(client: PoolClient, companyId: string, personId: string, identity: PersonIdentity): Promise<void> {
    if (identity.cnic) {
      const conflict = await client.query<{ id: string }>(
        "SELECT id FROM persons WHERE company_id = $1 AND (cnic_bidx = $2 OR cnic = $3) AND id <> $4",
        [companyId, sensitive.cnicIndex(companyId, identity.cnic), identity.cnic, personId]
      );
      if (conflict.rowCount && conflict.rowCount > 0) {
        throw new BadRequestException("This CNIC is already on file for a different employee");
      }
    }
    await client.query(
      `UPDATE persons SET full_name = $2, first_name = $7, last_name = $8, cnic = $3, cnic_bidx = $4, date_of_birth = NULL,
              date_of_birth_enc = $5, date_of_birth_bidx = $9, gender = $6, updated_at = now()
       WHERE id = $1`,
      [
        personId,
        `${identity.firstName} ${identity.lastName}`,
        sensitive.encrypt(companyId, identity.cnic),
        sensitive.cnicIndex(companyId, identity.cnic),
        sensitive.encryptDob(companyId, identity.dateOfBirth),
        identity.gender ?? null,
        identity.firstName,
        identity.lastName,
        sensitive.dobIndex(companyId, identity.dateOfBirth),
      ]
    );
  }
}
