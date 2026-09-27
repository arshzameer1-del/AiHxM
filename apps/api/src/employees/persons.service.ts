import { BadRequestException, Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";

type PersonIdentity = {
  firstName: string;
  lastName: string;
  cnic: string | null | undefined;
  dateOfBirth: string | null | undefined;
  gender: string | null | undefined;
};

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
    if (identity.cnic) {
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM persons WHERE company_id = $1 AND cnic = $2",
        [companyId, identity.cnic]
      );
      if (existing.rowCount && existing.rowCount > 0) {
        // Deliberately does NOT overwrite the existing person's
        // name/DOB/gender from this new hire's data: the person record
        // already reflects whichever employment last synced it, and a
        // stale or mistyped re-entry on a brand-new hire form shouldn't
        // silently clobber it. A genuine correction is a Person-record
        // edit, not a hire-time side effect — out of scope until a real
        // Person UI exists.
        return existing.rows[0].id;
      }
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO persons (company_id, full_name, cnic, date_of_birth, gender)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [companyId, `${identity.firstName} ${identity.lastName}`, identity.cnic ?? null, identity.dateOfBirth ?? null, identity.gender ?? null]
    );
    return inserted.rows[0].id;
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
        "SELECT id FROM persons WHERE company_id = $1 AND cnic = $2 AND id <> $3",
        [companyId, identity.cnic, personId]
      );
      if (conflict.rowCount && conflict.rowCount > 0) {
        throw new BadRequestException("This CNIC is already on file for a different employee");
      }
    }
    await client.query(
      `UPDATE persons SET full_name = $2, cnic = $3, date_of_birth = $4, gender = $5, updated_at = now()
       WHERE id = $1`,
      [personId, `${identity.firstName} ${identity.lastName}`, identity.cnic ?? null, identity.dateOfBirth ?? null, identity.gender ?? null]
    );
  }
}
