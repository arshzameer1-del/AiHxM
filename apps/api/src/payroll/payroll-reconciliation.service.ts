import { randomUUID } from "node:crypto";
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { isPayrollAreaInScope, resolvePayrollAreaAccess } from "./payroll-area-access";
import type { PayrollReconciliationKind, PayrollReconciliationView } from "@aihxm/shared-types";

const MODULE_KEY = "payroll" as const;
const ALL_KINDS: PayrollReconciliationKind[] = ["calculation", "payroll", "payment", "bank", "accounting", "costing", "tax", "reversal"];
const VIEW_BASES = ["payroll.calculate", "payroll.finalize", "payroll.disburse"];
const RESOLVE_BASES = ["payroll.finalize", "payroll.disburse"];
const TOLERANCE = 0.005;

type Outcome = { status: "matched" | "variance" | "pending"; expected: number; actual: number; detail: Record<string, unknown> };
const r2 = (n: number) => Number(n.toFixed(2));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(row: any): PayrollReconciliationView {
  return {
    id: row.id,
    payrollRunId: row.payroll_run_id,
    kind: row.kind,
    sequence: Number(row.sequence),
    status: row.status,
    expectedAmount: Number(row.expected_amount),
    actualAmount: Number(row.actual_amount),
    variance: Number(row.variance),
    detail: row.detail ?? {},
    runBy: row.run_by ?? null,
    runAt: row.run_at instanceof Date ? row.run_at.toISOString() : String(row.run_at),
    resolvedBy: row.resolved_by ?? null,
    resolvedAt: row.resolved_at ? (row.resolved_at instanceof Date ? row.resolved_at.toISOString() : String(row.resolved_at)) : null,
    resolutionNote: row.resolution_note ?? null,
  };
}

/**
 * PAY-18 - reconciliations of a payroll run: the numbers a payroll produces are checked against each other and against
 * what happened to them afterwards, and every check is kept as a record.
 *
 *   calculation  the component lines of each payslip add up to its gross and net pay
 *   payroll      the totals stored on the run equal the live sum of its payslips
 *   tax          the income tax on each payslip equals its tax component lines
 *   payment      every payable payslip has exactly one live payment of exactly its net pay
 *   bank         what was sent to the bank equals what the bank acknowledged (awaiting / rejected are listed)
 *   reversal     a reversed run's payslips against its payments - money already paid out is flagged for recovery
 *   accounting   the posted journal against the payslips (net pay payable, expense, employer cost, balance)
 *   costing      gross pay plus employer cost against the costing results; unallocated cost is listed
 *   (both stay `pending` until the run has a journal / costing)
 *
 * Re-running a kind adds a new sequence; earlier results stay. A variance can be resolved - with a note - but the
 * numbers on the record never change, so a resolved variance still shows what the difference was.
 */
@Injectable()
export class PayrollReconciliationService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async list(claims: RequestClaims, runId: string): Promise<PayrollReconciliationView[]> {
    return this.db.withClaims(claims, async (client) => {
      await this.requireAccess(claims, client, runId, VIEW_BASES, "Not permitted to view payroll reconciliations");
      const r = await client.query("SELECT * FROM payroll_reconciliations WHERE payroll_run_id = $1 ORDER BY kind, sequence DESC", [runId]);
      return r.rows.map(toView);
    });
  }

  async run(claims: RequestClaims, runId: string, kinds?: PayrollReconciliationKind[]): Promise<PayrollReconciliationView[]> {
    if (kinds) {
      const bad = kinds.filter((k) => !ALL_KINDS.includes(k));
      if (bad.length) throw new BadRequestException(`Unknown reconciliation kind(s): ${bad.join(", ")}`);
    }
    return this.db.withClaims(claims, async (client) => {
      const run = await this.requireAccess(claims, client, runId, VIEW_BASES, "Not permitted to run payroll reconciliations");
      if (run.status === "draft" || run.status === "cancelled") throw new BadRequestException(`Payroll run is ${run.status}; there is nothing to reconcile yet`);
      const reversed = run.status === "reversed";
      const wanted = kinds ?? ALL_KINDS.filter((k) => k !== "reversal" || reversed);
      if (kinds?.includes("reversal") && !reversed) throw new BadRequestException("A reversal reconciliation applies to a reversed run only");
      const correlationId = randomUUID();
      const out: PayrollReconciliationView[] = [];
      for (const kind of wanted) {
        const outcome = await this.compute(client, run, kind);
        const variance = r2(outcome.expected - outcome.actual);
        const seq = await client.query("SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM payroll_reconciliations WHERE payroll_run_id = $1 AND kind = $2", [runId, kind]);
        const ins = await client.query(
          `INSERT INTO payroll_reconciliations (company_id, payroll_run_id, kind, sequence, status, expected_amount, actual_amount, variance, detail, run_by, correlation_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11) RETURNING *`,
          [claims.company_id, runId, kind, seq.rows[0].n, outcome.status, r2(outcome.expected), r2(outcome.actual), variance, JSON.stringify(outcome.detail), claims.sub, correlationId]
        );
        out.push(toView(ins.rows[0]));
      }
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_reconciliation.run",
        target: runId,
        metadata: { correlationId, results: out.map((o) => ({ kind: o.kind, status: o.status, variance: o.variance })) },
      });
      return out;
    });
  }

  /** Accepts a variance with a written explanation. Matched / pending results have nothing to resolve. */
  async resolve(claims: RequestClaims, reconciliationId: string, note: string): Promise<PayrollReconciliationView> {
    const text = note?.trim();
    if (!text || text.length < 3) throw new BadRequestException("A resolution note is required");
    return this.db.withClaims(claims, async (client) => {
      const cur = await client.query("SELECT * FROM payroll_reconciliations WHERE id = $1 FOR UPDATE", [reconciliationId]);
      if (!cur.rowCount) throw new NotFoundException("Reconciliation not found");
      await this.requireAccess(claims, client, cur.rows[0].payroll_run_id, RESOLVE_BASES, "Not permitted to resolve payroll reconciliations");
      if (cur.rows[0].status !== "variance") throw new BadRequestException(`Only a variance can be resolved (this one is ${cur.rows[0].status})`);
      const r = await client.query(
        "UPDATE payroll_reconciliations SET status = 'resolved', resolved_by = $2, resolved_at = now(), resolution_note = $3 WHERE id = $1 RETURNING *",
        [reconciliationId, claims.sub, text]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_reconciliation.resolve",
        target: reconciliationId,
        metadata: { kind: cur.rows[0].kind, variance: Number(cur.rows[0].variance), note: text },
      });
      return toView(r.rows[0]);
    });
  }

  // ------------------------------------------------------------------ computations

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async compute(client: PoolClient, run: any, kind: PayrollReconciliationKind): Promise<Outcome> {
    switch (kind) {
      case "calculation": return this.calculation(client, run.id);
      case "payroll": return this.payrollTotals(client, run);
      case "tax": return this.tax(client, run.id);
      case "payment": return this.payment(client, run.id);
      case "bank": return this.bank(client, run.id);
      case "reversal": return this.reversal(client, run.id);
      case "accounting": return this.accounting(client, run);
      case "costing": return this.costing(client, run);
      default:
        return { status: "pending", expected: 0, actual: 0, detail: { note: `Unknown reconciliation kind ${kind}` } };
    }
  }

  /**
   * PAY-17 - the posted journal against the payslips: net pay payable equals the sum of net pay, employer expense
   * equals employer cost, expense equals gross pay, and the journal balances. A reversed run must net to zero.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async accounting(client: PoolClient, run: any): Promise<Outcome> {
    const js = await client.query("SELECT id, status, journal_kind, journal_number, total_debit, total_credit FROM payroll_journals WHERE payroll_run_id = $1 AND status <> 'discarded'", [run.id]);
    if (!js.rowCount) return { status: "pending", expected: 0, actual: 0, detail: { note: "No journal has been generated for this run yet" } };
    const lines = await client.query(
      `SELECT l.line_kind, COALESCE(SUM(l.debit), 0) AS debit, COALESCE(SUM(l.credit), 0) AS credit
         FROM payroll_journal_lines l JOIN payroll_journals j ON j.id = l.journal_id
        WHERE j.payroll_run_id = $1 AND j.status IN ('posted', 'reversed') GROUP BY l.line_kind`,
      [run.id]
    );
    const net = (kind: string) => {
      const x = lines.rows.find((r) => r.line_kind === kind);
      return x ? Number(x.credit) - Number(x.debit) : 0;
    };
    if (run.status === "reversed") {
      const problems: unknown[] = [];
      const standing = r2(net("net_pay"));
      if (Math.abs(standing) >= TOLERANCE) problems.push({ issue: "net pay payable still stands after the reversal", amount: standing });
      if (js.rows.some((j) => j.status === "posted" && j.journal_kind === "run")) problems.push({ issue: "a run journal is still posted although the run was reversed" });
      return this.finish(0, standing, problems, { compared: "net posting of a reversed run (original journal plus its reversal)", journals: js.rowCount });
    }
    const live = js.rows.find((j) => j.journal_kind === "run" && j.status === "posted");
    if (!live) return { status: "pending", expected: 0, actual: 0, detail: { note: "A journal exists but has not been posted yet", journals: js.rows.map((j) => ({ number: j.journal_number, status: j.status })) } };
    const s = await client.query(
      `SELECT COALESCE(SUM(p.net_pay), 0) AS net, COALESCE(SUM(p.employer_cost - p.gross_pay), 0) AS employer FROM payslips p WHERE p.payroll_run_id = $1 AND p.status <> 'voided'`,
      [run.id]
    );
    const g = await client.query(
      `SELECT COALESCE(SUM(c.amount) FILTER (WHERE c.affects = 'gross' OR (c.affects = 'net' AND c.amount > 0)), 0) AS expense
         FROM payroll_component_results c JOIN payslips p ON p.id = c.payslip_id WHERE p.payroll_run_id = $1 AND p.status <> 'voided'`,
      [run.id]
    );
    const problems: unknown[] = [];
    const expected = r2(Number(s.rows[0].net));
    const actual = r2(net("net_pay"));
    const employerPosted = r2(-net("employer_expense"));
    if (Math.abs(employerPosted - Number(s.rows[0].employer)) >= TOLERANCE) problems.push({ issue: "employer expense differs from employer contributions", payslips: r2(Number(s.rows[0].employer)), journal: employerPosted });
    const expensePosted = r2(-net("expense"));
    if (Math.abs(expensePosted - Number(g.rows[0].expense)) >= TOLERANCE) problems.push({ issue: "expense differs from gross pay", payslips: r2(Number(g.rows[0].expense)), journal: expensePosted });
    if (Math.abs(Number(live.total_debit) - Number(live.total_credit)) >= TOLERANCE) problems.push({ issue: "the journal does not balance", debit: Number(live.total_debit), credit: Number(live.total_credit) });
    return this.finish(expected, actual, problems, { journalNumber: live.journal_number, compared: "net pay payable in the posted journal vs net pay of the payslips (plus expense, employer cost and balance checks)" });
  }

  /** PAY-17 - the costing results against the payslips: the whole cost to the employer, in total. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async costing(client: PoolClient, run: any): Promise<Outcome> {
    const any = await client.query("SELECT COUNT(*)::int AS n FROM payroll_costing_results WHERE payroll_run_id = $1", [run.id]);
    if (!any.rows[0].n) return { status: "pending", expected: 0, actual: 0, detail: { note: "No costing has been generated for this run yet" } };
    const s = await client.query(
      "SELECT COALESCE(SUM(employer_cost), 0) AS total FROM payslips WHERE payroll_run_id = $1 AND status <> 'voided'",
      [run.id]
    );
    const c = await client.query(
      `SELECT COALESCE(SUM(total_cost), 0) AS total, COALESCE(SUM(total_cost) FILTER (WHERE cost_center_id IS NULL), 0) AS unallocated, COUNT(*) FILTER (WHERE status = 'draft')::int AS drafts
         FROM payroll_costing_results WHERE payroll_run_id = $1 AND status IN ('draft', 'final')`,
      [run.id]
    );
    const problems: unknown[] = [];
    if (c.rows[0].drafts > 0) problems.push({ issue: "costing is still a draft (its journal is not posted)", rows: c.rows[0].drafts });
    // cost without a cost centre is information (a tenant may not use cost centres), not a difference
    return this.finish(r2(Number(s.rows[0].total)), r2(Number(c.rows[0].total)), problems, { unallocatedCost: r2(Number(c.rows[0].unallocated)), compared: "the cost to the employer on the payslips (gross pay plus employer contributions) vs the total cost in the costing results" });
  }

  private finish(expected: number, actual: number, problems: unknown[], detail: Record<string, unknown>): Outcome {
    const off = Math.abs(expected - actual) >= TOLERANCE || problems.length > 0;
    return { status: off ? "variance" : "matched", expected, actual, detail: { ...detail, differences: problems } };
  }

  private async calculation(client: PoolClient, runId: string): Promise<Outcome> {
    const r = await client.query(
      `SELECT p.id, p.employee_number, p.gross_pay, p.net_pay,
              COUNT(c.id) AS lines,
              COALESCE(SUM(c.amount) FILTER (WHERE c.affects = 'gross'), 0) AS gross_lines,
              COALESCE(SUM(c.amount) FILTER (WHERE c.affects IN ('gross', 'net')), 0) AS net_lines
         FROM payslips p LEFT JOIN payroll_component_results c ON c.payslip_id = p.id
        WHERE p.payroll_run_id = $1 AND p.status <> 'voided'
        GROUP BY p.id ORDER BY p.employee_number`,
      [runId]
    );
    let expected = 0;
    let actual = 0;
    let withoutLines = 0;
    const problems: unknown[] = [];
    for (const row of r.rows) {
      if (Number(row.lines) === 0) { withoutLines += 1; continue; }
      expected += Number(row.net_pay);
      actual += Number(row.net_lines);
      const grossGap = r2(Number(row.gross_pay) - Number(row.gross_lines));
      const netGap = r2(Number(row.net_pay) - Number(row.net_lines));
      if (Math.abs(grossGap) >= TOLERANCE || Math.abs(netGap) >= TOLERANCE) problems.push({ employeeNumber: row.employee_number, payslipId: row.id, grossGap, netGap });
    }
    return this.finish(r2(expected), r2(actual), problems, { payslips: r.rowCount, withoutComponentLines: withoutLines, compared: "net pay on the payslip vs the sum of its gross and net component lines" });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async payrollTotals(client: PoolClient, run: any): Promise<Outcome> {
    const s = await client.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(gross_pay), 0) AS gross, COALESCE(SUM(net_pay), 0) AS net, COALESCE(SUM(income_tax_monthly), 0) AS tax
         FROM payslips WHERE payroll_run_id = $1 AND status <> 'voided'`,
      [run.id]
    );
    if (run.total_net === null || run.total_net === undefined) {
      return { status: "pending", expected: 0, actual: r2(Number(s.rows[0].net)), detail: { note: "The run has no stored totals yet (it has not been calculated)" } };
    }
    const problems: unknown[] = [];
    const pairs: Array<[string, number | null, number]> = [
      ["gross", run.total_gross, Number(s.rows[0].gross)],
      ["net", run.total_net, Number(s.rows[0].net)],
      ["incomeTax", run.total_income_tax, Number(s.rows[0].tax)],
    ];
    for (const [field, stored, live] of pairs) {
      if (stored !== null && Math.abs(Number(stored) - live) >= TOLERANCE) problems.push({ field, stored: Number(stored), live: r2(live) });
    }
    return this.finish(Number(run.total_net), r2(Number(s.rows[0].net)), problems, { payslips: s.rows[0].n, compared: "totals stored on the run vs the live sum of its payslips" });
  }

  private async tax(client: PoolClient, runId: string): Promise<Outcome> {
    const r = await client.query(
      `SELECT p.id, p.employee_number, p.income_tax_monthly, COUNT(c.id) AS lines, COALESCE(SUM(-c.amount) FILTER (WHERE c.category = 'tax'), 0) AS tax_lines
         FROM payslips p LEFT JOIN payroll_component_results c ON c.payslip_id = p.id
        WHERE p.payroll_run_id = $1 AND p.status <> 'voided'
        GROUP BY p.id ORDER BY p.employee_number`,
      [runId]
    );
    let expected = 0;
    let actual = 0;
    let withoutLines = 0;
    const problems: unknown[] = [];
    for (const row of r.rows) {
      if (Number(row.lines) === 0) { withoutLines += 1; continue; }
      expected += Number(row.income_tax_monthly);
      actual += Number(row.tax_lines);
      const gap = r2(Number(row.income_tax_monthly) - Number(row.tax_lines));
      if (Math.abs(gap) >= TOLERANCE) problems.push({ employeeNumber: row.employee_number, payslipId: row.id, gap });
    }
    return this.finish(r2(expected), r2(actual), problems, { payslips: r.rowCount, withoutComponentLines: withoutLines, compared: "income tax on the payslip vs its tax component lines" });
  }

  private async payment(client: PoolClient, runId: string): Promise<Outcome> {
    const batches = await client.query("SELECT COUNT(*)::int AS n FROM payroll_payment_batches WHERE payroll_run_id = $1 AND status <> 'voided'", [runId]);
    const slips = await client.query("SELECT id, employee_number, net_pay FROM payslips WHERE payroll_run_id = $1 AND status <> 'voided' AND net_pay > 0", [runId]);
    const live = await client.query(
      "SELECT payslip_id, employee_number, amount FROM payroll_payment_items WHERE payroll_run_id = $1 AND status IN ('generated', 'released', 'acknowledged')",
      [runId]
    );
    const expected = r2(slips.rows.reduce((a, s) => a + Number(s.net_pay), 0));
    if (!batches.rows[0].n) return { status: "pending", expected, actual: 0, detail: { note: "No payment file has been generated for this run yet" } };
    const byPayslip = new Map<string, { amount: number; count: number }>();
    for (const i of live.rows) {
      const cur = byPayslip.get(i.payslip_id) ?? { amount: 0, count: 0 };
      byPayslip.set(i.payslip_id, { amount: cur.amount + Number(i.amount), count: cur.count + 1 });
    }
    const problems: unknown[] = [];
    for (const s of slips.rows) {
      const p = byPayslip.get(s.id);
      if (!p) problems.push({ employeeNumber: s.employee_number, issue: "no live payment", netPay: Number(s.net_pay) });
      else if (p.count > 1) problems.push({ employeeNumber: s.employee_number, issue: "more than one live payment", count: p.count });
      else if (Math.abs(p.amount - Number(s.net_pay)) >= TOLERANCE) problems.push({ employeeNumber: s.employee_number, issue: "amount differs", netPay: Number(s.net_pay), paid: p.amount });
    }
    const actual = r2(live.rows.reduce((a, i) => a + Number(i.amount), 0));
    return this.finish(expected, actual, problems, { payslipsWithNetPay: slips.rowCount, livePayments: live.rowCount, compared: "net pay of every payable payslip vs its live payment" });
  }

  private async bank(client: PoolClient, runId: string): Promise<Outcome> {
    const r = await client.query(
      `SELECT status, COUNT(*)::int AS n, COALESCE(SUM(amount), 0) AS total FROM payroll_payment_items
        WHERE payroll_run_id = $1 AND status IN ('released', 'acknowledged', 'rejected') GROUP BY status`,
      [runId]
    );
    const by = new Map(r.rows.map((x) => [x.status as string, { n: x.n as number, total: Number(x.total) }]));
    const sent = r2([...by.values()].reduce((a, x) => a + x.total, 0));
    if (by.size === 0) return { status: "pending", expected: 0, actual: 0, detail: { note: "No payment has been released to the bank yet" } };
    const acknowledged = r2(by.get("acknowledged")?.total ?? 0);
    const problems: unknown[] = [];
    if (by.get("released")) problems.push({ issue: "awaiting the bank's answer", payments: by.get("released")!.n, amount: r2(by.get("released")!.total) });
    if (by.get("rejected")) problems.push({ issue: "rejected by the bank", payments: by.get("rejected")!.n, amount: r2(by.get("rejected")!.total) });
    return this.finish(sent, acknowledged, problems, { compared: "payments sent to the bank vs payments the bank acknowledged" });
  }

  private async reversal(client: PoolClient, runId: string): Promise<Outcome> {
    const slips = await client.query("SELECT COALESCE(SUM(net_pay), 0) AS net, COUNT(*)::int AS n FROM payslips WHERE payroll_run_id = $1 AND status = 'voided'", [runId]);
    const items = await client.query(
      "SELECT status, COUNT(*)::int AS n, COALESCE(SUM(amount), 0) AS total FROM payroll_payment_items WHERE payroll_run_id = $1 GROUP BY status",
      [runId]
    );
    const by = new Map(items.rows.map((x) => [x.status as string, Number(x.total)]));
    const paidOut = r2(by.get("acknowledged") ?? 0);
    const problems: unknown[] = [];
    if (paidOut > 0) problems.push({ issue: "already paid to employees before the reversal - to be recovered or settled in the corrective run", amount: paidOut });
    // expected: the reversed run leaves no payment standing; actual: what still stands
    return this.finish(0, paidOut, problems, { reversedPayslips: slips.rows[0].n, reversedNetPay: r2(Number(slips.rows[0].net)), voidedPayments: r2(by.get("voided") ?? 0), compared: "payments still standing after the reversal" });
  }

  // ------------------------------------------------------------------ access

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async requireAccess(claims: RequestClaims, client: PoolClient, runId: string, bases: string[], message: string): Promise<any> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const access = await resolvePayrollAreaAccess(this.db, this.rbac, claims, bases);
    const approver = bases === VIEW_BASES && (await this.rbac.can(claims, "payroll.approve.all"));
    if (!access && !approver) throw new ForbiddenException(message);
    const run = await client.query("SELECT * FROM payroll_runs WHERE id = $1", [runId]);
    if (!run.rowCount) throw new NotFoundException("Payroll run not found");
    if (access && !isPayrollAreaInScope(access, run.rows[0].payroll_area_id)) {
      throw access.unrestricted ? new NotFoundException("Payroll run not found") : new ForbiddenException("This payroll run is outside your payroll area scope");
    }
    return run.rows[0];
  }
}
