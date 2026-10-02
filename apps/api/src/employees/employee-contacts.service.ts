import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { HrReferenceCatalogService } from "../hr-administration/hr-reference-catalog.service";
import type { CreateEmployeeContactRequest, EmployeeContactView, UpdateEmployeeContactRequest } from "@aihxm/shared-types";

// Reuses the employee record's own permission keys rather than inventing
// new ones — a contact method is a sub-fact of the employee record, the
// same "smallest appropriate change" call 0084's own header comment
// documents for not building a dedicated permission set here.
const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";
const VIEW_PERMISSION = "employee.view";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToView(row: any): EmployeeContactView {
  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    contactType: row.contact_type,
    label: row.label,
    value: row.value,
    isPrimary: row.is_primary,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Core Employee Enterprise, Phase 6 (0084_core_employee_contact_address.sql)
 * — the Contact card's real sub-entity. Plain CRUD over a flat,
 * non-effective-dated table (see that migration's own header comment for
 * why no version history), gated by the employee record's own
 * `employee.manage.all`/`employee.view` permissions rather than a new
 * permission pair.
 *
 * `createWithinTransaction()` exists for exactly the reason
 * EmployeesService's own method of the same name does (see that class's
 * doc comment): HiringProcessService.complete() calls it once per contact
 * entry captured on the `contact` card, inside the SAME transaction that
 * creates the employee and marks the hire process 'hired' — so a hire
 * that fails partway never leaves an orphaned contact row pointing at an
 * employee that was rolled back.
 */
@Injectable()
export class EmployeeContactsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly hrCatalog: HrReferenceCatalogService
  ) {}

  async create(claims: RequestClaims, input: CreateEmployeeContactRequest): Promise<EmployeeContactView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, (client) => this.createWithinTransaction(client, claims, input));
  }

  async createWithinTransaction(
    client: PoolClient,
    claims: RequestClaims,
    input: CreateEmployeeContactRequest
  ): Promise<EmployeeContactView> {
    await this.mustExistEmployee(client, claims.company_id!, input.employeeId);
    // HR Administration v2 "then 2" Phase 1 (2026-10-01) — `contactType`
    // used to be a hardcoded CHECK constraint; this tenant's own
    // `contact_type` catalog is now the source of truth. Only checked on
    // create — contactType is immutable after creation (see
    // UpdateEmployeeContactRequest's own Omit).
    await this.hrCatalog.validateActiveCode(client, claims.company_id!, "contact_type", input.contactType);

    if (input.isPrimary) {
      await client.query(
        "UPDATE employee_contacts SET is_primary = false, updated_at = now() WHERE employee_id = $1 AND contact_type = $2 AND status = 'active'",
        [input.employeeId, input.contactType]
      );
    }

    const inserted = await client.query(
      `INSERT INTO employee_contacts (company_id, employee_id, contact_type, label, value, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [claims.company_id, input.employeeId, input.contactType, input.label ?? null, input.value, input.isPrimary ?? false]
    );
    const view = rowToView(inserted.rows[0]);

    await this.audit.record(client, claims, {
      companyId: claims.company_id ?? null,
      action: "employee_contact.create",
      target: view.id,
      metadata: { employeeId: input.employeeId, contactType: input.contactType },
    });

    return view;
  }

  async list(claims: RequestClaims, employeeId: string): Promise<EmployeeContactView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "SELECT * FROM employee_contacts WHERE employee_id = $1 AND status = 'active' ORDER BY created_at",
        [employeeId]
      );
      return result.rows.map(rowToView);
    });
  }

  async update(claims: RequestClaims, id: string, patch: UpdateEmployeeContactRequest): Promise<EmployeeContactView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);

      if (patch.isPrimary) {
        await client.query(
          "UPDATE employee_contacts SET is_primary = false, updated_at = now() WHERE employee_id = $1 AND contact_type = $2 AND status = 'active' AND id <> $3",
          [before.employee_id, before.contact_type, id]
        );
      }

      const result = await client.query(
        `UPDATE employee_contacts SET
           value = COALESCE($2, value),
           label = COALESCE($3, label),
           is_primary = COALESCE($4, is_primary),
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, patch.value ?? null, patch.label ?? null, patch.isPrimary ?? null]
      );

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_contact.update",
        target: id,
        metadata: { before: rowToView(before), after: rowToView(result.rows[0]) },
      });

      return rowToView(result.rows[0]);
    });
  }

  async end(claims: RequestClaims, id: string): Promise<EmployeeContactView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      if (before.status === "ended") return rowToView(before);
      const result = await client.query(
        "UPDATE employee_contacts SET status = 'ended', is_primary = false, updated_at = now() WHERE id = $1 RETURNING *",
        [id]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "employee_contact.end", target: id });
      return rowToView(result.rows[0]);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async mustExist(client: PoolClient, id: string): Promise<any> {
    const result = await client.query("SELECT * FROM employee_contacts WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundException("Employee contact not found");
    return result.rows[0];
  }

  private async mustExistEmployee(client: PoolClient, companyId: string, employeeId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM employees WHERE id = $1 AND company_id = $2", [employeeId, companyId]);
    if (result.rowCount === 0) throw new NotFoundException("Employee not found");
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage employee contacts");
    }
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const [canView, canManage] = await Promise.all([this.rbac.can(claims, VIEW_PERMISSION), this.rbac.can(claims, MANAGE_PERMISSION)]);
    if (!canView && !canManage) {
      throw new ForbiddenException("Not permitted to view employee contacts");
    }
  }
}
