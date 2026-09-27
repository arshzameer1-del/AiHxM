import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type {
  CreateEmployeeImportantDateRequest,
  EmployeeImportantDateView,
  UpdateEmployeeImportantDateRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";
const VIEW_PERMISSION = "employee.view";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToView(row: any): EmployeeImportantDateView {
  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    dateType: row.date_type,
    dateValue: row.date_value instanceof Date ? row.date_value.toISOString().slice(0, 10) : row.date_value,
    label: row.label,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Core Employee Enterprise, Phase 7 (0085_core_employee_important_dates.sql)
 * — the Important Dates card's real sub-entity. See
 * EmployeeContactsService's own doc comment for the shared design
 * rationale (flat table, reused employee.* permissions,
 * `createWithinTransaction()` for HiringProcessService.complete()).
 *
 * ONE OPEN ROW PER {employee, dateType}, except `document_expiry` which
 * may have several open rows at once (several documents, each its own
 * expiry) — `create()` only supersedes an existing open row of the same
 * type for the single-fact date types, matching 0085's own partial
 * unique index.
 */
@Injectable()
export class EmployeeImportantDatesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async create(claims: RequestClaims, input: CreateEmployeeImportantDateRequest): Promise<EmployeeImportantDateView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, (client) => this.createWithinTransaction(client, claims, input));
  }

  async createWithinTransaction(
    client: PoolClient,
    claims: RequestClaims,
    input: CreateEmployeeImportantDateRequest
  ): Promise<EmployeeImportantDateView> {
    await this.mustExistEmployee(client, claims.company_id!, input.employeeId);

    if (input.dateType !== "document_expiry") {
      await client.query(
        "UPDATE employee_important_dates SET status = 'ended', updated_at = now() WHERE employee_id = $1 AND date_type = $2 AND status = 'active'",
        [input.employeeId, input.dateType]
      );
    }

    const inserted = await client.query(
      `INSERT INTO employee_important_dates (company_id, employee_id, date_type, date_value, label)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [claims.company_id, input.employeeId, input.dateType, input.dateValue, input.label ?? null]
    );
    const view = rowToView(inserted.rows[0]);

    await this.audit.record(client, claims, {
      companyId: claims.company_id ?? null,
      action: "employee_important_date.create",
      target: view.id,
      metadata: { employeeId: input.employeeId, dateType: input.dateType },
    });

    return view;
  }

  async list(claims: RequestClaims, employeeId: string): Promise<EmployeeImportantDateView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "SELECT * FROM employee_important_dates WHERE employee_id = $1 AND status = 'active' ORDER BY date_type, date_value",
        [employeeId]
      );
      return result.rows.map(rowToView);
    });
  }

  async update(claims: RequestClaims, id: string, patch: UpdateEmployeeImportantDateRequest): Promise<EmployeeImportantDateView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      const result = await client.query(
        `UPDATE employee_important_dates SET date_value = COALESCE($2, date_value), label = COALESCE($3, label), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, patch.dateValue ?? null, patch.label ?? null]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_important_date.update",
        target: id,
        metadata: { before: rowToView(before), after: rowToView(result.rows[0]) },
      });
      return rowToView(result.rows[0]);
    });
  }

  async end(claims: RequestClaims, id: string): Promise<EmployeeImportantDateView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      if (before.status === "ended") return rowToView(before);
      const result = await client.query(
        "UPDATE employee_important_dates SET status = 'ended', updated_at = now() WHERE id = $1 RETURNING *",
        [id]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "employee_important_date.end", target: id });
      return rowToView(result.rows[0]);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async mustExist(client: PoolClient, id: string): Promise<any> {
    const result = await client.query("SELECT * FROM employee_important_dates WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundException("Employee important date not found");
    return result.rows[0];
  }

  private async mustExistEmployee(client: PoolClient, companyId: string, employeeId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM employees WHERE id = $1 AND company_id = $2", [employeeId, companyId]);
    if (result.rowCount === 0) throw new NotFoundException("Employee not found");
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage employee important dates");
    }
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const [canView, canManage] = await Promise.all([this.rbac.can(claims, VIEW_PERMISSION), this.rbac.can(claims, MANAGE_PERMISSION)]);
    if (!canView && !canManage) {
      throw new ForbiddenException("Not permitted to view employee important dates");
    }
  }
}
