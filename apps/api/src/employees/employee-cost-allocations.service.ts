import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type {
  CreateEmployeeCostAllocationRequest,
  EmployeeCostAllocationView,
  UpdateEmployeeCostAllocationRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";
const VIEW_PERMISSION = "employee.view";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToView(row: any): EmployeeCostAllocationView {
  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    costCenterId: row.cost_center_id,
    allocationPercentage: Number(row.allocation_percentage),
    isPrimary: row.is_primary,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Core Employee Enterprise, Phase 8
 * (0086_core_employee_payment_cost_allocation.sql) — the Cost Allocation
 * card's real sub-entity: split costing across Organization Management's
 * existing `cost_centers` (reused via a plain existence-check query, the
 * same "reach across a table boundary via plain SQL" precedent
 * PositionsService/OrgRelationshipsService/the Phase 5 assignment
 * validator all already use, rather than a new DI edge into
 * OrganizationModule — see hiring-process.service.ts's own comment on why
 * that module is not imported here).
 *
 * UNLIKE every other Phase 6/7/8 sub-entity, MULTIPLE open rows per
 * employee are normal (split costing across several cost centers at
 * once) — `create()` only enforces that the sum of every open
 * allocation's percentage for this employee never exceeds 100, the one
 * real business rule this card needs; it does not force the sum to
 * exactly 100 at any single point in time, since a caller building up a
 * split allocation one row at a time legitimately passes through
 * intermediate states below 100.
 */
@Injectable()
export class EmployeeCostAllocationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async create(claims: RequestClaims, input: CreateEmployeeCostAllocationRequest): Promise<EmployeeCostAllocationView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, (client) => this.createWithinTransaction(client, claims, input));
  }

  async createWithinTransaction(
    client: PoolClient,
    claims: RequestClaims,
    input: CreateEmployeeCostAllocationRequest
  ): Promise<EmployeeCostAllocationView> {
    await this.mustExistEmployee(client, claims.company_id!, input.employeeId);
    await this.mustExistCostCenter(client, claims.company_id!, input.costCenterId);

    if (input.allocationPercentage <= 0 || input.allocationPercentage > 100) {
      throw new BadRequestException("Allocation percentage must be between 0 and 100");
    }

    const existingTotal = await client.query(
      "SELECT COALESCE(SUM(allocation_percentage), 0) AS total FROM employee_cost_allocations WHERE employee_id = $1 AND status = 'active'",
      [input.employeeId]
    );
    const currentTotal = Number(existingTotal.rows[0].total);
    if (currentTotal + input.allocationPercentage > 100) {
      throw new BadRequestException(
        `Total cost allocation for this employee would exceed 100% (currently ${currentTotal}%, adding ${input.allocationPercentage}%)`
      );
    }

    if (input.isPrimary) {
      await client.query(
        "UPDATE employee_cost_allocations SET is_primary = false, updated_at = now() WHERE employee_id = $1 AND status = 'active'",
        [input.employeeId]
      );
    }

    const inserted = await client.query(
      `INSERT INTO employee_cost_allocations (company_id, employee_id, cost_center_id, allocation_percentage, is_primary)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [claims.company_id, input.employeeId, input.costCenterId, input.allocationPercentage, input.isPrimary ?? false]
    );
    const view = rowToView(inserted.rows[0]);

    await this.audit.record(client, claims, {
      companyId: claims.company_id ?? null,
      action: "employee_cost_allocation.create",
      target: view.id,
      metadata: { employeeId: input.employeeId, costCenterId: input.costCenterId, allocationPercentage: input.allocationPercentage },
    });

    return view;
  }

  async list(claims: RequestClaims, employeeId: string): Promise<EmployeeCostAllocationView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "SELECT * FROM employee_cost_allocations WHERE employee_id = $1 AND status = 'active' ORDER BY created_at",
        [employeeId]
      );
      return result.rows.map(rowToView);
    });
  }

  async update(claims: RequestClaims, id: string, patch: UpdateEmployeeCostAllocationRequest): Promise<EmployeeCostAllocationView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);

      if (patch.allocationPercentage !== undefined) {
        const othersTotal = await client.query(
          "SELECT COALESCE(SUM(allocation_percentage), 0) AS total FROM employee_cost_allocations WHERE employee_id = $1 AND status = 'active' AND id <> $2",
          [before.employee_id, id]
        );
        const total = Number(othersTotal.rows[0].total) + patch.allocationPercentage;
        if (total > 100) {
          throw new BadRequestException(`Total cost allocation for this employee would exceed 100% (would be ${total}%)`);
        }
      }

      if (patch.isPrimary) {
        await client.query(
          "UPDATE employee_cost_allocations SET is_primary = false, updated_at = now() WHERE employee_id = $1 AND status = 'active' AND id <> $2",
          [before.employee_id, id]
        );
      }

      const result = await client.query(
        `UPDATE employee_cost_allocations SET
           allocation_percentage = COALESCE($2, allocation_percentage),
           is_primary = COALESCE($3, is_primary),
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, patch.allocationPercentage ?? null, patch.isPrimary ?? null]
      );

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_cost_allocation.update",
        target: id,
        metadata: { before: rowToView(before), after: rowToView(result.rows[0]) },
      });

      return rowToView(result.rows[0]);
    });
  }

  async end(claims: RequestClaims, id: string): Promise<EmployeeCostAllocationView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      if (before.status === "ended") return rowToView(before);
      const result = await client.query(
        "UPDATE employee_cost_allocations SET status = 'ended', is_primary = false, updated_at = now() WHERE id = $1 RETURNING *",
        [id]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "employee_cost_allocation.end", target: id });
      return rowToView(result.rows[0]);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async mustExist(client: PoolClient, id: string): Promise<any> {
    const result = await client.query("SELECT * FROM employee_cost_allocations WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundException("Employee cost allocation not found");
    return result.rows[0];
  }

  private async mustExistEmployee(client: PoolClient, companyId: string, employeeId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM employees WHERE id = $1 AND company_id = $2", [employeeId, companyId]);
    if (result.rowCount === 0) throw new NotFoundException("Employee not found");
  }

  private async mustExistCostCenter(client: PoolClient, companyId: string, costCenterId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM cost_centers WHERE id = $1 AND company_id = $2 AND status = 'active'", [
      costCenterId,
      companyId,
    ]);
    if (result.rowCount === 0) throw new NotFoundException("Cost center not found or archived");
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage employee cost allocations");
    }
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const [canView, canManage] = await Promise.all([this.rbac.can(claims, VIEW_PERMISSION), this.rbac.can(claims, MANAGE_PERMISSION)]);
    if (!canView && !canManage) {
      throw new ForbiddenException("Not permitted to view employee cost allocations");
    }
  }
}
