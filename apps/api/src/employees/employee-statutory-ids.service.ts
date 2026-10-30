import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { EmployeeStatutoryIdsView, UpsertEmployeeStatutoryIdsRequest } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { sensitive } from "../crypto/sensitive-fields";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { requireViewOrSelf } from "./employee-self-read";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";
const VIEW_PERMISSION = "employee.view";

/** [request key, column, encrypted?] */
const FIELDS: Array<[keyof UpsertEmployeeStatutoryIdsRequest, string, boolean]> = [
  ["eobiNumber", "eobi_number", true],
  ["eobiRegistrationDate", "eobi_registration_date", false],
  ["socialSecurityScheme", "social_security_scheme", false],
  ["socialSecurityNumber", "social_security_number", true],
  ["socialSecurityRegistrationDate", "social_security_registration_date", false],
  ["providentFundNumber", "provident_fund_number", false],
  ["providentFundMemberSince", "provident_fund_member_since", false],
  ["cnicIssueDate", "cnic_issue_date", false],
  ["cnicExpiryDate", "cnic_expiry_date", false],
  ["cnicLifetime", "cnic_lifetime", false],
  ["visaType", "visa_type", false],
  ["visaExpiryDate", "visa_expiry_date", false],
  ["workPermitNumber", "work_permit_number", true],
  ["workPermitExpiryDate", "work_permit_expiry_date", false],
];

const ID_NUMBER_KEYS = new Set(["eobiNumber", "socialSecurityNumber", "providentFundNumber", "workPermitNumber"]);
const day = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const text = (v: unknown): string | null => {
  if (v == null) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(employeeId: string, row: any | undefined, companyId: string): EmployeeStatutoryIdsView {
  return {
    employeeId,
    eobiNumber: row ? sensitive.decrypt(companyId, row.eobi_number) : null,
    eobiRegistrationDate: day(row?.eobi_registration_date),
    socialSecurityScheme: row?.social_security_scheme ?? null,
    socialSecurityNumber: row ? sensitive.decrypt(companyId, row.social_security_number) : null,
    socialSecurityRegistrationDate: day(row?.social_security_registration_date),
    providentFundNumber: row?.provident_fund_number ?? null,
    providentFundMemberSince: day(row?.provident_fund_member_since),
    cnicIssueDate: day(row?.cnic_issue_date),
    cnicExpiryDate: day(row?.cnic_expiry_date),
    cnicLifetime: row?.cnic_lifetime ?? false,
    visaType: row?.visa_type ?? null,
    visaExpiryDate: day(row?.visa_expiry_date),
    workPermitNumber: row ? sensitive.decrypt(companyId, row.work_permit_number) : null,
    workPermitExpiryDate: day(row?.work_permit_expiry_date),
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

/**
 * BACKLOG49 - EOBI, PESSI/SESSI, provident fund, CNIC expiry and visa / work permit for one employee. HR (employee.view /
 * employee.manage.all) sees and edits any employee; an employee can see their own. EOBI, social security and work permit
 * numbers are encrypted at rest.
 */
@Injectable()
export class EmployeeStatutoryIdsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async get(claims: RequestClaims, employeeId: string): Promise<EmployeeStatutoryIdsView> {
    await requireViewOrSelf(this.db, this.rbac, claims, employeeId, () => this.requireView(claims));
    return this.db.withClaims(claims, async (client) => {
      await this.mustExistEmployee(client, claims.company_id!, employeeId);
      const r = await client.query("SELECT * FROM employee_statutory_ids WHERE employee_id = $1", [employeeId]);
      return toView(employeeId, r.rows[0], claims.company_id!);
    });
  }

  async upsert(claims: RequestClaims, input: UpsertEmployeeStatutoryIdsRequest): Promise<EmployeeStatutoryIdsView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id!;
      await this.mustExistEmployee(client, companyId, input.employeeId);
      const body = input as Record<string, unknown>;

      const sets: string[] = [];
      const values: unknown[] = [];
      const touched: string[] = [];
      for (const [key, column, encrypted] of FIELDS) {
        if (body[key] === undefined) continue;
        let v: unknown = typeof body[key] === "string" ? text(body[key]) : body[key];
        // Registration numbers are letters, digits and the usual separators; anything else is a typing or paste mistake.
        if (typeof v === "string" && ID_NUMBER_KEYS.has(String(key)) && !/^[A-Za-z0-9][A-Za-z0-9 ./_-]*$/.test(v)) {
          throw new BadRequestException({ message: "Use only letters, digits, spaces and - / . _ in this number.", field: String(key) });
        }
        if (v !== null && encrypted) v = sensitive.encrypt(companyId, String(v));
        values.push(v);
        sets.push(`${column} = $${values.length + 2}`);
        touched.push(String(key));
      }
      // A lifetime CNIC has no expiry date.
      if (body.cnicLifetime === true) {
        sets.push("cnic_expiry_date = NULL");
      }
      if (touched.length === 0) throw new BadRequestException("Nothing to save");

      const cols = FIELDS.filter(([k]) => body[k] !== undefined).map(([, c]) => c);
      const actor = claims.sub && /^[0-9a-f-]{36}$/i.test(claims.sub) ? claims.sub : null;
      const result = await client.query(
        `INSERT INTO employee_statutory_ids (company_id, employee_id, ${cols.join(", ")}, updated_by_user_account_id)
         VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(", ")}, $${cols.length + 3})
         ON CONFLICT (employee_id) DO UPDATE SET ${sets.join(", ")}, updated_by_user_account_id = $${cols.length + 3}, updated_at = now()
         RETURNING *`,
        [companyId, input.employeeId, ...values, actor]
      ).catch((err: { code?: string; constraint?: string }) => {
        if (err.code === "23514") throw new BadRequestException("The CNIC expiry date cannot be before its issue date");
        throw err;
      });
      if (body.cnicLifetime === true && result.rows[0].cnic_expiry_date) {
        await client.query("UPDATE employee_statutory_ids SET cnic_expiry_date = NULL WHERE employee_id = $1", [input.employeeId]);
        result.rows[0].cnic_expiry_date = null;
      }
      await this.audit.record(client, claims, {
        companyId,
        action: "employee_statutory_ids.update",
        target: input.employeeId,
        // which fields changed, never the numbers themselves
        metadata: { employeeId: input.employeeId, fields: touched },
      });
      return toView(input.employeeId, result.rows[0], companyId);
    });
  }

  private async mustExistEmployee(client: import("pg").PoolClient, companyId: string, employeeId: string): Promise<void> {
    const r = await client.query("SELECT 1 FROM employees WHERE id = $1 AND company_id = $2", [employeeId, companyId]);
    if (r.rowCount === 0) throw new NotFoundException("Employee not found");
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) throw new ForbiddenException("Not permitted to manage statutory IDs");
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const [canView, canManage] = await Promise.all([this.rbac.can(claims, VIEW_PERMISSION), this.rbac.can(claims, MANAGE_PERMISSION)]);
    if (!canView && !canManage) throw new ForbiddenException("Not permitted to view statutory IDs");
  }
}
