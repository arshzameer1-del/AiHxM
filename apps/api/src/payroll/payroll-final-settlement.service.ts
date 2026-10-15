import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { LeaveLedgerService } from "../leave/leave-ledger.service";
import { isPayrollAreaInScope, resolvePayrollAreaAccess, type PayrollAreaAccess } from "./payroll-area-access";
import { payrollRunHooks, type RunRow } from "./payroll-run-hooks";
import { loadSettlementSettings, PayrollSchemesService, resolveScheme } from "./payroll-schemes.service";
import type { FinalSettlementLineKind, FinalSettlementLineView, FinalSettlementSettleVia, FinalSettlementStatus, FinalSettlementView, PayrollSchemeParameters } from "@aihxm/shared-types";

const MODULE_KEY = "payroll" as const;
const CALCULATE_BASE = "payroll.calculate";
const APPROVE_PERMISSION = "payroll.approve.all";
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const iso = (v: any): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

type DraftLine = {
  kind: FinalSettlementLineKind;
  label: string;
  amount: number;
  settleVia: FinalSettlementSettleVia;
  isTaxable?: boolean | null;
  schemeCode?: string | null;
  basis?: Record<string, unknown>;
  warning?: string | null;
};

/** Completed months from `from` up to and including `lastDay` (the end is the day after the last working day). */
export function completedMonths(from: string, lastDay: string): number {
  const end = new Date(`${lastDay}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const [y1, m1, d1] = from.split("-").map(Number);
  const y2 = end.getUTCFullYear();
  const m2 = end.getUTCMonth() + 1;
  const d2 = end.getUTCDate();
  return Math.max(0, (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToLine(row: any): FinalSettlementLineView {
  return {
    id: row.id,
    lineNo: Number(row.line_no),
    kind: row.kind,
    label: row.label,
    amount: Number(row.amount),
    settleVia: row.settle_via,
    isTaxable: row.is_taxable ?? null,
    additionalPaymentId: row.additional_payment_id ?? null,
    schemeCode: row.scheme_code ?? null,
    basis: row.basis ?? {},
    warning: row.warning ?? null,
  };
}

/**
 * PAY-14 - the employee's final settlement.
 *
 * A termination that takes effect opens one (database trigger on the lifecycle event, LIF-05). HR calculates it from
 * the tenant's own settings and schemes - leave encashment, gratuity, notice recovery, provident-fund balance and the
 * loans still outstanding - a second person approves it, which turns the payable lines into the earning / deduction
 * payments the employee's `final_settlement` payroll run consumes, and finalising that run closes the settlement with
 * an immutable result: the payslip's figures and the lines that make them up. Nothing is estimated from statute here;
 * every rate, day count and divisor comes from `payroll_settlement_settings` or a scheme definition.
 */
@Injectable()
export class PayrollFinalSettlementService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly schemes: PayrollSchemesService,
    private readonly leaveLedger?: LeaveLedgerService
  ) {
    payrollRunHooks.register("payroll-final-settlement", {
      onFinalized: (client, claims, run) => this.onRunFinalized(client, claims, run),
      onReversed: (client, claims, run) => this.onRunReversed(client, claims, run),
    });
  }

  // ------------------------------------------------------------------ reads

  async list(claims: RequestClaims, filter: { status?: FinalSettlementStatus; employeeId?: string } = {}): Promise<FinalSettlementView[]> {
    return this.db.withClaims(claims, async (client) => {
      const access = await this.requireView(claims);
      const r = await client.query(
        `SELECT s.*, e.employee_number, trim(e.first_name || ' ' || e.last_name) AS employee_name, e.payroll_area_id
           FROM payroll_final_settlements s JOIN employees e ON e.id = s.employee_id
          WHERE ($1::text IS NULL OR s.status = $1) AND ($2::uuid IS NULL OR s.employee_id = $2)
          ORDER BY s.created_at DESC`,
        [filter.status ?? null, filter.employeeId ?? null]
      );
      return r.rows.filter((row) => !access || isPayrollAreaInScope(access, row.payroll_area_id)).map((row) => this.toView(row, []));
    });
  }

  async get(claims: RequestClaims, id: string): Promise<FinalSettlementView> {
    return this.db.withClaims(claims, async (client) => {
      const access = await this.requireView(claims);
      const row = await this.load(client, id, false);
      if (access && !isPayrollAreaInScope(access, row.payroll_area_id)) throw new NotFoundException("Final settlement not found");
      return this.toView(row, await this.loadLines(client, id));
    });
  }

  // ------------------------------------------------------------------ lifecycle

  async calculate(claims: RequestClaims, id: string): Promise<FinalSettlementView> {
    const access = await this.requireCalculate(claims);
    return this.db.withClaims(claims, async (client) => {
      const s = await this.load(client, id, true);
      this.assertScope(access, s);
      if (!["open", "calculated"].includes(s.status)) throw new BadRequestException(`A ${s.status} settlement cannot be recalculated${s.status === "approved" ? " - withdraw its approval first" : ""}`);
      const lines = await this.compute(client, s);
      await client.query("DELETE FROM payroll_final_settlement_lines WHERE settlement_id = $1", [id]);
      let n = 0;
      for (const l of lines) {
        n += 1;
        await client.query(
          `INSERT INTO payroll_final_settlement_lines (company_id, settlement_id, line_no, kind, label, amount, settle_via, is_taxable, scheme_code, basis, warning)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
          [s.company_id, id, n, l.kind, l.label, r2(l.amount), l.settleVia, l.isTaxable ?? null, l.schemeCode ?? null, JSON.stringify(l.basis ?? {}), l.warning ?? null]
        );
      }
      await client.query(
        `UPDATE payroll_final_settlements SET status = 'calculated', calculation_sequence = calculation_sequence + 1, calculated_by = $2, calculated_at = now(),
                approved_by = NULL, approved_at = NULL, updated_at = now() WHERE id = $1`,
        [id, claims.sub]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_final_settlement.calculate", target: id, metadata: { employeeId: s.employee_id, lines: lines.length } });
      return this.toView(await this.load(client, id, false), await this.loadLines(client, id));
    });
  }

  /** A second person signs the calculation off; the payable lines become payments the final payroll run will consume. */
  async approve(claims: RequestClaims, id: string): Promise<FinalSettlementView> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, APPROVE_PERMISSION))) throw new ForbiddenException("Not permitted to approve final settlements");
    return this.db.withClaims(claims, async (client) => {
      const s = await this.load(client, id, true);
      if (s.status !== "calculated") throw new BadRequestException(`Only a calculated settlement can be approved (current status: "${s.status}")`);
      if (s.calculated_by === claims.sub) throw new ForbiddenException("The person who calculated a final settlement cannot approve it");
      const lines = await this.loadLines(client, id);
      const warnings = lines.filter((l) => l.warning && l.settleVia === "info");
      let created = 0;
      for (const l of lines.filter((x) => x.settleVia === "payslip" && x.amount !== 0)) {
        const pay = await client.query(
          `INSERT INTO employee_additional_payments (company_id, employee_id, payment_type, label, amount, is_taxable, effective_date, created_by_user_account_id, reason_note)
           VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9) RETURNING id`,
          [s.company_id, s.employee_id, l.amount > 0 ? "earning" : "deduction", l.label, Math.abs(l.amount), l.amount > 0 ? l.isTaxable ?? true : false, iso(s.last_working_day), claims.sub, `Final settlement ${id}`]
        );
        await client.query("UPDATE payroll_final_settlement_lines SET additional_payment_id = $2 WHERE id = $1", [l.id, pay.rows[0].id]);
        created += 1;
      }
      await client.query("UPDATE payroll_final_settlements SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1", [id, claims.sub]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_final_settlement.approve", target: id, metadata: { employeeId: s.employee_id, payments: created, unresolvedWarnings: warnings.length } });
      return this.toView(await this.load(client, id, false), await this.loadLines(client, id));
    });
  }

  /** Takes an approval back (before the final run consumed anything): the payments it created are cancelled. */
  async withdrawApproval(claims: RequestClaims, id: string, reason: string): Promise<FinalSettlementView> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, APPROVE_PERMISSION))) throw new ForbiddenException("Not permitted to withdraw a final settlement approval");
    if (!reason?.trim()) throw new BadRequestException("A reason is required");
    return this.db.withClaims(claims, async (client) => {
      const s = await this.load(client, id, true);
      if (s.status !== "approved") throw new BadRequestException(`Only an approved settlement can have its approval withdrawn (current status: "${s.status}")`);
      const consumed = await client.query(
        `SELECT 1 FROM payroll_final_settlement_lines l JOIN employee_additional_payments p ON p.id = l.additional_payment_id WHERE l.settlement_id = $1 AND p.status = 'consumed' LIMIT 1`,
        [id]
      );
      if (consumed.rowCount) throw new BadRequestException("A payroll run has already paid part of this settlement");
      await client.query(
        `UPDATE employee_additional_payments SET status = 'cancelled' WHERE status = 'pending' AND id IN (SELECT additional_payment_id FROM payroll_final_settlement_lines WHERE settlement_id = $1 AND additional_payment_id IS NOT NULL)`,
        [id]
      );
      await client.query("UPDATE payroll_final_settlement_lines SET additional_payment_id = NULL WHERE settlement_id = $1", [id]);
      await client.query("UPDATE payroll_final_settlements SET status = 'calculated', approved_by = NULL, approved_at = NULL, updated_at = now() WHERE id = $1", [id]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_final_settlement.withdraw_approval", target: id, metadata: { reason: reason.trim() } });
      return this.toView(await this.load(client, id, false), await this.loadLines(client, id));
    });
  }

  async cancel(claims: RequestClaims, id: string, reason: string): Promise<FinalSettlementView> {
    const access = await this.requireCalculate(claims);
    if (!reason?.trim()) throw new BadRequestException("A reason is required to cancel a final settlement");
    return this.db.withClaims(claims, async (client) => {
      const s = await this.load(client, id, true);
      this.assertScope(access, s);
      if (!["open", "calculated"].includes(s.status)) throw new BadRequestException(`A ${s.status} settlement cannot be cancelled${s.status === "approved" ? " - withdraw its approval first" : ""}`);
      await client.query("UPDATE payroll_final_settlements SET status = 'cancelled', cancel_reason = $2, updated_at = now() WHERE id = $1", [id, reason.trim()]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_final_settlement.cancel", target: id, metadata: { reason: reason.trim() } });
      return this.toView(await this.load(client, id, false), await this.loadLines(client, id));
    });
  }

  // ------------------------------------------------------------------ calculation

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async compute(client: PoolClient, s: any): Promise<DraftLine[]> {
    const lastDay = iso(s.last_working_day);
    const lines: DraftLine[] = [];
    const settings = await loadSettlementSettings(client);
    const emp = await client.query("SELECT date_of_joining FROM employees WHERE id = $1", [s.employee_id]);
    const joined = iso(emp.rows[0].date_of_joining);
    const months = completedMonths(joined, lastDay);
    const componentSum = async (where: string) => {
      const r = await client.query(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(ecc.amount), 0) AS total
           FROM employee_compensation_components ecc JOIN compensation_components cc ON cc.id = ecc.component_id
          WHERE ecc.employee_id = $1 AND ecc.effective_from <= $2::date AND (ecc.effective_to IS NULL OR ecc.effective_to >= $2::date) AND ${where}`,
        [s.employee_id, lastDay]
      );
      return r.rows[0].n > 0 ? Number(r.rows[0].total) : null;
    };
    // one day's pay for leave encashment / notice recovery: the monthly figure the tenant chose, over its divisor
    const monthly =
      settings.dailyRateBase === "gross_earnings" ? await componentSum("cc.component_type = 'earning'") : settings.dailyRateBase === "basic_salary" ? await componentSum("cc.key = 'basic_salary'") : null;
    const salaryProblem = settings.dailyRateBase === null ? "The salary figure for a day's pay (daily rate base) is not set in the settlement settings" : "The employee has no salary on record for the last working day";
    // gratuity base: the components flagged as counting toward gratuity, else the basic salary
    const flagged = await componentSum("cc.counts_toward_gratuity_base");
    const gratuityMonthly = flagged ?? (await componentSum("cc.key = 'basic_salary'"));
    const gratuityBaseSource = flagged !== null ? "components flagged for gratuity" : "basic_salary";
    const dayRate = (monthlyFigure: number | null, divisor: number | null | undefined) => (monthlyFigure !== null && divisor ? monthlyFigure / divisor : null);

    // leave encashment
    const bal = await client.query(
      `SELECT b.leave_type, t.name, (b.entitled_days - b.used_days) AS remaining
         FROM leave_balances b JOIN leave_types t ON t.company_id = b.company_id AND t.code = b.leave_type
        WHERE b.employee_id = $1 AND b.year = $2 AND t.encashable AND t.is_active AND (b.entitled_days - b.used_days) > 0`,
      [s.employee_id, Number(lastDay.slice(0, 4))]
    );
    if (bal.rowCount) {
      const days = r2(bal.rows.reduce((a, r) => a + Number(r.remaining), 0));
      const items = bal.rows.map((r) => ({ leaveType: r.leave_type, name: r.name, days: Number(r.remaining), year: Number(lastDay.slice(0, 4)) }));
      const rate = dayRate(monthly, settings.dailyRateDivisor);
      if (!settings.leaveEncashmentEnabled) {
        lines.push({ kind: "leave_encashment", label: "Leave encashment", amount: 0, settleVia: "info", basis: { items, days }, warning: "The employee has encashable leave but leave encashment is not enabled in the settlement settings" });
      } else if (rate === null) {
        lines.push({ kind: "leave_encashment", label: "Leave encashment", amount: 0, settleVia: "info", basis: { items, days }, warning: monthly === null ? salaryProblem : "The daily-rate divisor is not set in the settlement settings" });
      } else {
        lines.push({
          kind: "leave_encashment", label: `Leave encashment (${days} day${days === 1 ? "" : "s"})`, amount: r2(days * rate), settleVia: "payslip",
          isTaxable: settings.leaveEncashmentTaxable, basis: { items, days, monthlySalary: monthly, dailyRateDivisor: settings.dailyRateDivisor, dailyRate: r2(rate) },
        });
      }
    }

    // gratuity (first complete or incomplete gratuity scheme in force)
    const gratuityCodes = await client.query("SELECT DISTINCT code FROM payroll_scheme_definitions WHERE scheme_type = 'gratuity' ORDER BY code");
    for (const { code } of gratuityCodes.rows) {
      const def = await resolveScheme(client, s.company_id, code, lastDay);
      if (!def) continue;
      const p = def.parameters as PayrollSchemeParameters;
      if (!def.isComplete) {
        lines.push({ kind: "gratuity", label: def.name, amount: 0, settleVia: "info", schemeCode: code, basis: { missing: def.missingParameters }, warning: `The ${def.name} scheme still lacks: ${def.missingParameters.join(", ")}` });
        continue;
      }
      if (months < (p.minimumServiceMonths as number)) {
        lines.push({ kind: "gratuity", label: def.name, amount: 0, settleVia: "info", schemeCode: code, basis: { serviceMonths: months, minimumServiceMonths: p.minimumServiceMonths }, warning: `Service of ${months} month(s) is below the scheme's minimum of ${p.minimumServiceMonths}` });
        continue;
      }
      const rate = dayRate(gratuityMonthly, p.dailyRateDivisor);
      if (rate === null) {
        lines.push({ kind: "gratuity", label: def.name, amount: 0, settleVia: "info", schemeCode: code, basis: { serviceMonths: months }, warning: "The employee has no salary on record for the last working day" });
        continue;
      }
      const years = p.serviceRounding === "complete_years" ? Math.floor(months / 12) : Math.round((months / 12) * 10000) / 10000;
      lines.push({
        kind: "gratuity", label: `${def.name} (${years} year${years === 1 ? "" : "s"} of service)`, amount: r2((p.daysPerYearOfService as number) * years * rate), settleVia: "payslip",
        isTaxable: p.isTaxable ?? true, schemeCode: code,
        basis: { serviceMonths: months, serviceYears: years, daysPerYearOfService: p.daysPerYearOfService, dailyRateDivisor: p.dailyRateDivisor, dailyRate: r2(rate), monthlySalary: gratuityMonthly, baseSource: gratuityBaseSource, serviceRounding: p.serviceRounding },
      });
    }

    // notice recovery
    const off = await client.query("SELECT notice_period_days, notice_start_date FROM employee_offboarding WHERE termination_event_id = $1", [s.termination_event_id]);
    const notice = off.rows[0];
    if (notice?.notice_period_days) {
      if (!notice.notice_start_date) {
        lines.push({ kind: "notice_recovery", label: "Notice recovery", amount: 0, settleVia: "info", basis: { noticePeriodDays: notice.notice_period_days }, warning: "A notice period is recorded but its start date is not, so the days served are unknown" });
      } else {
        const served = Math.max(0, Math.round((Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${iso(notice.notice_start_date)}T00:00:00Z`)) / 86400000) + 1);
        const shortfall = Math.max(0, Number(notice.notice_period_days) - served);
        if (shortfall > 0) {
          const rate = dayRate(monthly, settings.dailyRateDivisor);
          if (!settings.noticeRecoveryEnabled) {
            lines.push({ kind: "notice_recovery", label: "Notice recovery", amount: 0, settleVia: "info", basis: { noticePeriodDays: notice.notice_period_days, servedDays: served, shortfallDays: shortfall }, warning: `Notice is short by ${shortfall} day(s) but notice recovery is not enabled in the settlement settings` });
          } else if (rate === null) {
            lines.push({ kind: "notice_recovery", label: "Notice recovery", amount: 0, settleVia: "info", basis: { shortfallDays: shortfall }, warning: monthly === null ? salaryProblem : "The daily-rate divisor is not set in the settlement settings" });
          } else {
            lines.push({
              kind: "notice_recovery", label: `Notice recovery (${shortfall} day${shortfall === 1 ? "" : "s"} short)`, amount: -r2(shortfall * rate), settleVia: "payslip",
              basis: { noticePeriodDays: notice.notice_period_days, noticeStartDate: iso(notice.notice_start_date), servedDays: served, shortfallDays: shortfall, monthlySalary: monthly, dailyRateDivisor: settings.dailyRateDivisor, dailyRate: r2(rate) },
            });
          }
        }
      }
    }

    // provident fund balances
    const accounts = await client.query("SELECT * FROM employee_scheme_accounts WHERE employee_id = $1 AND status = 'active' ORDER BY scheme_code", [s.employee_id]);
    for (const a of accounts.rows) {
      const def = await resolveScheme(client, s.company_id, a.scheme_code, lastDay);
      if (!def || def.schemeType !== "provident_fund") continue;
      const sums = await client.query(
        `SELECT COALESCE(SUM(e.amount), 0) AS balance,
                COALESCE(SUM(e.amount) FILTER (WHERE e.entry_type = 'employer_contribution' OR (e.entry_type = 'reversal' AND o.entry_type = 'employer_contribution')), 0) AS employer
           FROM employee_scheme_ledger e LEFT JOIN employee_scheme_ledger o ON o.id = e.reverses_entry_id WHERE e.account_id = $1`,
        [a.id]
      );
      const balance = Number(sums.rows[0].balance);
      const employer = Number(sums.rows[0].employer);
      if (balance <= 0) continue;
      const vest = def.parameters.employerVestingMonths;
      const forfeit = vest != null && months < vest ? Math.min(balance, Math.max(0, employer)) : 0;
      lines.push({
        kind: "provident_fund", label: `${def.name} balance paid out`, amount: r2(balance - forfeit), settleVia: "scheme_ledger", schemeCode: a.scheme_code,
        basis: { accountId: a.id, balance, employerShare: r2(employer), forfeitedEmployerShare: r2(forfeit), serviceMonths: months, employerVestingMonths: vest ?? null },
        warning: forfeit > 0 ? `Employer's share (${forfeit.toFixed(2)}) is not paid out: service is below the ${vest}-month vesting period` : null,
      });
    }

    // outstanding loans (recovered in full by the final run itself)
    const loans = await client.query(
      "SELECT id, loan_type, outstanding_balance FROM employee_loans WHERE employee_id = $1 AND status IN ('active', 'on_hold') AND outstanding_balance > 0 ORDER BY created_at",
      [s.employee_id]
    );
    if (loans.rowCount) {
      const total = r2(loans.rows.reduce((a, l) => a + Number(l.outstanding_balance), 0));
      lines.push({
        kind: "loan_outstanding", label: "Outstanding loans recovered in the final payroll run", amount: -total, settleVia: "run_result",
        basis: { estimate: true, loans: loans.rows.map((l) => ({ loanId: l.id, loanType: l.loan_type, outstanding: Number(l.outstanding_balance) })) },
      });
    }
    return lines;
  }

  // ------------------------------------------------------------------ payroll run hooks

  private async onRunFinalized(client: PoolClient, claims: RequestClaims, run: RunRow): Promise<void> {
    if (run.is_simulation || run.run_type !== "off_cycle" || run.off_cycle_reason !== "final_settlement" || !run.target_employee_id) return;
    const found = await client.query(
      "SELECT * FROM payroll_final_settlements WHERE employee_id = $1 AND status IN ('open', 'calculated', 'approved') ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
      [run.target_employee_id]
    );
    if (!found.rowCount) return;
    const s = found.rows[0];
    if (s.status === "calculated") throw new BadRequestException("This employee's final settlement is calculated but not approved; approve (or cancel) it before the final payroll run is finalised");
    const slip = await client.query("SELECT * FROM payslips WHERE payroll_run_id = $1 AND employee_id = $2 AND status <> 'voided' LIMIT 1", [run.id, run.target_employee_id]);
    const lines = await this.loadLines(client, s.id);
    const payslipLines = lines.filter((l) => l.settleVia === "payslip");
    const earnings = r2(payslipLines.filter((l) => l.amount > 0).reduce((a, l) => a + l.amount, 0));
    const deductions = r2(payslipLines.filter((l) => l.amount < 0).reduce((a, l) => a + l.amount, 0));
    const result: Record<string, unknown> = { payrollRunId: run.id, periodStart: iso(run.period_start), periodEnd: iso(run.period_end), hadCalculation: s.status === "approved" };

    // the estimate of the loans is replaced by what the run actually recovered
    await client.query("DELETE FROM payroll_final_settlement_lines WHERE settlement_id = $1 AND kind = 'loan_outstanding'", [s.id]);
    let n = (await client.query("SELECT COALESCE(MAX(line_no), 0) AS n FROM payroll_final_settlement_lines WHERE settlement_id = $1", [s.id])).rows[0].n as number;
    const add = async (kind: FinalSettlementLineKind, label: string, amount: number, basis: Record<string, unknown> = {}) => {
      n += 1;
      await client.query(
        "INSERT INTO payroll_final_settlement_lines (company_id, settlement_id, line_no, kind, label, amount, settle_via, basis) VALUES ($1, $2, $3, $4, $5, $6, 'run_result', $7::jsonb)",
        [s.company_id, s.id, n, kind, label, r2(amount), JSON.stringify(basis)]
      );
    };
    if (slip.rowCount) {
      const p = slip.rows[0];
      const loanTotal = r2(((p.loan_deductions ?? []) as Array<{ amount: number }>).reduce((a, l) => a + Number(l.amount), 0));
      const gross = Number(p.gross_pay);
      const tax = Number(p.income_tax_monthly);
      const net = Number(p.net_pay);
      const salaryDue = r2(gross - earnings);
      await add("salary_due", "Salary due up to the last working day", salaryDue, { payslipId: p.id, grossPay: gross });
      await add("tax_finalization", "Income tax finalised in the final payroll run", -tax, { payslipId: p.id, taxableAnnualIncome: Number(p.taxable_annual_income) });
      if (loanTotal !== 0) await add("loan_outstanding", "Outstanding loans recovered", -loanTotal, { payslipId: p.id, loans: p.loan_deductions });
      const plug = r2(net - (salaryDue + earnings + deductions - tax - loanTotal));
      if (Math.abs(plug) >= 0.005) await add("other_deductions", "Other payslip deductions and adjustments (statutory contributions, arrears, rounding)", plug, { payslipId: p.id });
      Object.assign(result, { payslipId: p.id, grossPay: gross, incomeTax: tax, loanRecovered: loanTotal, netPay: net, settlementEarnings: earnings, settlementDeductions: deductions });
    } else {
      result.note = "The employee has no payslip in this run";
    }

    // scheme balances paid out, leave encashed
    const final = await this.loadLines(client, s.id);
    for (const l of final.filter((x) => x.settleVia === "scheme_ledger" && x.amount > 0)) {
      const accountId = l.basis.accountId as string;
      await client.query(
        "INSERT INTO employee_scheme_ledger (company_id, account_id, entry_type, amount, entry_date, payroll_run_id, settlement_id, note, created_by) VALUES ($1, $2, 'payout', $3, CURRENT_DATE, $4, $5, $6, $7) ON CONFLICT DO NOTHING",
        [s.company_id, accountId, -l.amount, run.id, s.id, "Paid out in the final settlement", claims.sub]
      );
      await client.query("UPDATE employee_scheme_accounts SET status = 'closed', closed_on = CURRENT_DATE WHERE id = $1 AND (SELECT COALESCE(SUM(amount), 0) FROM employee_scheme_ledger WHERE account_id = $1) < 0.005", [accountId]);
    }
    const encash = final.find((x) => x.kind === "leave_encashment" && x.settleVia === "payslip");
    if (encash && this.leaveLedger) {
      for (const item of (encash.basis.items ?? []) as Array<{ leaveType: string; year: number; days: number }>) {
        await this.leaveLedger.post(client, {
          companyId: s.company_id, employeeId: s.employee_id, leaveType: item.leaveType, year: item.year, entryType: "encashment", days: -item.days,
          effectiveDate: iso(s.last_working_day), sourceType: "final_settlement", sourceId: s.id, sourceKey: `settlement:${s.id}:${item.leaveType}`, reason: "Encashed in the final settlement", createdBy: claims.sub,
        });
      }
    }
    await client.query(
      "UPDATE payroll_final_settlements SET status = 'finalized', payroll_run_id = $2, finalized_at = now(), result_snapshot = $3::jsonb, is_immutable = true, updated_at = now() WHERE id = $1",
      [s.id, run.id, JSON.stringify(result)]
    );
    await this.audit.record(client, claims, { companyId: run.company_id ?? null, action: "payroll_final_settlement.finalize", target: s.id, metadata: { employeeId: s.employee_id, payrollRunId: run.id, netPay: result.netPay ?? null } });
  }

  private async onRunReversed(client: PoolClient, claims: RequestClaims, run: RunRow): Promise<void> {
    const found = await client.query("SELECT * FROM payroll_final_settlements WHERE payroll_run_id = $1 AND status = 'finalized' FOR UPDATE", [run.id]);
    for (const s of found.rows) {
      const payouts = await client.query(
        `SELECT e.* FROM employee_scheme_ledger e WHERE e.settlement_id = $1 AND e.entry_type = 'payout' AND e.reverses_entry_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM employee_scheme_ledger r WHERE r.reverses_entry_id = e.id)`,
        [s.id]
      );
      for (const e of payouts.rows) {
        await this.schemes.insertReversal(client, s.company_id, e, claims.sub, "Final settlement reversed with its payroll run");
        await client.query("UPDATE employee_scheme_accounts SET status = 'active', closed_on = NULL WHERE id = $1", [e.account_id]);
      }
      const lines = await this.loadLines(client, s.id);
      const encash = lines.find((l) => l.kind === "leave_encashment" && l.settleVia === "payslip");
      if (encash && this.leaveLedger) {
        for (const item of (encash.basis.items ?? []) as Array<{ leaveType: string; year: number; days: number }>) {
          await this.leaveLedger.post(client, {
            companyId: s.company_id, employeeId: s.employee_id, leaveType: item.leaveType, year: item.year, entryType: "adjustment", days: item.days,
            effectiveDate: iso(s.last_working_day), sourceType: "final_settlement_reversal", sourceId: s.id, sourceKey: `settlement-reversal:${s.id}:${item.leaveType}`, reason: "Final settlement reversed with its payroll run", createdBy: claims.sub,
          });
        }
      }
      await client.query("UPDATE payroll_final_settlements SET status = 'reversed', updated_at = now() WHERE id = $1", [s.id]);
      await this.audit.record(client, claims, { companyId: s.company_id, action: "payroll_final_settlement.reverse", target: s.id, metadata: { payrollRunId: run.id, correlationId: randomUUID() } });
    }
  }

  // ------------------------------------------------------------------ helpers

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toView(row: any, lines: FinalSettlementLineView[]): FinalSettlementView {
    return {
      id: row.id,
      employeeId: row.employee_id,
      employeeNumber: row.employee_number,
      employeeName: row.employee_name,
      terminationEventId: row.termination_event_id,
      lastWorkingDay: iso(row.last_working_day),
      status: row.status,
      payrollRunId: row.payroll_run_id ?? null,
      calculationSequence: Number(row.calculation_sequence),
      calculatedBy: row.calculated_by ?? null,
      calculatedAt: row.calculated_at ? new Date(row.calculated_at).toISOString() : null,
      approvedBy: row.approved_by ?? null,
      approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
      finalizedAt: row.finalized_at ? new Date(row.finalized_at).toISOString() : null,
      isImmutable: !!row.is_immutable,
      cancelReason: row.cancel_reason ?? null,
      result: row.result_snapshot ?? null,
      lines,
    };
  }

  private async load(client: PoolClient, id: string, lock: boolean) {
    const r = await client.query(
      `SELECT s.*, e.employee_number, trim(e.first_name || ' ' || e.last_name) AS employee_name, e.payroll_area_id
         FROM payroll_final_settlements s JOIN employees e ON e.id = s.employee_id WHERE s.id = $1 ${lock ? "FOR UPDATE OF s" : ""}`,
      [id]
    );
    if (!r.rowCount) throw new NotFoundException("Final settlement not found");
    return r.rows[0];
  }

  private async loadLines(client: PoolClient, id: string): Promise<FinalSettlementLineView[]> {
    const r = await client.query("SELECT * FROM payroll_final_settlement_lines WHERE settlement_id = $1 ORDER BY line_no", [id]);
    return r.rows.map(rowToLine);
  }

  private assertScope(access: PayrollAreaAccess, s: { payroll_area_id?: string | null }): void {
    if (!isPayrollAreaInScope(access, s.payroll_area_id)) throw new ForbiddenException("This employee's payroll area is outside your data scope");
  }

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
  }

  private async requireCalculate(claims: RequestClaims): Promise<PayrollAreaAccess> {
    await this.requireModule(claims);
    const access = await resolvePayrollAreaAccess(this.db, this.rbac, claims, [CALCULATE_BASE]);
    if (!access) throw new ForbiddenException("Not permitted to prepare final settlements");
    return access;
  }

  /** Staff with a payroll permission see their scope; an approver sees all (null = unrestricted). */
  private async requireView(claims: RequestClaims): Promise<PayrollAreaAccess | null> {
    await this.requireModule(claims);
    const access = await resolvePayrollAreaAccess(this.db, this.rbac, claims, [CALCULATE_BASE, "payroll.finalize", "payroll.disburse"]);
    if (access) return access.unrestricted ? null : access;
    if (await this.rbac.can(claims, APPROVE_PERMISSION)) return null;
    throw new ForbiddenException("Not permitted to view final settlements");
  }
}
