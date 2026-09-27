import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type { CreateEmployeeAssetRequest, EmployeeAssetView, UpdateEmployeeAssetRequest } from "@aihxm/shared-types";

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
function rowToView(row: any): EmployeeAssetView {
  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    assetType: row.asset_type,
    assetTag: row.asset_tag,
    description: row.description,
    assignedDate: toDateStr(row.assigned_date) as string,
    returnedDate: toDateStr(row.returned_date),
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Core Employee Enterprise, Phase 9
 * (0087_core_employee_family_education_qualifications_assets.sql) — the
 * Assets card's real sub-entity. See EmployeeFamilyMembersService's own
 * doc comment for the shared design rationale (a pure list — an employee
 * normally holds several assets at once). UNLIKE the other three Phase 9
 * sub-entities, this one has a real two-state lifecycle on the row itself
 * (`assigned` -> `returned`, via `returnAsset()`) rather than a generic
 * `end()` that just retires the row — an asset handed back is a fact
 * worth recording with its own date, not merely "no longer relevant."
 */
@Injectable()
export class EmployeeAssetsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async create(claims: RequestClaims, input: CreateEmployeeAssetRequest): Promise<EmployeeAssetView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, (client) => this.createWithinTransaction(client, claims, input));
  }

  async createWithinTransaction(client: PoolClient, claims: RequestClaims, input: CreateEmployeeAssetRequest): Promise<EmployeeAssetView> {
    await this.mustExistEmployee(client, claims.company_id!, input.employeeId);

    const inserted = await client.query(
      `INSERT INTO employee_assets (company_id, employee_id, asset_type, asset_tag, description, assigned_date)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE)) RETURNING *`,
      [claims.company_id, input.employeeId, input.assetType, input.assetTag ?? null, input.description ?? null, input.assignedDate ?? null]
    );
    const view = rowToView(inserted.rows[0]);

    await this.audit.record(client, claims, {
      companyId: claims.company_id ?? null,
      action: "employee_asset.create",
      target: view.id,
      metadata: { employeeId: input.employeeId, assetType: input.assetType },
    });

    return view;
  }

  async list(claims: RequestClaims, employeeId: string): Promise<EmployeeAssetView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "SELECT * FROM employee_assets WHERE employee_id = $1 ORDER BY assigned_date DESC, created_at DESC",
        [employeeId]
      );
      return result.rows.map(rowToView);
    });
  }

  async update(claims: RequestClaims, id: string, patch: UpdateEmployeeAssetRequest): Promise<EmployeeAssetView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      const result = await client.query(
        `UPDATE employee_assets SET asset_tag = COALESCE($2, asset_tag), description = COALESCE($3, description), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, patch.assetTag ?? null, patch.description ?? null]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_asset.update",
        target: id,
        metadata: { before: rowToView(before), after: rowToView(result.rows[0]) },
      });
      return rowToView(result.rows[0]);
    });
  }

  /** Marks the asset handed back — a real business event, not a generic `end()` (see this class's own doc comment). Idempotent: returning an already-returned asset is a no-op, matching every other card's own "setStatus is a no-op if already there" posture. */
  async returnAsset(claims: RequestClaims, id: string, returnedDate?: string): Promise<EmployeeAssetView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      if (before.status === "returned") return rowToView(before);
      const result = await client.query(
        "UPDATE employee_assets SET status = 'returned', returned_date = COALESCE($2, CURRENT_DATE), updated_at = now() WHERE id = $1 RETURNING *",
        [id, returnedDate ?? null]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "employee_asset.return", target: id });
      return rowToView(result.rows[0]);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async mustExist(client: PoolClient, id: string): Promise<any> {
    const result = await client.query("SELECT * FROM employee_assets WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundException("Employee asset not found");
    return result.rows[0];
  }

  private async mustExistEmployee(client: PoolClient, companyId: string, employeeId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM employees WHERE id = $1 AND company_id = $2", [employeeId, companyId]);
    if (result.rowCount === 0) throw new NotFoundException("Employee not found");
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage employee assets");
    }
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const [canView, canManage] = await Promise.all([this.rbac.can(claims, VIEW_PERMISSION), this.rbac.can(claims, MANAGE_PERMISSION)]);
    if (!canView && !canManage) {
      throw new ForbiddenException("Not permitted to view employee assets");
    }
  }
}
