import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type { CreateEmployeeAddressRequest, EmployeeAddressView, UpdateEmployeeAddressRequest } from "@aihxm/shared-types";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";
const VIEW_PERMISSION = "employee.view";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToView(row: any): EmployeeAddressView {
  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    addressType: row.address_type,
    line1: row.line1,
    line2: row.line2,
    city: row.city,
    stateProvince: row.state_province,
    postalCode: row.postal_code,
    country: row.country,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Core Employee Enterprise, Phase 6 (0084_core_employee_contact_address.sql)
 * — the Addresses card's real sub-entity. See EmployeeContactsService's
 * own doc comment for the shared design rationale (flat table, reused
 * employee.* permissions, `createWithinTransaction()` for
 * HiringProcessService.complete()).
 *
 * ONE OPEN ROW PER {employee, addressType}: `create()` replaces (ends)
 * any existing open row of the same type before inserting the new one —
 * "Permanent"/"Current"/"Mailing" are each a single current fact, not a
 * list, matching 0084's own partial unique index and Section 6's card
 * description. Calling `create()` again for the same type is therefore
 * how a caller CHANGES an address, not an error — the DB's own unique
 * index is the belt-and-braces backstop if this pre-check is ever
 * bypassed.
 */
@Injectable()
export class EmployeeAddressesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async create(claims: RequestClaims, input: CreateEmployeeAddressRequest): Promise<EmployeeAddressView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, (client) => this.createWithinTransaction(client, claims, input));
  }

  async createWithinTransaction(
    client: PoolClient,
    claims: RequestClaims,
    input: CreateEmployeeAddressRequest
  ): Promise<EmployeeAddressView> {
    await this.mustExistEmployee(client, claims.company_id!, input.employeeId);

    await client.query(
      "UPDATE employee_addresses SET status = 'ended', updated_at = now() WHERE employee_id = $1 AND address_type = $2 AND status = 'active'",
      [input.employeeId, input.addressType]
    );

    const inserted = await client.query(
      `INSERT INTO employee_addresses (company_id, employee_id, address_type, line1, line2, city, state_province, postal_code, country)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        claims.company_id,
        input.employeeId,
        input.addressType,
        input.line1,
        input.line2 ?? null,
        input.city ?? null,
        input.stateProvince ?? null,
        input.postalCode ?? null,
        input.country ?? null,
      ]
    );
    const view = rowToView(inserted.rows[0]);

    await this.audit.record(client, claims, {
      companyId: claims.company_id ?? null,
      action: "employee_address.create",
      target: view.id,
      metadata: { employeeId: input.employeeId, addressType: input.addressType },
    });

    return view;
  }

  async list(claims: RequestClaims, employeeId: string): Promise<EmployeeAddressView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "SELECT * FROM employee_addresses WHERE employee_id = $1 AND status = 'active' ORDER BY address_type",
        [employeeId]
      );
      return result.rows.map(rowToView);
    });
  }

  async update(claims: RequestClaims, id: string, patch: UpdateEmployeeAddressRequest): Promise<EmployeeAddressView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      const result = await client.query(
        `UPDATE employee_addresses SET
           line1 = COALESCE($2, line1),
           line2 = COALESCE($3, line2),
           city = COALESCE($4, city),
           state_province = COALESCE($5, state_province),
           postal_code = COALESCE($6, postal_code),
           country = COALESCE($7, country),
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, patch.line1 ?? null, patch.line2 ?? null, patch.city ?? null, patch.stateProvince ?? null, patch.postalCode ?? null, patch.country ?? null]
      );

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_address.update",
        target: id,
        metadata: { before: rowToView(before), after: rowToView(result.rows[0]) },
      });

      return rowToView(result.rows[0]);
    });
  }

  async end(claims: RequestClaims, id: string): Promise<EmployeeAddressView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      if (before.status === "ended") return rowToView(before);
      const result = await client.query("UPDATE employee_addresses SET status = 'ended', updated_at = now() WHERE id = $1 RETURNING *", [
        id,
      ]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "employee_address.end", target: id });
      return rowToView(result.rows[0]);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async mustExist(client: PoolClient, id: string): Promise<any> {
    const result = await client.query("SELECT * FROM employee_addresses WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundException("Employee address not found");
    return result.rows[0];
  }

  private async mustExistEmployee(client: PoolClient, companyId: string, employeeId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM employees WHERE id = $1 AND company_id = $2", [employeeId, companyId]);
    if (result.rowCount === 0) throw new NotFoundException("Employee not found");
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage employee addresses");
    }
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const [canView, canManage] = await Promise.all([this.rbac.can(claims, VIEW_PERMISSION), this.rbac.can(claims, MANAGE_PERMISSION)]);
    if (!canView && !canManage) {
      throw new ForbiddenException("Not permitted to view employee addresses");
    }
  }
}
