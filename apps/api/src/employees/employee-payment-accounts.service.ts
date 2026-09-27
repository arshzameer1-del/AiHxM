import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type {
  CreateEmployeePaymentAccountRequest,
  EmployeePaymentAccountView,
  UpdateEmployeePaymentAccountRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";
const VIEW_PERMISSION = "employee.view";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToView(row: any): EmployeePaymentAccountView {
  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    paymentMethod: row.payment_method,
    bankName: row.bank_name,
    accountTitle: row.account_title,
    accountNumber: row.account_number,
    iban: row.iban,
    branchCode: row.branch_code,
    isPrimary: row.is_primary,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Core Employee Enterprise, Phase 8
 * (0086_core_employee_payment_cost_allocation.sql) — the Payment/Bank
 * card's real sub-entity. See EmployeeContactsService's own doc comment
 * for the shared design rationale (flat table, reused employee.*
 * permissions, `createWithinTransaction()` for
 * HiringProcessService.complete()). `create()` demotes any existing
 * primary before inserting a new primary row, the same
 * "at most one primary" shape `employee_contacts` already established,
 * kept in sync with 0086's own partial unique index.
 */
@Injectable()
export class EmployeePaymentAccountsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async create(claims: RequestClaims, input: CreateEmployeePaymentAccountRequest): Promise<EmployeePaymentAccountView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, (client) => this.createWithinTransaction(client, claims, input));
  }

  async createWithinTransaction(
    client: PoolClient,
    claims: RequestClaims,
    input: CreateEmployeePaymentAccountRequest
  ): Promise<EmployeePaymentAccountView> {
    await this.mustExistEmployee(client, claims.company_id!, input.employeeId);

    if (input.isPrimary) {
      await client.query(
        "UPDATE employee_payment_accounts SET is_primary = false, updated_at = now() WHERE employee_id = $1 AND status = 'active'",
        [input.employeeId]
      );
    }

    const inserted = await client.query(
      `INSERT INTO employee_payment_accounts
         (company_id, employee_id, payment_method, bank_name, account_title, account_number, iban, branch_code, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        claims.company_id,
        input.employeeId,
        input.paymentMethod,
        input.bankName ?? null,
        input.accountTitle ?? null,
        input.accountNumber ?? null,
        input.iban ?? null,
        input.branchCode ?? null,
        input.isPrimary ?? false,
      ]
    );
    const view = rowToView(inserted.rows[0]);

    await this.audit.record(client, claims, {
      companyId: claims.company_id ?? null,
      action: "employee_payment_account.create",
      target: view.id,
      metadata: { employeeId: input.employeeId, paymentMethod: input.paymentMethod },
    });

    return view;
  }

  async list(claims: RequestClaims, employeeId: string): Promise<EmployeePaymentAccountView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "SELECT * FROM employee_payment_accounts WHERE employee_id = $1 AND status = 'active' ORDER BY created_at",
        [employeeId]
      );
      return result.rows.map(rowToView);
    });
  }

  async update(claims: RequestClaims, id: string, patch: UpdateEmployeePaymentAccountRequest): Promise<EmployeePaymentAccountView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);

      if (patch.isPrimary) {
        await client.query(
          "UPDATE employee_payment_accounts SET is_primary = false, updated_at = now() WHERE employee_id = $1 AND status = 'active' AND id <> $2",
          [before.employee_id, id]
        );
      }

      const result = await client.query(
        `UPDATE employee_payment_accounts SET
           payment_method = COALESCE($2, payment_method),
           bank_name = COALESCE($3, bank_name),
           account_title = COALESCE($4, account_title),
           account_number = COALESCE($5, account_number),
           iban = COALESCE($6, iban),
           branch_code = COALESCE($7, branch_code),
           is_primary = COALESCE($8, is_primary),
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          id,
          patch.paymentMethod ?? null,
          patch.bankName ?? null,
          patch.accountTitle ?? null,
          patch.accountNumber ?? null,
          patch.iban ?? null,
          patch.branchCode ?? null,
          patch.isPrimary ?? null,
        ]
      );

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_payment_account.update",
        target: id,
        metadata: { before: rowToView(before), after: rowToView(result.rows[0]) },
      });

      return rowToView(result.rows[0]);
    });
  }

  async end(claims: RequestClaims, id: string): Promise<EmployeePaymentAccountView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      if (before.status === "ended") return rowToView(before);
      const result = await client.query(
        "UPDATE employee_payment_accounts SET status = 'ended', is_primary = false, updated_at = now() WHERE id = $1 RETURNING *",
        [id]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "employee_payment_account.end", target: id });
      return rowToView(result.rows[0]);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async mustExist(client: PoolClient, id: string): Promise<any> {
    const result = await client.query("SELECT * FROM employee_payment_accounts WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundException("Employee payment account not found");
    return result.rows[0];
  }

  private async mustExistEmployee(client: PoolClient, companyId: string, employeeId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM employees WHERE id = $1 AND company_id = $2", [employeeId, companyId]);
    if (result.rowCount === 0) throw new NotFoundException("Employee not found");
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage employee payment accounts");
    }
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const [canView, canManage] = await Promise.all([this.rbac.can(claims, VIEW_PERMISSION), this.rbac.can(claims, MANAGE_PERMISSION)]);
    if (!canView && !canManage) {
      throw new ForbiddenException("Not permitted to view employee payment accounts");
    }
  }
}
