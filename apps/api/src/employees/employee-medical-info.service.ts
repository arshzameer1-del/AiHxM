import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { EmployeeMedicalInfoView, UpsertEmployeeMedicalInfoRequest } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { sensitive } from "../crypto/sensitive-fields";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { isOwnEmployee } from "./employee-self-read";

const MODULE_KEY = "employee" as const;
const VIEW = "employee.medical.view";
const MANAGE = "employee.medical.manage";

/** [request key, column, encrypted?] */
const FIELDS: Array<[keyof UpsertEmployeeMedicalInfoRequest, string, boolean]> = [
  ["bloodGroup", "blood_group", false],
  ["allergies", "allergies", true],
  ["chronicConditions", "chronic_conditions", true],
  ["disabilityNote", "disability_note", true],
  ["emergencyMedicalNote", "emergency_medical_note", true],
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(employeeId: string, row: any | undefined, companyId: string, isOwn: boolean): EmployeeMedicalInfoView {
  const dec = (v: string | null | undefined) => (v ? sensitive.decrypt(companyId, v) : null);
  return {
    employeeId,
    bloodGroup: row?.blood_group ?? null,
    allergies: dec(row?.allergies),
    chronicConditions: dec(row?.chronic_conditions),
    disabilityNote: dec(row?.disability_note),
    emergencyMedicalNote: dec(row?.emergency_medical_note),
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
    isOwn,
  };
}

/**
 * BACKLOG54 - medical information. Strict access: only the person themselves and people holding the new
 * employee.medical.view / employee.medical.manage permissions (hr_admin) can read it; line managers, finance and
 * system admins cannot, even with employee.view. The free-text fields are encrypted at rest and the audit log records
 * which fields changed, never their content.
 */
@Injectable()
export class EmployeeMedicalInfoService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async get(claims: RequestClaims, employeeId: string): Promise<EmployeeMedicalInfoView> {
    const own = await this.access(claims, employeeId, [VIEW, MANAGE]);
    return this.db.withClaims(claims, async (client) => {
      await this.mustExistEmployee(client, claims.company_id!, employeeId);
      const r = await client.query("SELECT * FROM employee_medical_info WHERE employee_id = $1", [employeeId]);
      return toView(employeeId, r.rows[0], claims.company_id!, own);
    });
  }

  async upsert(claims: RequestClaims, input: UpsertEmployeeMedicalInfoRequest): Promise<EmployeeMedicalInfoView> {
    const own = await this.access(claims, input.employeeId, [MANAGE]);
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id!;
      await this.mustExistEmployee(client, companyId, input.employeeId);
      const body = input as Record<string, unknown>;
      const cols: string[] = [];
      const values: unknown[] = [];
      for (const [key, column, encrypted] of FIELDS) {
        if (body[key] === undefined) continue;
        let v: unknown = typeof body[key] === "string" ? (String(body[key]).trim() === "" ? null : String(body[key]).trim()) : body[key];
        if (v !== null && encrypted) v = sensitive.encrypt(companyId, String(v));
        cols.push(column);
        values.push(v);
      }
      if (cols.length === 0) throw new BadRequestException("Nothing to save");
      const actor = claims.sub && /^[0-9a-f-]{36}$/i.test(claims.sub) ? claims.sub : null;
      const result = await client.query(
        `INSERT INTO employee_medical_info (company_id, employee_id, ${cols.join(", ")}, updated_by_user_account_id)
         VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(", ")}, $${cols.length + 3})
         ON CONFLICT (employee_id) DO UPDATE SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(", ")},
           updated_by_user_account_id = $${cols.length + 3}, updated_at = now()
         RETURNING *`,
        [companyId, input.employeeId, ...values, actor]
      );
      await this.audit.record(client, claims, {
        companyId,
        action: "employee_medical_info.update",
        target: input.employeeId,
        metadata: { employeeId: input.employeeId, fields: cols, bySelf: own },
      });
      return toView(input.employeeId, result.rows[0], companyId, own);
    });
  }

  /** Returns true when the caller is the person themselves; otherwise they must hold one of `permissions`. */
  private async access(claims: RequestClaims, employeeId: string, permissions: string[]): Promise<boolean> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (await isOwnEmployee(this.db, this.rbac, claims, employeeId)) return true;
    for (const p of permissions) if (await this.rbac.can(claims, p)) return false;
    throw new ForbiddenException("Not permitted to see medical information");
  }

  private async mustExistEmployee(client: import("pg").PoolClient, companyId: string, employeeId: string): Promise<void> {
    const r = await client.query("SELECT 1 FROM employees WHERE id = $1 AND company_id = $2", [employeeId, companyId]);
    if (r.rowCount === 0) throw new NotFoundException("Employee not found");
  }
}
