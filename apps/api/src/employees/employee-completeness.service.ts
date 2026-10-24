import { Injectable, NotFoundException } from "@nestjs/common";
import type { ProfileCompleteness, ProfileCompletenessItem } from "@aihxm/shared-types";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeDocumentComplianceService } from "./employee-document-compliance.service";
import { EmployeesService } from "./employees.service";

type Item = Omit<ProfileCompletenessItem, "done" | "hint"> & { hintIfMissing: string };

const CHECKS: Array<Item & { sql: string }> = [
  { key: "photo", label: "Profile photo", tab: "documents", hintIfMissing: "Upload a clear photo of your face.",
    sql: "SELECT EXISTS (SELECT 1 FROM employee_documents WHERE employee_id = $1 AND document_type = 'photograph' AND review_status = 'approved') AS ok" },
  { key: "personal_phone", label: "Personal phone number", tab: "contact", hintIfMissing: "Add a personal mobile number HR can reach you on.",
    sql: "SELECT EXISTS (SELECT 1 FROM employee_contacts WHERE employee_id = $1 AND status = 'active' AND contact_type = 'personal_phone') AS ok" },
  { key: "personal_email", label: "Personal email", tab: "contact", hintIfMissing: "Add a personal email address.",
    sql: "SELECT EXISTS (SELECT 1 FROM employee_contacts WHERE employee_id = $1 AND status = 'active' AND contact_type = 'personal_email') AS ok" },
  { key: "emergency_contact", label: "Emergency contact with relationship", tab: "contact", hintIfMissing: "Add someone to call in an emergency and say who they are to you.",
    sql: "SELECT EXISTS (SELECT 1 FROM employee_contacts WHERE employee_id = $1 AND status = 'active' AND contact_type = 'emergency_contact' AND btrim(coalesce(relationship, '')) <> '') AS ok" },
  { key: "address", label: "Home address", tab: "addresses", hintIfMissing: "Add your current or permanent address.",
    sql: "SELECT EXISTS (SELECT 1 FROM employee_addresses WHERE employee_id = $1 AND status = 'active') AS ok" },
  { key: "bank_account", label: "Approved bank account", tab: "bank", hintIfMissing: "Add the bank account your salary is paid into; HR approves it.",
    sql: "SELECT EXISTS (SELECT 1 FROM employee_payment_accounts WHERE employee_id = $1 AND status = 'active' AND approval_status = 'approved') AS ok" },
  { key: "cnic", label: "CNIC number", tab: "personal", hintIfMissing: "HR needs your CNIC number on file.",
    sql: "SELECT (cnic IS NOT NULL AND btrim(cnic) <> '') AS ok FROM employees WHERE id = $1" },
  { key: "cnic_expiry", label: "CNIC expiry date", tab: "personal", hintIfMissing: "Record when your CNIC expires, or mark it as lifetime.",
    sql: "SELECT EXISTS (SELECT 1 FROM employee_statutory_ids WHERE employee_id = $1 AND (cnic_expiry_date IS NOT NULL OR cnic_lifetime = true)) AS ok" },
  { key: "date_of_birth", label: "Date of birth", tab: "personal", hintIfMissing: "HR needs your date of birth on file.",
    sql: "SELECT (date_of_birth IS NOT NULL OR date_of_birth_enc IS NOT NULL) AS ok FROM employees WHERE id = $1" },
  { key: "marital_status", label: "Marital status", tab: "personal", hintIfMissing: "Tell HR your marital status.",
    sql: "SELECT (marital_status IS NOT NULL AND btrim(marital_status) <> '') AS ok FROM employees WHERE id = $1" },
  { key: "education", label: "Education or qualification", tab: "family", hintIfMissing: "Add your highest degree or a qualification.",
    sql: `SELECT (EXISTS (SELECT 1 FROM employee_education WHERE employee_id = $1 AND status = 'active')
                  OR EXISTS (SELECT 1 FROM employee_qualifications WHERE employee_id = $1 AND status = 'active')) AS ok` },
];

/**
 * BACKLOG53 - "your profile is 70% complete". Each check is a plain yes/no on data that already exists, so the score and
 * the list of what is missing can never disagree. The mandatory documents HR chose in the Document Policy count as one more
 * check when any are required. Shown to the employee on My Profile and the launchpad, and to HR on the employee page.
 */
@Injectable()
export class EmployeeCompletenessService {
  constructor(
    private readonly db: DatabaseService,
    private readonly employees: EmployeesService,
    private readonly compliance: EmployeeDocumentComplianceService
  ) {}

  /** The signed-in person's own record. */
  async forMe(claims: RequestClaims): Promise<ProfileCompleteness> {
    const id = await this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        "SELECT id FROM employees WHERE user_account_id = $1 ORDER BY (employment_status = 'active') DESC, created_at ASC LIMIT 1",
        [claims.sub]
      );
      return r.rows[0]?.id as string | undefined;
    });
    if (!id) throw new NotFoundException("Your login is not linked to an employee record");
    return this.compute(claims, id);
  }

  /** Anyone who may see the employee record (HR, the manager in scope, the person themselves). */
  async forEmployee(claims: RequestClaims, employeeId: string): Promise<ProfileCompleteness> {
    await this.employees.get(claims, employeeId);
    return this.compute(claims, employeeId);
  }

  private async compute(claims: RequestClaims, employeeId: string): Promise<ProfileCompleteness> {
    const results = await this.db.withClaims(claims, async (client) => {
      const out: ProfileCompletenessItem[] = [];
      for (const c of CHECKS) {
        const r = await client.query(c.sql, [employeeId]);
        const done = r.rows[0]?.ok === true;
        out.push({ key: c.key, label: c.label, tab: c.tab, done, hint: done ? "" : c.hintIfMissing });
      }
      return out;
    });
    const checklist = await this.compliance.checklist(claims, employeeId).catch(() => null);
    if (checklist && checklist.requiredCount > 0) {
      const done = checklist.completeCount >= checklist.requiredCount;
      results.push({
        key: "mandatory_documents",
        label: `Mandatory documents (${checklist.completeCount} of ${checklist.requiredCount})`,
        tab: "documents",
        done,
        hint: done ? "" : "Upload the documents HR requires, or renew the ones that expired.",
      });
    }
    const doneCount = results.filter((i) => i.done).length;
    return {
      employeeId,
      score: results.length === 0 ? 100 : Math.round((doneCount / results.length) * 100),
      doneCount,
      totalCount: results.length,
      items: results,
    };
  }
}
