import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type { CreateEmployeeEducationRequest, EmployeeEducationView, UpdateEmployeeEducationRequest } from "@aihxm/shared-types";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";
const VIEW_PERMISSION = "employee.view";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDateStr(value: any): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToView(row: any): EmployeeEducationView {
  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    degreeTitle: row.degree_title,
    institution: row.institution,
    fieldOfStudy: row.field_of_study,
    startDate: toDateStr(row.start_date),
    endDate: toDateStr(row.end_date),
    grade: row.grade,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Core Employee Enterprise, Phase 9
 * (0087_core_employee_family_education_qualifications_assets.sql) — the
 * Education card's real sub-entity. See EmployeeFamilyMembersService's
 * own doc comment for the shared design rationale (a pure list, no
 * one-row-per-type constraint).
 */
@Injectable()
export class EmployeeEducationService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async create(claims: RequestClaims, input: CreateEmployeeEducationRequest): Promise<EmployeeEducationView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, (client) => this.createWithinTransaction(client, claims, input));
  }

  async createWithinTransaction(
    client: PoolClient,
    claims: RequestClaims,
    input: CreateEmployeeEducationRequest
  ): Promise<EmployeeEducationView> {
    await this.mustExistEmployee(client, claims.company_id!, input.employeeId);

    const inserted = await client.query(
      `INSERT INTO employee_education (company_id, employee_id, degree_title, institution, field_of_study, start_date, end_date, grade)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        claims.company_id,
        input.employeeId,
        input.degreeTitle,
        input.institution ?? null,
        input.fieldOfStudy ?? null,
        input.startDate ?? null,
        input.endDate ?? null,
        input.grade ?? null,
      ]
    );
    const view = rowToView(inserted.rows[0]);

    await this.audit.record(client, claims, {
      companyId: claims.company_id ?? null,
      action: "employee_education.create",
      target: view.id,
      metadata: { employeeId: input.employeeId, degreeTitle: input.degreeTitle },
    });

    return view;
  }

  async list(claims: RequestClaims, employeeId: string): Promise<EmployeeEducationView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "SELECT * FROM employee_education WHERE employee_id = $1 AND status = 'active' ORDER BY start_date NULLS LAST, created_at",
        [employeeId]
      );
      return result.rows.map(rowToView);
    });
  }

  async update(claims: RequestClaims, id: string, patch: UpdateEmployeeEducationRequest): Promise<EmployeeEducationView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      const result = await client.query(
        `UPDATE employee_education SET
           degree_title = COALESCE($2, degree_title),
           institution = COALESCE($3, institution),
           field_of_study = COALESCE($4, field_of_study),
           start_date = COALESCE($5, start_date),
           end_date = COALESCE($6, end_date),
           grade = COALESCE($7, grade),
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, patch.degreeTitle ?? null, patch.institution ?? null, patch.fieldOfStudy ?? null, patch.startDate ?? null, patch.endDate ?? null, patch.grade ?? null]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_education.update",
        target: id,
        metadata: { before: rowToView(before), after: rowToView(result.rows[0]) },
      });
      return rowToView(result.rows[0]);
    });
  }

  async end(claims: RequestClaims, id: string): Promise<EmployeeEducationView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      if (before.status === "ended") return rowToView(before);
      const result = await client.query("UPDATE employee_education SET status = 'ended', updated_at = now() WHERE id = $1 RETURNING *", [
        id,
      ]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "employee_education.end", target: id });
      return rowToView(result.rows[0]);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async mustExist(client: PoolClient, id: string): Promise<any> {
    const result = await client.query("SELECT * FROM employee_education WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundException("Employee education entry not found");
    return result.rows[0];
  }

  private async mustExistEmployee(client: PoolClient, companyId: string, employeeId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM employees WHERE id = $1 AND company_id = $2", [employeeId, companyId]);
    if (result.rowCount === 0) throw new NotFoundException("Employee not found");
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage employee education records");
    }
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const [canView, canManage] = await Promise.all([this.rbac.can(claims, VIEW_PERMISSION), this.rbac.can(claims, MANAGE_PERMISSION)]);
    if (!canView && !canManage) {
      throw new ForbiddenException("Not permitted to view employee education records");
    }
  }
}
