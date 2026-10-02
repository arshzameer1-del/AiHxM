import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { scopeEntityExists } from "../rbac/data-scope-assignments.service";
import { isPayrollAreaInScope, resolvePayrollAreaAccess, type PayrollAreaAccess } from "./payroll-area-access";
import type {
  AddPayrollAreaScopeLinkRequest,
  AssignEmployeePayrollAreaRequest,
  CreatePayrollAreaRequest,
  PayrollAreaScopeLinkView,
  PayrollAreaView,
  UpdatePayrollAreaRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "payroll" as const;
const MANAGE_PERMISSION_BASE = "payroll_area.manage";
// Anyone who can act on payroll runs needs to see the areas they can pick
// from (a preparer choosing which area to create a run for, an approver
// reading which area a run covers) — same "any payroll-staff permission
// can read" rule PayrollService.listRuns() already applies to runs.
const VIEW_PERMISSION_BASES = [
  MANAGE_PERMISSION_BASE,
  "payroll.calculate",
  "payroll.finalize",
  "payroll.disburse",
  "payroll.approve",
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToLink(row: any): PayrollAreaScopeLinkView {
  return {
    id: row.id,
    payrollAreaId: row.payroll_area_id,
    scopeType: row.scope_type,
    scopeEntityId: row.scope_entity_id,
    createdAt: toIso(row.created_at),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToArea(row: any, links: PayrollAreaScopeLinkView[]): PayrollAreaView {
  return {
    id: row.id,
    companyId: row.company_id,
    code: row.code,
    name: row.name,
    description: row.description ?? null,
    isActive: row.is_active,
    employeeCount: Number(row.employee_count ?? 0),
    scopeLinks: links,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Payroll Areas (0101_payroll_areas.sql) — the SAP HCM "Payroll Area"
 * equivalent: a named grouping of employees processed together in one
 * payroll run. Layered exactly like every other tenant service
 * (entitlement -> RBAC -> business logic -> audit, RLS underneath).
 *
 * Permission split (0102_payroll_area_permissions_seed.sql):
 *  - `payroll_area.manage.all` — everything: create, update, deactivate,
 *    add/remove scope links, assign any employee.
 *  - `payroll_area.manage.scoped` — only areas inside the caller's own
 *    data scope (see `resolveScopedPayrollAreaIds()`): view, update
 *    name/description/active, and move employees BETWEEN in-scope areas.
 *    Deliberately NOT create or scope-link management: an area's scope
 *    links are what DEFINE whether it is in a scoped caller's scope, so
 *    letting that caller edit them would let them widen their own reach.
 *    A brand-new area has no links, so a scoped caller couldn't see it
 *    anyway.
 *
 * `employees.payroll_area_id` is written ONLY by `assignEmployee()` here —
 * the same "owning domain reaches across the table boundary via plain SQL"
 * precedent PositionsService set for `employees.position_id` (no
 * EmployeesService dependency, and EmployeesService gets none on this).
 */
@Injectable()
export class PayrollAreasService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  /** Every area the caller can see — all of them for a `.all` holder (or
   * any payroll-staff `.all` permission), only in-scope ones otherwise. */
  async list(claims: RequestClaims, opts: { includeInactive?: boolean } = {}): Promise<PayrollAreaView[]> {
    const access = await this.resolveAccess(claims, VIEW_PERMISSION_BASES, "Not permitted to view payroll areas");
    return this.db.withClaims(claims, async (client) => {
      const conditions = ["pa.company_id = $1"];
      const values: unknown[] = [claims.company_id];
      if (!opts.includeInactive) conditions.push("pa.is_active");
      if (!access.unrestricted) {
        values.push(access.payrollAreaIds);
        conditions.push(`pa.id = ANY($${values.length}::uuid[])`);
      }
      const result = await client.query(
        `SELECT pa.*, (SELECT COUNT(*) FROM employees e WHERE e.payroll_area_id = pa.id) AS employee_count
         FROM payroll_areas pa WHERE ${conditions.join(" AND ")} ORDER BY pa.code`,
        values
      );
      const links = await this.loadLinks(client, result.rows.map((r) => r.id));
      return result.rows.map((row) => rowToArea(row, links.get(row.id) ?? []));
    });
  }

  async get(claims: RequestClaims, id: string): Promise<PayrollAreaView> {
    const access = await this.resolveAccess(claims, VIEW_PERMISSION_BASES, "Not permitted to view payroll areas");
    return this.db.withClaims(claims, async (client) => {
      // Out of scope reads as "not found", never "forbidden" — the same
      // convention Organization's scoped get() endpoints use.
      if (!isPayrollAreaInScope(access, id)) throw new NotFoundException("Payroll area not found");
      return this.loadView(client, id);
    });
  }

  async create(claims: RequestClaims, input: CreatePayrollAreaRequest): Promise<PayrollAreaView> {
    await this.requireManageAll(claims);
    const code = input.code?.trim();
    const name = input.name?.trim();
    if (!code) throw new BadRequestException("code is required");
    if (!name) throw new BadRequestException("name is required");
    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query("SELECT 1 FROM payroll_areas WHERE company_id = $1 AND code = $2", [
        claims.company_id,
        code,
      ]);
      if ((existing.rowCount ?? 0) > 0) {
        throw new ConflictException(`A payroll area with code "${code}" already exists`);
      }
      const result = await client.query(
        `INSERT INTO payroll_areas (company_id, code, name, description) VALUES ($1, $2, $3, $4) RETURNING id`,
        [claims.company_id, code, name, input.description?.trim() || null]
      );
      const id = result.rows[0].id as string;
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_area.create",
        target: id,
        metadata: { code, name },
      });
      return this.loadView(client, id);
    });
  }

  async update(claims: RequestClaims, id: string, patch: UpdatePayrollAreaRequest): Promise<PayrollAreaView> {
    const access = await this.resolveAccess(claims, [MANAGE_PERMISSION_BASE], "Not permitted to manage payroll areas");
    if (patch.name !== undefined && !patch.name.trim()) throw new BadRequestException("name cannot be blank");
    return this.db.withClaims(claims, async (client) => {
      await this.mustExist(client, id);
      if (!isPayrollAreaInScope(access, id)) {
        throw new ForbiddenException("This payroll area is outside your data scope");
      }
      await client.query(
        `UPDATE payroll_areas SET
           name = COALESCE($2, name),
           description = CASE WHEN $3::boolean THEN $4 ELSE description END,
           is_active = COALESCE($5, is_active),
           updated_at = now()
         WHERE id = $1`,
        [
          id,
          patch.name?.trim() ?? null,
          patch.description !== undefined,
          patch.description?.trim() || null,
          patch.isActive ?? null,
        ]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: patch.isActive === false ? "payroll_area.deactivate" : "payroll_area.update",
        target: id,
        metadata: { ...patch },
      });
      return this.loadView(client, id);
    });
  }

  /** Never a hard delete — existing payroll runs keep pointing at the
   * area. A deactivated area can't get new runs or new employees
   * (`PayrollService.createRun()` / `assignEmployee()` refuse it); its
   * current employees keep it until reassigned. */
  async deactivate(claims: RequestClaims, id: string): Promise<PayrollAreaView> {
    return this.update(claims, id, { isActive: false });
  }

  async addScopeLink(claims: RequestClaims, id: string, input: AddPayrollAreaScopeLinkRequest): Promise<PayrollAreaView> {
    await this.requireManageAll(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustExist(client, id);
      if (!(await scopeEntityExists(client, input.scopeType, input.scopeEntityId, claims.company_id!))) {
        throw new NotFoundException(`No ${input.scopeType.replace("_", " ")} with that id in this company`);
      }
      const existing = await client.query(
        "SELECT 1 FROM payroll_area_scope_links WHERE payroll_area_id = $1 AND scope_type = $2 AND scope_entity_id = $3",
        [id, input.scopeType, input.scopeEntityId]
      );
      if ((existing.rowCount ?? 0) > 0) {
        throw new ConflictException("This payroll area is already linked to that scope entity");
      }
      await client.query(
        `INSERT INTO payroll_area_scope_links (company_id, payroll_area_id, scope_type, scope_entity_id) VALUES ($1, $2, $3, $4)`,
        [claims.company_id, id, input.scopeType, input.scopeEntityId]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_area.scope_link_add",
        target: id,
        metadata: { scopeType: input.scopeType, scopeEntityId: input.scopeEntityId },
      });
      return this.loadView(client, id);
    });
  }

  async removeScopeLink(claims: RequestClaims, id: string, linkId: string): Promise<PayrollAreaView> {
    await this.requireManageAll(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustExist(client, id);
      const removed = await client.query(
        "DELETE FROM payroll_area_scope_links WHERE id = $1 AND payroll_area_id = $2 RETURNING scope_type, scope_entity_id",
        [linkId, id]
      );
      if (removed.rowCount === 0) throw new NotFoundException("Scope link not found on this payroll area");
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_area.scope_link_remove",
        target: id,
        metadata: { scopeType: removed.rows[0].scope_type, scopeEntityId: removed.rows[0].scope_entity_id },
      });
      return this.loadView(client, id);
    });
  }

  /**
   * Sets (or, with `payrollAreaId: null`, clears) `employees.payroll_area_id`.
   * A `.scoped` caller must have BOTH ends in scope: the employee's
   * current area (an employee with no area yet is company-wide, so out
   * of every scoped caller's reach — initial placement needs `.all`) and
   * the target area. Otherwise a regional admin could pull employees out
   * of another region's payroll, or push them into it.
   */
  async assignEmployee(claims: RequestClaims, input: AssignEmployeePayrollAreaRequest): Promise<{ employeeId: string; payrollAreaId: string | null }> {
    const access = await this.resolveAccess(claims, [MANAGE_PERMISSION_BASE], "Not permitted to manage payroll areas");
    return this.db.withClaims(claims, async (client) => {
      const employee = await client.query<{ payroll_area_id: string | null }>(
        "SELECT payroll_area_id FROM employees WHERE id = $1 AND company_id = $2",
        [input.employeeId, claims.company_id]
      );
      if (employee.rowCount === 0) throw new NotFoundException("Employee not found");
      const currentAreaId = employee.rows[0].payroll_area_id;

      if (input.payrollAreaId) {
        const target = await this.mustExist(client, input.payrollAreaId);
        if (!target.is_active) throw new BadRequestException("Cannot assign employees to an inactive payroll area");
      }
      if (!access.unrestricted) {
        if (!isPayrollAreaInScope(access, currentAreaId) || !isPayrollAreaInScope(access, input.payrollAreaId)) {
          throw new ForbiddenException("Both the employee's current and target payroll area must be inside your data scope");
        }
      }

      await client.query("UPDATE employees SET payroll_area_id = $2, updated_at = now() WHERE id = $1", [
        input.employeeId,
        input.payrollAreaId,
      ]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_area.employee_assign",
        target: input.employeeId,
        metadata: { fromPayrollAreaId: currentAreaId, toPayrollAreaId: input.payrollAreaId },
      });
      return { employeeId: input.employeeId, payrollAreaId: input.payrollAreaId };
    });
  }

  // --- Internals -------------------------------------------------------

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
  }

  private async requireManageAll(claims: RequestClaims): Promise<void> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, `${MANAGE_PERMISSION_BASE}.all`))) {
      throw new ForbiddenException("Not permitted to create payroll areas or change their data scope links");
    }
  }

  private async resolveAccess(
    claims: RequestClaims,
    bases: readonly string[],
    forbiddenMessage: string
  ): Promise<PayrollAreaAccess> {
    await this.requireModule(claims);
    const access = await resolvePayrollAreaAccess(this.db, this.rbac, claims, bases);
    if (!access) throw new ForbiddenException(forbiddenMessage);
    return access;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async mustExist(client: PoolClient, id: string): Promise<any> {
    const result = await client.query("SELECT * FROM payroll_areas WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundException("Payroll area not found");
    return result.rows[0];
  }

  private async loadView(client: PoolClient, id: string): Promise<PayrollAreaView> {
    const result = await client.query(
      `SELECT pa.*, (SELECT COUNT(*) FROM employees e WHERE e.payroll_area_id = pa.id) AS employee_count
       FROM payroll_areas pa WHERE pa.id = $1`,
      [id]
    );
    if (result.rowCount === 0) throw new NotFoundException("Payroll area not found");
    const links = await this.loadLinks(client, [id]);
    return rowToArea(result.rows[0], links.get(id) ?? []);
  }

  private async loadLinks(client: PoolClient, areaIds: string[]): Promise<Map<string, PayrollAreaScopeLinkView[]>> {
    const byArea = new Map<string, PayrollAreaScopeLinkView[]>();
    if (areaIds.length === 0) return byArea;
    const result = await client.query(
      "SELECT * FROM payroll_area_scope_links WHERE payroll_area_id = ANY($1::uuid[]) ORDER BY created_at",
      [areaIds]
    );
    for (const row of result.rows) {
      const list = byArea.get(row.payroll_area_id) ?? [];
      list.push(rowToLink(row));
      byArea.set(row.payroll_area_id, list);
    }
    return byArea;
  }
}
