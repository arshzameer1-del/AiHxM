import { localToday } from "../common/local-date";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { WorkflowService } from "../workflow/workflow.service";
import { statusForOutcome, submitToEngineIfConfigured } from "../workflow/engine-routing";
import { addMonthsClamped, allocateToSchedule, buildSchedule, installmentFor } from "./loan-schedule";
import type {
  CancelEmployeeLoanRequest,
  CreateEmployeeLoanRequest,
  EmployeeLoanRepaymentView,
  EmployeeLoanView,
  GenerateLoanScheduleRequest,
  HoldEmployeeLoanRequest,
  LoanScheduleRowView,
  LoanTypeView,
  ResumeEmployeeLoanRequest,
  SettleEmployeeLoanRequest,
  SkipLoanInstallmentsRequest,
  UpsertLoanTypeRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";
const VIEW_PERMISSION = "employee.view";
const WORKFLOW_OBJECT_KEY = "employee_loan";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

function toIsoDate(value: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v = value as any;
  if (typeof v === "string") return v.slice(0, 10);
  return v?.toISOString ? v.toISOString().slice(0, 10) : v;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const MAX_LOAN_AMOUNT = 1_000_000_000;
/** Common-sense limits on a new loan or advance, so a typing mistake cannot create a schedule that makes no sense. */
function assertSaneLoanTerms(input: CreateEmployeeLoanRequest): void {
  const cents = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
  if (input.principalAmount > MAX_LOAN_AMOUNT) throw new BadRequestException("principalAmount is too large. Check the amount.");
  if (!cents(input.principalAmount)) throw new BadRequestException("principalAmount can have at most two decimal places (paisa).");
  if (input.installmentAmount !== undefined) {
    if (!cents(input.installmentAmount)) throw new BadRequestException("installmentAmount can have at most two decimal places (paisa).");
    if (Math.ceil(input.principalAmount / input.installmentAmount - 1e-9) > 600) {
      throw new BadRequestException("That instalment would take more than 600 instalments to repay. Raise the instalment.");
    }
  }
  const issued = input.issuedDate.slice(0, 10);
  const plus = (iso: string, days: number) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  if (issued < "2000-01-01") throw new BadRequestException("issuedDate is too far in the past. Check the year.");
  if (issued > "2500-12-31") throw new BadRequestException("issuedDate is too far ahead. Check the year.");
  if (input.deductionStartDate) {
    const start = input.deductionStartDate.slice(0, 10);
    if (start < issued) throw new BadRequestException("Deductions cannot start before the loan is issued.");
    if (start > plus(issued, 366)) throw new BadRequestException("Deductions start more than a year after the loan is issued. Check the date.");
  }
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
    loanTypeId: row.loan_type_id ?? null,
    loanTypeName: row.loan_type_name ?? null,
    deductionStartDate: row.deduction_start_date ? toIsoDate(row.deduction_start_date) : null,
    installmentsCount: row.installments_count ?? null,
    guarantorEmployeeId: row.guarantor_employee_id ?? null,
    approvalStatus: row.approval_status ?? "not_required",
    settlementRequested: !!row.settlement_requested,
    holdReason: row.hold_reason ?? null,
    closedReason: row.closed_reason ?? null,
    hasSchedule: Number(row.schedule_rows ?? 0) > 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function typeToView(row: any): LoanTypeView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    maxInstallmentPercent: row.max_installment_percent === null ? null : Number(row.max_installment_percent),
    maxPrincipalMultiple: row.max_principal_multiple === null ? null : Number(row.max_principal_multiple),
    maxInstallments: row.max_installments ?? null,
    requiresGuarantor: !!row.requires_guarantor,
    description: row.description ?? null,
    isActive: !!row.is_active,
    sortOrder: row.sort_order,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scheduleToView(row: any): LoanScheduleRowView {
  return {
    id: row.id,
    loanId: row.loan_id,
    installmentNo: row.installment_no,
    dueDate: toIsoDate(row.due_date),
    amount: Number(row.amount),
    status: row.status,
    paidAmount: Number(row.paid_amount),
    paidRunId: row.paid_run_id ?? null,
    paidAt: row.paid_at ? toIso(row.paid_at) : null,
    note: row.note ?? null,
  };
}

const LOAN_SELECT = `SELECT l.*, t.name AS loan_type_name,
                            (SELECT COUNT(*) FROM loan_schedules s WHERE s.loan_id = l.id AND s.status <> 'cancelled') AS schedule_rows
                       FROM employee_loans l LEFT JOIN loan_types t ON t.id = l.loan_type_id`;

/** What payroll will recover from one loan in one run, and why. */
export type LoanDeductionPreview = {
  loan: EmployeeLoanView;
  amount: number;
  basis: "final_settlement" | "early_settlement" | "schedule" | "fixed_installment";
  dueInstallments: number;
};

/**
 * Payroll Enterprise Gap Analysis Phase P3 + gap register PAY-13 - loans and salary advances (the SAP IT0045
 * equivalent). Core-Employee-owned (`employee.manage.all` / `employee.view`); `PayrollService` only reads these
 * tables to PREVIEW a run's deduction at calculate() time and writes the ledger / decrements the balance when a run
 * is FINALIZED (`recordRepaymentWithinTransaction`).
 *
 * PAY-13: a loan has a catalogue type with the tenant's own policy limits, a guarantor where the type asks for one, an
 * approval (through the workflow engine when a template is active), and an approved repayment SCHEDULE that payroll
 * consumes: the instalments due up to the period end. Recovery can be held, instalments skipped, and the whole balance
 * settled early through payroll or by a recorded cash receipt. A loan with no schedule rows (created before PAY-13) keeps
 * the original fixed-instalment behaviour until `generateSchedule` gives it one.
 */
@Injectable()
export class EmployeeLoansService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    // PAY-13: optional + appended so positional spec constructions keep working.
    private readonly workflow?: WorkflowService
  ) {
    this.workflow?.adapters?.register({
      objectKey: WORKFLOW_OBJECT_KEY,
      label: "Loan or advance",
      canSendBack: true,
      describe: async (client, recordId) => {
        const r = await client.query(
          `SELECT l.loan_type, l.principal_amount, l.installment_amount, e.first_name, e.last_name
             FROM employee_loans l JOIN employees e ON e.id = l.employee_id WHERE l.id = $1`,
          [recordId]
        );
        if (!r.rowCount) return null;
        const x = r.rows[0];
        return {
          title: `${x.loan_type === "loan" ? "Loan" : "Salary advance"}: ${x.first_name} ${x.last_name}`,
          summary: `${Number(x.principal_amount).toFixed(2)}, ${Number(x.installment_amount).toFixed(2)} per instalment`,
        };
      },
      onOutcome: async (ctx) => {
        const row = (await ctx.client.query("SELECT id, status FROM employee_loans WHERE id = $1 FOR UPDATE", [ctx.recordId])).rows[0];
        if (!row || row.status !== "pending_approval") return;
        const outcome = statusForOutcome(ctx.event);
        if (outcome === "approved") {
          await ctx.client.query(
            "UPDATE employee_loans SET status = 'active', approval_status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1",
            [ctx.recordId, ctx.claims.sub]
          );
        } else if (outcome === "rejected" || outcome === "cancelled") {
          await ctx.client.query(
            "UPDATE employee_loans SET status = 'rejected', approval_status = 'rejected', closed_reason = 'rejected', closed_at = now(), updated_at = now() WHERE id = $1",
            [ctx.recordId]
          );
          await ctx.client.query("UPDATE loan_schedules SET status = 'cancelled', updated_at = now() WHERE loan_id = $1 AND status IN ('scheduled', 'held')", [ctx.recordId]);
        } else {
          return;
        }
        await this.audit.record(ctx.client, ctx.claims, {
          companyId: ctx.claims.company_id ?? null,
          action: `employee_loan.${outcome}`,
          target: ctx.recordId,
          metadata: { viaWorkflow: ctx.instanceId },
        });
      },
    });
  }

  // ------------------------------------------------------------------ catalogue

  async listTypes(claims: RequestClaims, includeInactive = false): Promise<LoanTypeView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.ensureDefaultTypes(client, claims.company_id!);
      const result = await client.query(
        `SELECT * FROM loan_types ${includeInactive ? "" : "WHERE is_active"} ORDER BY sort_order, name`
      );
      return result.rows.map(typeToView);
    });
  }

  async createType(claims: RequestClaims, input: UpsertLoanTypeRequest): Promise<LoanTypeView> {
    await this.requireManage(claims);
    if (!input.code || !input.name?.trim() || !input.kind) throw new BadRequestException("code, name and kind are required");
    this.assertLimits(input);
    return this.db.withClaims(claims, async (client) => {
      try {
        const result = await client.query(
          `INSERT INTO loan_types (company_id, code, name, kind, max_installment_percent, max_principal_multiple, max_installments,
                                   requires_guarantor, description, is_active, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
          [
            claims.company_id, input.code, input.name!.trim(), input.kind, input.maxInstallmentPercent ?? null, input.maxPrincipalMultiple ?? null,
            input.maxInstallments ?? null, input.requiresGuarantor ?? false, input.description ?? null, input.isActive ?? true, input.sortOrder ?? 100,
          ]
        );
        await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "loan_type.create", target: result.rows[0].id, metadata: { code: input.code } });
        return typeToView(result.rows[0]);
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new ConflictException(`A loan type with code "${input.code}" already exists`);
        if ((err as { code?: string }).code === "23514") throw new BadRequestException("The code must be lower-case letters, digits or underscores, starting with a letter");
        throw err;
      }
    });
  }

  async updateType(claims: RequestClaims, id: string, input: UpsertLoanTypeRequest): Promise<LoanTypeView> {
    await this.requireManage(claims);
    this.assertLimits(input);
    return this.db.withClaims(claims, async (client) => {
      const current = await client.query("SELECT * FROM loan_types WHERE id = $1 FOR UPDATE", [id]);
      if (!current.rowCount) throw new NotFoundException("Loan type not found");
      const c = current.rows[0];
      const has = (k: keyof UpsertLoanTypeRequest) => Object.prototype.hasOwnProperty.call(input, k);
      const result = await client.query(
        `UPDATE loan_types SET name = $2, max_installment_percent = $3, max_principal_multiple = $4, max_installments = $5,
                requires_guarantor = $6, description = $7, is_active = $8, sort_order = $9, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [
          id,
          input.name?.trim() || c.name,
          has("maxInstallmentPercent") ? input.maxInstallmentPercent : c.max_installment_percent,
          has("maxPrincipalMultiple") ? input.maxPrincipalMultiple : c.max_principal_multiple,
          has("maxInstallments") ? input.maxInstallments : c.max_installments,
          input.requiresGuarantor ?? c.requires_guarantor,
          has("description") ? input.description : c.description,
          input.isActive ?? c.is_active,
          input.sortOrder ?? c.sort_order,
        ]
      );
      // a policy change never rewrites a loan already issued: limits are checked when a loan is created
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "loan_type.update", target: id, metadata: { fields: Object.keys(input) } });
      return typeToView(result.rows[0]);
    });
  }

  private assertLimits(input: UpsertLoanTypeRequest) {
    const pct = input.maxInstallmentPercent;
    if (pct !== undefined && pct !== null && (pct <= 0 || pct > 100)) throw new BadRequestException("maxInstallmentPercent must be above 0 and at most 100");
    const mult = input.maxPrincipalMultiple;
    if (mult !== undefined && mult !== null && mult <= 0) throw new BadRequestException("maxPrincipalMultiple must be above 0");
    const n = input.maxInstallments;
    if (n !== undefined && n !== null && (!Number.isInteger(n) || n <= 0 || n > 600)) throw new BadRequestException("maxInstallments must be a whole number between 1 and 600");
  }

  /** Every tenant gets the two original kinds, with no limits, the first time the catalogue is read. */
  private async ensureDefaultTypes(client: PoolClient, companyId: string): Promise<void> {
    await client.query(
      `INSERT INTO loan_types (company_id, code, name, kind, sort_order)
       VALUES ($1, 'loan', 'Loan', 'loan', 10), ($1, 'salary_advance', 'Salary advance', 'salary_advance', 20)
       ON CONFLICT (company_id, code) DO NOTHING`,
      [companyId]
    );
  }

  // ------------------------------------------------------------------ loans

  async list(claims: RequestClaims, employeeId: string): Promise<EmployeeLoanView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustExistEmployee(client, claims.company_id!, employeeId);
      const result = await client.query(`${LOAN_SELECT} WHERE l.employee_id = $1 ORDER BY l.issued_date DESC, l.created_at DESC`, [employeeId]);
      return result.rows.map(rowToView);
    });
  }

  async getSchedule(claims: RequestClaims, loanId: string): Promise<LoanScheduleRowView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.loadLoan(client, loanId);
      const result = await client.query("SELECT *, due_date::text AS due_date FROM loan_schedules WHERE loan_id = $1 ORDER BY installment_no", [loanId]);
      return result.rows.map(scheduleToView);
    });
  }

  async listRepayments(claims: RequestClaims, loanId: string): Promise<EmployeeLoanRepaymentView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.loadLoan(client, loanId);
      const result = await client.query("SELECT * FROM employee_loan_repayments WHERE loan_id = $1 ORDER BY created_at", [loanId]);
      return result.rows.map((r) => ({
        id: r.id,
        loanId: r.loan_id,
        payrollRunId: r.payroll_run_id ?? null,
        payslipId: r.payslip_id ?? null,
        amount: Number(r.amount),
        createdAt: toIso(r.created_at),
        source: r.source,
        reference: r.reference ?? null,
      }));
    });
  }

  async create(claims: RequestClaims, input: CreateEmployeeLoanRequest): Promise<EmployeeLoanView> {
    await this.requireManage(claims);
    if (!(input.principalAmount > 0)) throw new BadRequestException("principalAmount must be greater than zero");
    if (input.installmentAmount === undefined && input.installmentsCount === undefined) {
      throw new BadRequestException("Give either installmentAmount or installmentsCount");
    }
    if (input.installmentAmount !== undefined && !(input.installmentAmount > 0)) throw new BadRequestException("installmentAmount must be greater than zero");
    if (input.installmentsCount !== undefined && (!Number.isInteger(input.installmentsCount) || input.installmentsCount < 1 || input.installmentsCount > 600)) {
      throw new BadRequestException("installmentsCount must be a whole number between 1 and 600");
    }
    assertSaneLoanTerms(input);
    const installment = round2(input.installmentAmount ?? installmentFor(input.principalAmount, input.installmentsCount!));
    const startDate = input.deductionStartDate ?? input.issuedDate;
    const schedule = buildSchedule(input.principalAmount, installment, startDate);
    return this.db.withClaims(claims, async (client) => {
      await this.mustExistEmployee(client, claims.company_id!, input.employeeId);
      // Money lent to someone who has already left cannot be recovered through payroll.
      const status = await client.query("SELECT employment_status FROM employees WHERE id = $1 AND company_id = $2", [input.employeeId, claims.company_id]);
      if (status.rows[0]?.employment_status === "terminated") {
        throw new BadRequestException("This employee has left the company. A loan or salary advance cannot be given to a terminated employee.");
      }
      let type: LoanTypeView | null = null;
      if (input.loanTypeId) {
        const t = await client.query("SELECT * FROM loan_types WHERE id = $1", [input.loanTypeId]);
        if (!t.rowCount) throw new BadRequestException("The loan type does not exist");
        type = typeToView(t.rows[0]);
        if (!type.isActive) throw new BadRequestException(`The loan type "${type.name}" is not active`);
        if (type.kind !== input.loanType) throw new BadRequestException(`"${type.name}" is a ${type.kind.replace("_", " ")}, not a ${input.loanType.replace("_", " ")}`);
      }
      if (type) await this.assertPolicy(client, input, type, installment, schedule.length);
      if (input.guarantorEmployeeId) await this.assertGuarantor(client, claims.company_id!, input.employeeId, input.guarantorEmployeeId);
      let result = await client.query(
        `INSERT INTO employee_loans
           (company_id, employee_id, loan_type, reason, principal_amount, installment_amount, outstanding_balance, issued_date,
            created_by_user_account_id, loan_type_id, deduction_start_date, installments_count, guarantor_employee_id)
         VALUES ($1, $2, $3, $4, $5, $6, $5, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          claims.company_id, input.employeeId, input.loanType, input.reason ?? null, input.principalAmount, installment, input.issuedDate,
          claims.sub, type?.id ?? null, startDate, schedule.length, input.guarantorEmployeeId ?? null,
        ]
      );
      const loanId = result.rows[0].id as string;
      await client.query(
        `INSERT INTO loan_schedules (company_id, loan_id, installment_no, due_date, amount)
         SELECT $1, $2, x.installment_no, x.due_date, x.amount
           FROM jsonb_to_recordset($3::jsonb) AS x(installment_no int, due_date date, amount numeric)`,
        [claims.company_id, loanId, JSON.stringify(schedule.map((s) => ({ installment_no: s.installmentNo, due_date: s.dueDate, amount: s.amount })))]
      );
      // with an active approval template the loan is only recovered once the workflow approves it
      const instanceId = await submitToEngineIfConfigured(this.workflow, client, claims, {
        objectKey: WORKFLOW_OBJECT_KEY,
        table: "employee_loans",
        recordId: loanId,
        record: { employeeId: input.employeeId, loanType: input.loanType, principalAmount: input.principalAmount, loanTypeId: type?.id ?? null },
        title: `${input.loanType === "loan" ? "Loan" : "Salary advance"} of ${input.principalAmount}`,
      });
      if (instanceId) {
        await client.query("UPDATE employee_loans SET status = 'pending_approval', approval_status = 'pending' WHERE id = $1", [loanId]);
      }
      result = await client.query(`${LOAN_SELECT} WHERE l.id = $1`, [loanId]);
      const view = rowToView(result.rows[0]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_loan.create",
        target: view.id,
        metadata: {
          employeeId: input.employeeId, loanType: input.loanType, principalAmount: input.principalAmount, installmentAmount: installment,
          installments: schedule.length, loanTypeId: type?.id ?? null, approval: view.approvalStatus,
        },
      });
      return view;
    });
  }

  async cancel(claims: RequestClaims, id: string, input: CancelEmployeeLoanRequest = {}): Promise<EmployeeLoanView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const current = await this.loadLoan(client, id);
      if (!["active", "on_hold", "pending_approval"].includes(current.status)) {
        throw new BadRequestException(`Only an open loan can be cancelled (current status: "${current.status}")`);
      }
      await client.query(
        "UPDATE employee_loans SET status = 'cancelled', closed_reason = 'cancelled', closed_at = now(), settlement_requested = false, updated_at = now() WHERE id = $1",
        [id]
      );
      await client.query("UPDATE loan_schedules SET status = 'cancelled', updated_at = now() WHERE loan_id = $1 AND status IN ('scheduled', 'held', 'skipped')", [id]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_loan.cancel",
        target: id,
        metadata: { reason: input.reason ?? null, outstandingBalanceAtCancellation: Number(current.outstanding_balance) },
      });
      return this.view(client, id);
    });
  }

  async hold(claims: RequestClaims, id: string, input: HoldEmployeeLoanRequest): Promise<EmployeeLoanView> {
    await this.requireManage(claims);
    if (!input.reason?.trim() || input.reason.trim().length < 3) throw new BadRequestException("A reason is required to hold recovery");
    return this.db.withClaims(claims, async (client) => {
      const current = await this.loadLoan(client, id);
      if (current.status !== "active") throw new BadRequestException(`Only an active loan can be put on hold (current status: "${current.status}")`);
      await client.query("UPDATE employee_loans SET status = 'on_hold', hold_reason = $2, held_at = now(), updated_at = now() WHERE id = $1", [id, input.reason.trim()]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "employee_loan.hold", target: id, metadata: { reason: input.reason.trim() } });
      return this.view(client, id);
    });
  }

  async resume(claims: RequestClaims, id: string, input: ResumeEmployeeLoanRequest = {}): Promise<EmployeeLoanView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const current = await this.loadLoan(client, id);
      if (current.status !== "on_hold") throw new BadRequestException(`Only a loan on hold can be resumed (current status: "${current.status}")`);
      if (input.resumeFrom) await this.reschedule(client, id, input.resumeFrom);
      await client.query("UPDATE employee_loans SET status = 'active', hold_reason = NULL, held_at = NULL, updated_at = now() WHERE id = $1", [id]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "employee_loan.resume", target: id, metadata: { resumeFrom: input.resumeFrom ?? null } });
      return this.view(client, id);
    });
  }

  /** Moves the open instalments so the first falls on `from`, keeping one month between them. */
  private async reschedule(client: PoolClient, loanId: string, from: string): Promise<void> {
    const open = await client.query<{ id: string }>(
      "SELECT id FROM loan_schedules WHERE loan_id = $1 AND status = 'scheduled' ORDER BY installment_no FOR UPDATE",
      [loanId]
    );
    const anchor = Number(from.slice(8, 10));
    let k = 0;
    for (const row of open.rows) {
      await client.query("UPDATE loan_schedules SET due_date = $2, updated_at = now() WHERE id = $1", [row.id, addMonthsClamped(from, k, anchor)]);
      k += 1;
    }
  }

  /**
   * Skips instalments: each skipped one is kept on record and an identical instalment is added at the end of the
   * schedule, so the loan takes one month longer per instalment skipped and the balance is unchanged.
   */
  async skipInstallments(claims: RequestClaims, id: string, input: SkipLoanInstallmentsRequest): Promise<LoanScheduleRowView[]> {
    await this.requireManage(claims);
    if (!input.reason?.trim() || input.reason.trim().length < 3) throw new BadRequestException("A reason is required to skip an instalment");
    if (!input.installmentNos?.length) throw new BadRequestException("Name the instalments to skip");
    return this.db.withClaims(claims, async (client) => {
      const loan = await this.loadLoan(client, id);
      if (!["active", "on_hold"].includes(loan.status)) throw new BadRequestException(`Instalments of a ${loan.status.replace("_", " ")} loan cannot be skipped`);
      const nos = [...new Set(input.installmentNos)].sort((a, b) => a - b);
      const rows = await client.query(
        "SELECT * FROM loan_schedules WHERE loan_id = $1 AND installment_no = ANY($2::int[]) FOR UPDATE",
        [id, nos]
      );
      if (rows.rowCount !== nos.length) throw new BadRequestException("One of the instalments does not exist");
      const notOpen = rows.rows.find((r) => r.status !== "scheduled");
      if (notOpen) throw new BadRequestException(`Instalment ${notOpen.installment_no} is ${notOpen.status} and cannot be skipped`);
      const last = (await client.query("SELECT installment_no, due_date::text AS due_date FROM loan_schedules WHERE loan_id = $1 ORDER BY installment_no DESC LIMIT 1", [id])).rows[0];
      let nextNo = last.installment_no as number;
      let nextDue = last.due_date as string;
      const anchor = Number((loan.deduction_start_date ? toIsoDate(loan.deduction_start_date) : nextDue).slice(8, 10));
      for (const row of rows.rows.sort((a, b) => a.installment_no - b.installment_no)) {
        await client.query("UPDATE loan_schedules SET status = 'skipped', note = $2, updated_at = now() WHERE id = $1", [row.id, input.reason.trim()]);
        nextNo += 1;
        nextDue = addMonthsClamped(nextDue, 1, anchor);
        await client.query(
          "INSERT INTO loan_schedules (company_id, loan_id, installment_no, due_date, amount, note) VALUES ($1, $2, $3, $4, $5, $6)",
          [claims.company_id, id, nextNo, nextDue, row.amount, `Added for skipped instalment ${row.installment_no}`]
        );
      }
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "employee_loan.skip_installments", target: id, metadata: { installmentNos: nos, reason: input.reason.trim() } });
      const result = await client.query("SELECT *, due_date::text AS due_date FROM loan_schedules WHERE loan_id = $1 ORDER BY installment_no", [id]);
      return result.rows.map(scheduleToView);
    });
  }

  async settle(claims: RequestClaims, id: string, input: SettleEmployeeLoanRequest): Promise<EmployeeLoanView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const loan = await this.loadLoan(client, id);
      if (input.mode === "payroll" || input.mode === "withdraw") {
        if (loan.status !== "active") throw new BadRequestException(`Only an active loan can be settled through payroll (current status: "${loan.status}")`);
        await client.query("UPDATE employee_loans SET settlement_requested = $2, updated_at = now() WHERE id = $1", [id, input.mode === "payroll"]);
        await this.audit.record(client, claims, {
          companyId: claims.company_id ?? null,
          action: input.mode === "payroll" ? "employee_loan.settlement_requested" : "employee_loan.settlement_withdrawn",
          target: id,
          metadata: { outstandingBalance: Number(loan.outstanding_balance) },
        });
        return this.view(client, id);
      }
      if (input.mode !== "cash") throw new BadRequestException("mode must be payroll, cash or withdraw");
      if (!["active", "on_hold"].includes(loan.status)) throw new BadRequestException(`A ${loan.status.replace("_", " ")} loan cannot take a repayment`);
      const outstanding = Number(loan.outstanding_balance);
      const amount = round2(input.amount ?? 0);
      if (!(amount > 0)) throw new BadRequestException("amount must be greater than zero");
      if (amount > outstanding + 0.004) throw new BadRequestException(`The amount exceeds the outstanding balance of ${outstanding.toFixed(2)}`);
      if (!input.receivedOn) throw new BadRequestException("receivedOn is required");
      await client.query(
        `INSERT INTO employee_loan_repayments (company_id, loan_id, amount, source, reference, received_on, recorded_by_user_account_id)
         VALUES ($1, $2, $3, 'cash', $4, $5, $6)`,
        [claims.company_id, id, amount, input.reference?.trim() || null, input.receivedOn, claims.sub]
      );
      await this.applyToBalance(client, id, amount, "early_settlement");
      await allocateToSchedule(client, id, amount, { runId: null, payslipId: null });
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_loan.cash_repayment",
        target: id,
        metadata: { amount, receivedOn: input.receivedOn, reference: input.reference ?? null },
      });
      return this.view(client, id);
    });
  }

  /** Gives a loan created before schedules existed an approved schedule from what is still owed. */
  async generateSchedule(claims: RequestClaims, id: string, input: GenerateLoanScheduleRequest = {}): Promise<LoanScheduleRowView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const loan = await this.loadLoan(client, id);
      if (!["active", "on_hold", "pending_approval"].includes(loan.status)) throw new BadRequestException(`A ${loan.status} loan cannot be given a schedule`);
      const existing = await client.query("SELECT 1 FROM loan_schedules WHERE loan_id = $1 AND status <> 'cancelled' LIMIT 1", [id]);
      if (existing.rowCount) throw new ConflictException("This loan already has a repayment schedule");
      const start = input.startDate ?? localToday();
      const rows = buildSchedule(Number(loan.outstanding_balance), Number(loan.installment_amount), start);
      if (!rows.length) throw new BadRequestException("Nothing is outstanding on this loan");
      await client.query(
        `INSERT INTO loan_schedules (company_id, loan_id, installment_no, due_date, amount)
         SELECT $1, $2, x.installment_no, x.due_date, x.amount
           FROM jsonb_to_recordset($3::jsonb) AS x(installment_no int, due_date date, amount numeric)
         ON CONFLICT (loan_id, installment_no) DO NOTHING`,
        [claims.company_id, id, JSON.stringify(rows.map((s) => ({ installment_no: s.installmentNo, due_date: s.dueDate, amount: s.amount })))]
      );
      await client.query("UPDATE employee_loans SET deduction_start_date = $2, installments_count = $3, updated_at = now() WHERE id = $1", [id, start, rows.length]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "employee_loan.generate_schedule", target: id, metadata: { startDate: start, installments: rows.length } });
      const result = await client.query("SELECT *, due_date::text AS due_date FROM loan_schedules WHERE loan_id = $1 ORDER BY installment_no", [id]);
      return result.rows.map(scheduleToView);
    });
  }

  // ------------------------------------------------------------------ payroll collaboration

  /**
   * `PayrollService.calculateOnePayslip()`'s own read - every ACTIVE loan an employee has. Kept for readers that only
   * need the loans; payroll itself calls `previewDeductionsWithinTransaction`.
   */
  async listActiveLoansWithinTransaction(client: PoolClient, employeeId: string): Promise<EmployeeLoanView[]> {
    const result = await client.query(`${LOAN_SELECT} WHERE l.employee_id = $1 AND l.status = 'active' ORDER BY l.issued_date ASC`, [employeeId]);
    return result.rows.map(rowToView);
  }

  /**
   * What each active loan costs this run (preview only, nothing is written). A final settlement recovers the whole
   * balance; so does a loan whose early settlement was requested; a loan with a schedule recovers the instalments due up
   * to the period end; a loan without one keeps the original `min(instalment, balance)`.
   */
  async previewDeductionsWithinTransaction(
    client: PoolClient,
    employeeId: string,
    periodEnd: string,
    options: { fullPayoff?: boolean } = {}
  ): Promise<LoanDeductionPreview[]> {
    const loans = await this.listActiveLoansWithinTransaction(client, employeeId);
    const out: LoanDeductionPreview[] = [];
    for (const loan of loans) {
      let amount: number;
      let basis: LoanDeductionPreview["basis"];
      let due = 0;
      if (options.fullPayoff) {
        amount = loan.outstandingBalance;
        basis = "final_settlement";
      } else if (loan.settlementRequested) {
        amount = loan.outstandingBalance;
        basis = "early_settlement";
      } else if (loan.hasSchedule) {
        const r = await client.query<{ total: string | null; n: string }>(
          "SELECT SUM(amount) AS total, COUNT(*) AS n FROM loan_schedules WHERE loan_id = $1 AND status = 'scheduled' AND due_date <= $2",
          [loan.id, periodEnd]
        );
        amount = Math.min(Number(r.rows[0].total ?? 0), loan.outstandingBalance);
        due = Number(r.rows[0].n);
        basis = "schedule";
      } else {
        amount = Math.min(loan.installmentAmount, loan.outstandingBalance);
        basis = "fixed_installment";
      }
      amount = round2(amount);
      if (amount > 0) out.push({ loan, amount, basis, dueInstallments: due });
    }
    return out;
  }

  /**
   * `PayrollService.finalizeRun()`'s own write - records the ledger row, decrements `outstanding_balance` (closing the
   * loan at zero) and marks the schedule rows the money covered. Never called from `calculate()`.
   * `ON CONFLICT DO NOTHING` on the ledger's `(loan_id, payslip_id)` unique index makes this safe to call at most once
   * per (loan, payslip) even if finalize were ever retried.
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
    if (inserted.rowCount === 0) return; // already recorded - no double-decrement
    await this.applyToBalance(client, input.loanId, input.amount, "repaid");
    await allocateToSchedule(client, input.loanId, input.amount, { runId: input.payrollRunId, payslipId: input.payslipId });
  }

  private async applyToBalance(client: PoolClient, loanId: string, amount: number, closeReason: string): Promise<void> {
    const updated = await client.query(
      `UPDATE employee_loans
          SET outstanding_balance = GREATEST(outstanding_balance - $2, 0), updated_at = now(),
              status = CASE WHEN outstanding_balance - $2 <= 0 THEN 'closed' ELSE status END,
              closed_reason = CASE WHEN outstanding_balance - $2 <= 0 THEN $3 ELSE closed_reason END,
              closed_at = CASE WHEN outstanding_balance - $2 <= 0 THEN now() ELSE closed_at END,
              settlement_requested = CASE WHEN outstanding_balance - $2 <= 0 THEN false ELSE settlement_requested END
        WHERE id = $1 RETURNING outstanding_balance`,
      [loanId, amount, closeReason]
    );
    if (updated.rowCount === 0) throw new Error(`employee_loans row ${loanId} vanished mid-finalize - this should never happen`);
  }

  // ------------------------------------------------------------------ helpers

  private async view(client: PoolClient, id: string): Promise<EmployeeLoanView> {
    const r = await client.query(`${LOAN_SELECT} WHERE l.id = $1`, [id]);
    return rowToView(r.rows[0]);
  }

  private async loadLoan(client: PoolClient, id: string) {
    const r = await client.query("SELECT *, deduction_start_date::text AS deduction_start_date FROM employee_loans WHERE id = $1", [id]);
    if (r.rowCount === 0) throw new NotFoundException("Loan not found");
    return r.rows[0];
  }

  /** The tenant's own limits for this type, checked against the employee's monthly earnings on the issue date. */
  private async assertPolicy(client: PoolClient, input: CreateEmployeeLoanRequest, type: LoanTypeView, installment: number, count: number): Promise<void> {
    if (type.maxInstallments !== null && count > type.maxInstallments) {
      throw new BadRequestException(`"${type.name}" allows at most ${type.maxInstallments} instalments; this schedule has ${count}`);
    }
    if (type.requiresGuarantor && !input.guarantorEmployeeId) throw new BadRequestException(`"${type.name}" requires a guarantor`);
    if (type.maxInstallmentPercent === null && type.maxPrincipalMultiple === null) return;
    const gross = await client.query<{ monthly: string | null; n: string }>(
      `SELECT SUM(ecc.amount) AS monthly, COUNT(*) AS n
         FROM employee_compensation_components ecc JOIN compensation_components cc ON cc.id = ecc.component_id
        WHERE ecc.employee_id = $1 AND cc.is_active = true AND cc.component_type = 'earning'
          AND ecc.effective_from <= $2 AND (ecc.effective_to IS NULL OR ecc.effective_to >= $2)`,
      [input.employeeId, input.issuedDate]
    );
    if (Number(gross.rows[0].n) === 0) {
      throw new BadRequestException(`"${type.name}" has a limit based on salary, but the employee has no earnings on record to measure it against`);
    }
    const monthly = Number(gross.rows[0].monthly);
    if (type.maxInstallmentPercent !== null && installment > (monthly * type.maxInstallmentPercent) / 100 + 0.004) {
      throw new BadRequestException(
        `The instalment of ${installment.toFixed(2)} is above ${type.maxInstallmentPercent}% of monthly earnings (${((monthly * type.maxInstallmentPercent) / 100).toFixed(2)}) allowed for "${type.name}"`
      );
    }
    if (type.maxPrincipalMultiple !== null && input.principalAmount > monthly * type.maxPrincipalMultiple + 0.004) {
      throw new BadRequestException(
        `The amount ${input.principalAmount.toFixed(2)} is above ${type.maxPrincipalMultiple} times monthly earnings (${(monthly * type.maxPrincipalMultiple).toFixed(2)}) allowed for "${type.name}"`
      );
    }
  }

  private async assertGuarantor(client: PoolClient, companyId: string, borrowerId: string, guarantorId: string): Promise<void> {
    if (guarantorId === borrowerId) throw new BadRequestException("An employee cannot guarantee their own loan");
    const r = await client.query("SELECT employment_status FROM employees WHERE id = $1 AND company_id = $2", [guarantorId, companyId]);
    if (r.rowCount === 0) throw new BadRequestException("The guarantor does not exist");
    if (r.rows[0].employment_status !== "active") throw new BadRequestException("The guarantor must be a current employee");
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
