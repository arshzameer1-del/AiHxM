import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type {
  CreateEmployeeFamilyMemberRequest,
  EmployeeFamilyMemberView,
  UpdateEmployeeFamilyMemberRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";
const VIEW_PERMISSION = "employee.view";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToView(row: any): EmployeeFamilyMemberView {
  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    relationship: row.relationship,
    fullName: row.full_name,
    dateOfBirth: row.date_of_birth instanceof Date ? row.date_of_birth.toISOString().slice(0, 10) : row.date_of_birth,
    cnic: row.cnic,
    isDependent: row.is_dependent,
    isBeneficiary: row.is_beneficiary,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Core Employee Enterprise, Phase 9
 * (0087_core_employee_family_education_qualifications_assets.sql) — the
 * Family/Dependents card's real sub-entity. See EmployeeContactsService's
 * own doc comment for the shared design rationale. Unlike Phase 6/7/8's
 * sub-entities, this is a pure LIST — an employee normally has several
 * family members, so there is no "one open row per type" constraint to
 * maintain here at all.
 */
@Injectable()
export class EmployeeFamilyMembersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async create(claims: RequestClaims, input: CreateEmployeeFamilyMemberRequest): Promise<EmployeeFamilyMemberView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, (client) => this.createWithinTransaction(client, claims, input));
  }

  async createWithinTransaction(
    client: PoolClient,
    claims: RequestClaims,
    input: CreateEmployeeFamilyMemberRequest
  ): Promise<EmployeeFamilyMemberView> {
    await this.mustExistEmployee(client, claims.company_id!, input.employeeId);

    const inserted = await client.query(
      `INSERT INTO employee_family_members
         (company_id, employee_id, relationship, full_name, date_of_birth, cnic, is_dependent, is_beneficiary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        claims.company_id,
        input.employeeId,
        input.relationship,
        input.fullName,
        input.dateOfBirth ?? null,
        input.cnic ?? null,
        input.isDependent ?? true,
        input.isBeneficiary ?? false,
      ]
    );
    const view = rowToView(inserted.rows[0]);

    await this.audit.record(client, claims, {
      companyId: claims.company_id ?? null,
      action: "employee_family_member.create",
      target: view.id,
      metadata: { employeeId: input.employeeId, relationship: input.relationship },
    });

    return view;
  }

  async list(claims: RequestClaims, employeeId: string): Promise<EmployeeFamilyMemberView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "SELECT * FROM employee_family_members WHERE employee_id = $1 AND status = 'active' ORDER BY created_at",
        [employeeId]
      );
      return result.rows.map(rowToView);
    });
  }

  async update(claims: RequestClaims, id: string, patch: UpdateEmployeeFamilyMemberRequest): Promise<EmployeeFamilyMemberView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      const result = await client.query(
        `UPDATE employee_family_members SET
           relationship = COALESCE($2, relationship),
           full_name = COALESCE($3, full_name),
           date_of_birth = COALESCE($4, date_of_birth),
           cnic = COALESCE($5, cnic),
           is_dependent = COALESCE($6, is_dependent),
           is_beneficiary = COALESCE($7, is_beneficiary),
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          id,
          patch.relationship ?? null,
          patch.fullName ?? null,
          patch.dateOfBirth ?? null,
          patch.cnic ?? null,
          patch.isDependent ?? null,
          patch.isBeneficiary ?? null,
        ]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_family_member.update",
        target: id,
        metadata: { before: rowToView(before), after: rowToView(result.rows[0]) },
      });
      return rowToView(result.rows[0]);
    });
  }

  async end(claims: RequestClaims, id: string): Promise<EmployeeFamilyMemberView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      if (before.status === "ended") return rowToView(before);
      const result = await client.query(
        "UPDATE employee_family_members SET status = 'ended', updated_at = now() WHERE id = $1 RETURNING *",
        [id]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "employee_family_member.end", target: id });
      return rowToView(result.rows[0]);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async mustExist(client: PoolClient, id: string): Promise<any> {
    const result = await client.query("SELECT * FROM employee_family_members WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundException("Employee family member not found");
    return result.rows[0];
  }

  private async mustExistEmployee(client: PoolClient, companyId: string, employeeId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM employees WHERE id = $1 AND company_id = $2", [employeeId, companyId]);
    if (result.rowCount === 0) throw new NotFoundException("Employee not found");
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage employee family members");
    }
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const [canView, canManage] = await Promise.all([this.rbac.can(claims, VIEW_PERMISSION), this.rbac.can(claims, MANAGE_PERMISSION)]);
    if (!canView && !canManage) {
      throw new ForbiddenException("Not permitted to view employee family members");
    }
  }
}
