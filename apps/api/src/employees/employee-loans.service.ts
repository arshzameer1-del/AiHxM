import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type { CancelEmployeeLoanRequest, CreateEmployeeLoanRequest, EmployeeLoanView } from "@aihxm/shared-types";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";
const VIEW_PERMISSION = "employee.view";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

function toIsoDate(value: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v = value as any;
  if (typeof v === "string") return v;
  return v?.toISOString ? v.toISOString().slice(0, 10) : v;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToView(row: any): EmployeeLoanView {
  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    loanType: row.loan_type,
    reason: row.reason,
    principalAmount: Number(row.principal_amount),
    installmentAmount: Number(row.installment_amount),
    outstandingBalance: Number(row.outstanding_balance),
    status: row.status,
    issuedDate: toIsoDate(row.issued_date),
    createdByUserAccountId: row.created_by_user_account_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Payroll Enterprise Gap Analysis Phase P3 (0112_loans_advances_
 * additional_payments.sql) — the SAP IT0045 equivalent: a loan or salary
 * advance issued to an employee, recovered via a fixed per-period
 * installment until paid off. Core-Employee-owned (`employee.manage.all`
 * / `employee.view`, same as every other sub-entity on this profile —
 * not `payroll.manage.all`); `PayrollService` only ever READS this
 * table directly (a plain SQL query, the same "cross-module reads go
 * straight to SQL" rule `employee-compensation.service.ts`'s own class
 * doc comment established) to preview this period's installment at
 * `calculate()` time, and writes to `employee_loan_repayments` /
 * decrements `outstanding_balance` only once a run is FINALIZED (see
 * `PayrollService.finalizeRun()`) — this service itself never touches
 * `outstanding_balance` after creation except via `cancel()`.
 */
@Injectable()
export class EmployeeLoansService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async list(claims: RequestClaims, employeeId: string): Promise<EmployeeLoanView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustExistEmployee(client, claims.company_id!, employeeId);
      const result = await client.query("SELECT * FROM employee_loans WHERE employee_id = $1 ORDER BY issued_date DESC, created_at DESC", [
        employeeId,
      ]);
      return result.rows.map(rowToView);
    });
  }

  async create(claims: RequestClaims, input: CreateEmployeeLoanRequest): Promise<EmployeeLoanView> {
    await this.requireManage(claims);
    if (input.principalAmount <= 0) throw new BadRequestException("principalAmount must be greater than zero");
    if (input.installmentAmount <= 0) throw new BadRequestException("installmentAmount must be greater than zero");
    return this.db.withClaims(claims, async (client) => {
      await this.mustExistEmployee(client, claims.company_id!, input.employeeId);
      const result = await client.query(
        `INSERT INTO employee_loans
           (company_id, employee_id, loan_type, reason, principal_amount, installment_amount, outstanding_balance, issued_date, created_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $5, $7, $8)
         RETURNING *`,
        [
          claims.company_id,
          input.employeeId,
          input.loanType,
          input.reason ?? null,
          input.principalAmount,
          input.installmentAmount,
          input.issuedDate,
          claims.sub,
        ]
      );
      const view = rowToView(result.rows[0]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_loan.create",
        target: view.id,
        metadata: { employeeId: input.employeeId, loanType: input.loanType, principalAmount: input.principalAmount },
      });
      return view;
    });
  }

  async cancel(claims: RequestClaims, id: string, input: CancelEmployeeLoanRequest = {}): Promise<EmployeeLoanView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query("SELECT * FROM employee_loans WHERE id = $1", [id]);
      if (existing.rowCount === 0) throw new NotFoundException("Loan not found");
      const current = existing.rows[0];
      if (current.status !== "active") {
        throw new BadRequestException(`Only an active loan can be cancelled (current status: "${current.status}")`);
      }
      const result = await client.query("UPDATE employee_loans SET status = 'cancelled', updated_at = now() WHERE id = $1 RETURNING *", [
        id,
      ]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_loan.cancel",
        target: id,
        metadata: { reason: input.reason ?? null, outstandingBalanceAtCancellation: Number(current.outstanding_balance) },
      });
      return rowToView(result.rows[0]);
    });
  }

  /**
   * `PayrollService.calculateOnePayslip()`'s own read — every ACTIVE loan
   * an employee has, so it can preview (never mutate) this period's
   * `min(installmentAmount, outstandingBalance)` deduction. Deliberately
   * on the shared transaction client the calculate() call already holds,
   * same as the unpaid-leave/compensation reads it sits beside.
   */
  async listActiveLoansWithinTransaction(client: PoolClient, employeeId: string): Promise<EmployeeLoanView[]> {
    const result = await client.query("SELECT * FROM employee_loans WHERE employee_id = $1 AND status = 'active' ORDER BY issued_date ASC", [
      employeeId,
    ]);
    return result.rows.map(rowToView);
  }

  /**
   * `PayrollService.finalizeRun()`'s own write — records the ledger row
   * and decrements `outstanding_balance`, closing the loan at zero. Never
   * called from `calculate()` (see this service's own class doc comment
   * and `0112_loans_advances_additional_payments.sql`'s header comment
   * for why only finalize commits it). `ON CONFLICT DO NOTHING` on the
   * ledger's `(loan_id, payslip_id)` unique index makes this safe to call
   * at most once per (loan, payslip) even if finalize were ever retried.
   */
  async recordRepaymentWithinTransaction(
    client: PoolClient,
    input: { loanId: string; payrollRunId: string; payslipId: string; amount: number }
  ): Promise<void> {
    const inserted = await client.query(
      `INSERT INTO employee_loan_repayments (company_id, loan_id, payroll_run_id, payslip_id, amount)
       SELECT company_id, id, $2, $3, $4 FROM employee_loans WHERE id = $1
       ON CONFLICT (loan_id, payslip_id) DO NOTHING
       RETURNING id`,
      [input.loanId, input.payrollRunId, input.payslipId, input.amount]
    );
    if (inserted.rowCount === 0) return; // already recorded — no double-decrement
    const updated = await client.query(
      `UPDATE employee_loans
       SET outstanding_balance = GREATEST(outstanding_balance - $2, 0), updated_at = now(),
           status = CASE WHEN outstanding_balance - $2 <= 0 THEN 'closed' ELSE status END
       WHERE id = $1 RETURNING outstanding_balance`,
      [input.loanId, input.amount]
    );
    if (updated.rowCount === 0) throw new Error(`employee_loans row ${input.loanId} vanished mid-finalize — this should never happen`);
  }

  private async mustExistEmployee(client: PoolClient, companyId: string, employeeId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM employees WHERE id = $1 AND company_id = $2", [employeeId, companyId]);
    if (result.rowCount === 0) throw new NotFoundException("Employee not found");
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage employee loans");
    }
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const [canView, canManage] = await Promise.all([this.rbac.can(claims, VIEW_PERMISSION), this.rbac.can(claims, MANAGE_PERMISSION)]);
    if (!canView && !canManage) {
      throw new ForbiddenException("Not permitted to view employee loans");
    }
  }
}
