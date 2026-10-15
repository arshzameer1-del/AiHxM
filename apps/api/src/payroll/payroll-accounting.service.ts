import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { currentCorrelationId } from "../common/request-context";
import { isPayrollAreaInScope, resolvePayrollAreaAccess } from "./payroll-area-access";
import { PayrollRunControlService } from "./payroll-run-control.service";
import { payrollRunHooks, type RunRow } from "./payroll-run-hooks";
import { publishPostingStatusChanged } from "./payroll-events";
import type {
  GeneratePayrollJournalRequest,
  PayrollAccountingPreviewView,
  PayrollCostingRowView,
  PayrollCostingSummaryView,
  PayrollGlMappingView,
  PayrollJournalLineKind,
  PayrollJournalLineView,
  PayrollJournalPurpose,
  PayrollJournalTypeView,
  PayrollJournalView,
  PostPayrollJournalRequest,
  UpdatePayrollJournalTypeRequest,
  UpsertPayrollGlMappingRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "payroll" as const;
const CONFIG_PERMISSION = "payroll.calculate.all";
const ACT_BASE = "payroll.finalize";
const VIEW_BASES = ["payroll.calculate", "payroll.finalize", "payroll.disburse"];
/** Run states in which a journal may be generated or posted (a closed run is reopened first, a reversed one has nothing to post). */
const POSTABLE_RUN_STATUSES = ["finalized", "accounting", "payment_released", "reconciled", "reopened"];
const NET_PAY_SPECIAL = "net_pay_payable";
const SPECIAL_KEYS = [NET_PAY_SPECIAL];

/** Journal types exist from the first use; the codes and prefixes are labels the tenant may rename, not accounting figures. */
const BUILT_IN_TYPES: Array<{ purpose: PayrollJournalPurpose; code: string; name: string; prefix: string }> = [
  { purpose: "payroll_run", code: "PAYROLL", name: "Payroll run journal", prefix: "PJ" },
  { purpose: "final_settlement", code: "SETTLEMENT", name: "Final settlement journal", prefix: "SJ" },
  { purpose: "reversal", code: "REVERSAL", name: "Payroll reversal journal", prefix: "RJ" },
];

const cents = (n: number | string) => Math.round(Number(n) * 100);
const fromCents = (c: number) => Number((c / 100).toFixed(2));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const day = (v: any): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const iso = (v: any): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));

/** Splits a cent amount by weights; the remainder goes to the largest shares so the parts add up exactly. */
export function splitCents(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const raw = weights.map((w) => (total * w) / sum);
  const parts = raw.map((r) => Math.trunc(r));
  let rest = total - parts.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: Math.abs(r - Math.trunc(r)) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  const step = rest > 0 ? 1 : -1;
  for (let k = 0; rest !== 0; k = (k + 1) % order.length) {
    parts[order[k].i] += step;
    rest -= step;
  }
  return parts;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toMapping(r: any): PayrollGlMappingView {
  return {
    id: r.id,
    matchType: r.match_type,
    matchValue: r.match_value,
    debitAccountCode: r.debit_account_code ?? null,
    creditAccountCode: r.credit_account_code ?? null,
    description: r.description ?? null,
    isActive: !!r.is_active,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toType(r: any): PayrollJournalTypeView {
  return { id: r.id, code: r.code, name: r.name, purpose: r.purpose, numberPrefix: r.number_prefix, nextNumber: Number(r.next_number), isActive: !!r.is_active };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toJournal(r: any, typeCode: string, lines?: PayrollJournalLineView[]): PayrollJournalView {
  return {
    id: r.id,
    payrollRunId: r.payroll_run_id,
    journalKind: r.journal_kind,
    journalTypeCode: typeCode,
    journalNumber: r.journal_number ?? null,
    status: r.status,
    reversesJournalId: r.reverses_journal_id ?? null,
    postingDate: day(r.posting_date),
    currencyCode: r.currency_code,
    totalDebit: Number(r.total_debit),
    totalCredit: Number(r.total_credit),
    lineCount: Number(r.line_count),
    postingReference: r.posting_reference ?? null,
    notes: r.notes ?? null,
    generatedAt: iso(r.generated_at) as string,
    postedAt: iso(r.posted_at),
    reversedAt: iso(r.reversed_at),
    ...(lines ? { lines } : {}),
  };
}

type Share = { costCenterId: string | null; costCenterCode: string | null; profitCenterId: string | null; profitCenterCode: string | null; weight: number; source: "allocation" | "position" | "unallocated" };
type BuiltLine = {
  accountCode: string;
  signed: number; // cents, debit positive
  kind: PayrollJournalLineKind;
  componentKey: string | null;
  description: string;
  costCenterId: string | null;
  profitCenterId: string | null;
};
type Built = {
  lines: BuiltLine[];
  costing: Array<{ payslipId: string; employeeId: string; employeeNumber: string; share: Share; pct: number; gross: number; employer: number }>;
  unmapped: Map<string, { key: string; category: string; affects: string; label: string }>;
  missingSpecial: string[];
  unallocatedEmployees: number;
  totalDebit: number;
  totalCredit: number;
};

/**
 * PAY-17 - from a finalised run to the books: a balanced double-entry journal built from the payslip component lines,
 * with the cost and profit centre of every expense line, and a costing result per employee and cost centre.
 *
 *   expense side   earnings (gross lines) debit the account mapped to the component; reductions of gross credit it;
 *                  employer contributions debit their expense account and credit their liability account
 *   liability side deductions taken from net pay credit the account mapped to the component
 *   net pay        one credit to the mapped `net_pay_payable` account, so debits and credits always balance
 *
 * Account codes are the tenant's own (mapping by component key, falling back to the category, then to the component's
 * GL code); nothing is shipped. A key without an account blocks generation and is listed - nothing is guessed.
 * A journal is a draft until posted; posting numbers it, freezes it and its costing, and moves the run to `accounting`.
 * A run reversal reverses a posted journal with a mirror journal of its own.
 */
@Injectable()
export class PayrollAccountingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly control: PayrollRunControlService
  ) {
    payrollRunHooks.register("payroll-accounting", {
      onReversed: (client, claims, run) => this.onRunReversed(client, claims, run),
    });
  }

  // ------------------------------------------------------------------ configuration

  async listMappings(claims: RequestClaims): Promise<PayrollGlMappingView[]> {
    await this.requireModule(claims);
    if (!(await this.canView(claims))) throw new ForbiddenException("Not permitted to view payroll GL mappings");
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT * FROM payroll_gl_mappings ORDER BY match_type, match_value");
      return r.rows.map(toMapping);
    });
  }

  async upsertMapping(claims: RequestClaims, input: UpsertPayrollGlMappingRequest): Promise<PayrollGlMappingView> {
    await this.requirePermission(claims, CONFIG_PERMISSION, "Not permitted to configure payroll GL mappings");
    const value = input.matchValue?.trim();
    if (!value) throw new BadRequestException("A match value is required");
    if (input.matchType === "special" && !SPECIAL_KEYS.includes(value)) throw new BadRequestException(`Unknown special mapping "${value}" (known: ${SPECIAL_KEYS.join(", ")})`);
    const debit = input.debitAccountCode?.trim() || null;
    const credit = input.creditAccountCode?.trim() || null;
    if (!debit && !credit) throw new BadRequestException("A debit or a credit account code is required");
    if (input.matchType === "special" && !credit) throw new BadRequestException("The net pay payable mapping needs a credit account code");
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `INSERT INTO payroll_gl_mappings (company_id, match_type, match_value, debit_account_code, credit_account_code, description, is_active, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (company_id, match_type, match_value) DO UPDATE
           SET debit_account_code = EXCLUDED.debit_account_code, credit_account_code = EXCLUDED.credit_account_code,
               description = EXCLUDED.description, is_active = EXCLUDED.is_active, updated_at = now()
         RETURNING *`,
        [claims.company_id, input.matchType, value, debit, credit, input.description?.trim() || null, input.isActive ?? true, claims.sub]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_gl_mapping.upsert",
        target: r.rows[0].id,
        metadata: { matchType: input.matchType, matchValue: value, debit, credit },
      });
      return toMapping(r.rows[0]);
    });
  }

  async deleteMapping(claims: RequestClaims, id: string): Promise<{ deleted: true }> {
    await this.requirePermission(claims, CONFIG_PERMISSION, "Not permitted to configure payroll GL mappings");
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("DELETE FROM payroll_gl_mappings WHERE id = $1 RETURNING match_type, match_value", [id]);
      if (!r.rowCount) throw new NotFoundException("Mapping not found");
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_gl_mapping.delete",
        target: id,
        metadata: { matchType: r.rows[0].match_type, matchValue: r.rows[0].match_value },
      });
      return { deleted: true as const };
    });
  }

  async listJournalTypes(claims: RequestClaims): Promise<PayrollJournalTypeView[]> {
    await this.requireModule(claims);
    if (!(await this.canView(claims))) throw new ForbiddenException("Not permitted to view payroll journal types");
    return this.db.withClaims(claims, async (client) => {
      await this.ensureTypes(client, claims.company_id!);
      const r = await client.query("SELECT * FROM payroll_journal_types ORDER BY purpose");
      return r.rows.map(toType);
    });
  }

  async updateJournalType(claims: RequestClaims, id: string, input: UpdatePayrollJournalTypeRequest): Promise<PayrollJournalTypeView> {
    await this.requirePermission(claims, CONFIG_PERMISSION, "Not permitted to configure payroll journal types");
    const prefix = input.numberPrefix?.trim();
    if (input.numberPrefix !== undefined && (!prefix || !/^[A-Za-z0-9_-]{1,12}$/.test(prefix))) throw new BadRequestException("The number prefix must be 1-12 letters, digits, dashes or underscores");
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `UPDATE payroll_journal_types SET name = COALESCE($2, name), number_prefix = COALESCE($3, number_prefix), is_active = COALESCE($4, is_active), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, input.name?.trim() || null, prefix ?? null, input.isActive ?? null]
      );
      if (!r.rowCount) throw new NotFoundException("Journal type not found");
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_journal_type.update", target: id, metadata: { ...input } });
      return toType(r.rows[0]);
    });
  }

  // ------------------------------------------------------------------ preview / generate / post

  async preview(claims: RequestClaims, runId: string): Promise<PayrollAccountingPreviewView> {
    return this.db.withClaims(claims, async (client) => {
      const run = await this.requireRunAccess(claims, client, runId, VIEW_BASES, "Not permitted to view payroll accounting");
      const built = await this.build(client, run);
      return {
        payrollRunId: runId,
        unmappedKeys: [...built.unmapped.values()],
        missingSpecial: built.missingSpecial,
        unallocatedEmployees: built.unallocatedEmployees,
        totalDebit: built.totalDebit,
        totalCredit: built.totalCredit,
        ready: built.unmapped.size === 0 && built.missingSpecial.length === 0,
      };
    });
  }

  async generate(claims: RequestClaims, runId: string, input: GeneratePayrollJournalRequest = {}): Promise<PayrollJournalView> {
    return this.db.withClaims(claims, async (client) => {
      const run = await this.requireRunAccess(claims, client, runId, [ACT_BASE], "Not permitted to generate payroll journals");
      if (!POSTABLE_RUN_STATUSES.includes(run.status)) throw new BadRequestException(`Payroll run is ${run.status}; a journal can be generated once it is finalised (and until it is closed)`);
      const posted = await client.query("SELECT 1 FROM payroll_journals WHERE payroll_run_id = $1 AND journal_kind = 'run' AND status = 'posted'", [runId]);
      if (posted.rowCount) throw new ConflictException("This run already has a posted journal; reverse that posting before generating a new journal");
      const built = await this.build(client, run);
      if (built.unmapped.size || built.missingSpecial.length) {
        const parts: string[] = [];
        if (built.unmapped.size) parts.push(`no GL account for: ${[...built.unmapped.values()].map((u) => u.key).join(", ")}`);
        if (built.missingSpecial.length) parts.push(`missing mapping: ${built.missingSpecial.join(", ")}`);
        throw new BadRequestException(`The journal cannot be generated - ${parts.join("; ")}. Add them under GL mappings.`);
      }
      if (built.lines.length === 0) throw new BadRequestException("This run has nothing to post");
      const postingDate = input.postingDate ?? day(run.period_end);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(postingDate)) throw new BadRequestException("postingDate must be YYYY-MM-DD");

      await this.ensureTypes(client, claims.company_id!);
      const purpose: PayrollJournalPurpose = run.off_cycle_reason === "final_settlement" ? "final_settlement" : "payroll_run";
      const type = (await client.query("SELECT * FROM payroll_journal_types WHERE purpose = $1", [purpose])).rows[0];
      if (!type.is_active) throw new BadRequestException(`The ${type.code} journal type is inactive`);

      // a draft is replaced, never edited in place
      const old = await client.query("SELECT * FROM payroll_journals WHERE payroll_run_id = $1 AND journal_kind = 'run' AND status = 'draft'", [runId]);
      for (const d of old.rows) {
        await client.query("DELETE FROM payroll_journal_lines WHERE journal_id = $1", [d.id]);
        await client.query("DELETE FROM payroll_costing_results WHERE journal_id = $1 AND status = 'draft'", [d.id]);
        const gone = await client.query("UPDATE payroll_journals SET status = 'discarded', line_count = 0, total_debit = 0, total_credit = 0 WHERE id = $1 RETURNING *", [d.id]);
        await publishPostingStatusChanged(client, claims, gone.rows[0], "draft");
      }
      await client.query("DELETE FROM payroll_costing_results WHERE payroll_run_id = $1 AND status = 'draft'", [runId]);

      const correlationId = currentCorrelationId();
      const j = await client.query(
        `INSERT INTO payroll_journals (company_id, payroll_run_id, journal_type_id, journal_kind, status, posting_date, currency_code, total_debit, total_credit, line_count, notes, generated_by, correlation_id)
         VALUES ($1, $2, $3, 'run', 'draft', $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [claims.company_id, runId, type.id, postingDate, run.currency_code ?? "PKR", built.totalDebit, built.totalCredit, built.lines.length, input.notes?.trim() || null, claims.sub, correlationId]
      );
      await this.insertLines(client, claims.company_id!, j.rows[0].id, built.lines);
      await this.insertCosting(client, claims.company_id!, runId, j.rows[0].id, built);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_journal.generate",
        target: j.rows[0].id,
        metadata: { runId, lines: built.lines.length, totalDebit: built.totalDebit, unallocatedEmployees: built.unallocatedEmployees, replacedDrafts: old.rowCount ?? 0 },
      });
      await publishPostingStatusChanged(client, claims, j.rows[0], null);
      return this.loadJournal(client, j.rows[0].id, true);
    });
  }

  async discard(claims: RequestClaims, journalId: string): Promise<PayrollJournalView> {
    return this.db.withClaims(claims, async (client) => {
      const j = await this.lockJournal(client, journalId);
      await this.requireRunAccess(claims, client, j.payroll_run_id, [ACT_BASE], "Not permitted to discard payroll journals");
      if (j.status !== "draft") throw new BadRequestException(`Only a draft journal can be discarded (this one is ${j.status})`);
      await client.query("DELETE FROM payroll_journal_lines WHERE journal_id = $1", [journalId]);
      await client.query("DELETE FROM payroll_costing_results WHERE journal_id = $1 AND status = 'draft'", [journalId]);
      const r = await client.query("UPDATE payroll_journals SET status = 'discarded', line_count = 0, total_debit = 0, total_credit = 0 WHERE id = $1 RETURNING *", [journalId]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_journal.discard", target: journalId, metadata: { runId: j.payroll_run_id } });
      await publishPostingStatusChanged(client, claims, r.rows[0], "draft");
      return this.loadJournal(client, journalId, false);
    });
  }

  async post(claims: RequestClaims, journalId: string, input: PostPayrollJournalRequest = {}): Promise<PayrollJournalView> {
    return this.db.withClaims(claims, async (client) => {
      const j = await this.lockJournal(client, journalId);
      const run = await this.requireRunAccess(claims, client, j.payroll_run_id, [ACT_BASE], "Not permitted to post payroll journals");
      if (j.status !== "draft") throw new BadRequestException(`Only a draft journal can be posted (this one is ${j.status})`);
      if (!POSTABLE_RUN_STATUSES.includes(run.status)) throw new BadRequestException(`Payroll run is ${run.status}; its journal can no longer be posted`);
      if (Number(j.total_debit) !== Number(j.total_credit)) throw new BadRequestException("The journal does not balance");
      const number = await this.nextNumber(client, j.journal_type_id, j.posting_date);
      const r = await client.query(
        `UPDATE payroll_journals SET status = 'posted', journal_number = $2, posted_by = $3, posted_at = now(), posting_reference = $4 WHERE id = $1 RETURNING *`,
        [journalId, number, claims.sub, input.postingReference?.trim() || null]
      );
      await client.query("UPDATE payroll_costing_results SET status = 'final' WHERE journal_id = $1 AND status = 'draft'", [journalId]);
      if (["finalized", "reopened"].includes(run.status)) {
        await this.control.transition(client, claims, run.id, "accounting", { action: "post_journal", metadata: { journalNumber: number } });
      }
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_journal.post",
        target: journalId,
        metadata: { runId: run.id, journalNumber: number, totalDebit: Number(j.total_debit), postingReference: input.postingReference ?? null },
      });
      await publishPostingStatusChanged(client, claims, r.rows[0], "draft");
      return this.loadJournal(client, journalId, true);
    });
  }

  /** Reverses a posted journal with a mirror journal; the original is marked reversed and its costing superseded. */
  async reversePosting(claims: RequestClaims, journalId: string, reason: string): Promise<PayrollJournalView> {
    const why = reason?.trim();
    if (!why || why.length < 3) throw new BadRequestException("A reason is required to reverse a posted journal");
    return this.db.withClaims(claims, async (client) => {
      const j = await this.lockJournal(client, journalId);
      const run = await this.requireRunAccess(claims, client, j.payroll_run_id, [ACT_BASE], "Not permitted to reverse payroll journals");
      if (j.journal_kind !== "run" || j.status !== "posted") throw new BadRequestException("Only a posted payroll journal can be reversed");
      if (run.status === "closed") throw new BadRequestException("Payroll run is closed; reopen it before reversing its posting");
      const mirror = await this.reverseJournal(client, claims, j, why);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_journal.reverse",
        target: journalId,
        metadata: { runId: run.id, reversalJournalId: mirror, reason: why },
      });
      return this.loadJournal(client, journalId, true);
    });
  }

  async listJournals(claims: RequestClaims, runId: string): Promise<PayrollJournalView[]> {
    return this.db.withClaims(claims, async (client) => {
      await this.requireRunAccess(claims, client, runId, VIEW_BASES, "Not permitted to view payroll journals");
      const r = await client.query(
        `SELECT j.*, t.code AS type_code FROM payroll_journals j JOIN payroll_journal_types t ON t.id = j.journal_type_id
          WHERE j.payroll_run_id = $1 ORDER BY j.generated_at DESC, j.id`,
        [runId]
      );
      return r.rows.map((row) => toJournal(row, row.type_code));
    });
  }

  async getJournal(claims: RequestClaims, journalId: string): Promise<PayrollJournalView> {
    return this.db.withClaims(claims, async (client) => {
      const j = await client.query("SELECT payroll_run_id FROM payroll_journals WHERE id = $1", [journalId]);
      if (!j.rowCount) throw new NotFoundException("Journal not found");
      await this.requireRunAccess(claims, client, j.rows[0].payroll_run_id, VIEW_BASES, "Not permitted to view payroll journals");
      return this.loadJournal(client, journalId, true);
    });
  }

  async journalCsv(claims: RequestClaims, journalId: string): Promise<string> {
    const j = await this.getJournal(claims, journalId);
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [["journal_number", "posting_date", "line_no", "account_code", "debit", "credit", "component_key", "cost_center", "profit_center", "description"]];
    for (const l of j.lines ?? []) {
      rows.push([j.journalNumber ?? "DRAFT", j.postingDate, String(l.lineNo), l.accountCode, l.debit.toFixed(2), l.credit.toFixed(2), l.componentKey ?? "", l.costCenterCode ?? "", l.profitCenterCode ?? "", l.description ?? ""]);
    }
    return rows.map((r) => r.map(esc).join(",")).join("\n") + "\n";
  }

  // ------------------------------------------------------------------ costing

  async costing(claims: RequestClaims, runId: string): Promise<PayrollCostingSummaryView> {
    return this.db.withClaims(claims, async (client) => {
      await this.requireRunAccess(claims, client, runId, VIEW_BASES, "Not permitted to view payroll costing");
      const r = await client.query(
        `SELECT c.*, p.employee_number, cc.code AS cc_code, pc.code AS pc_code
           FROM payroll_costing_results c
           JOIN payslips p ON p.id = c.payslip_id
           LEFT JOIN cost_centers cc ON cc.id = c.cost_center_id
           LEFT JOIN profit_centers pc ON pc.id = c.profit_center_id
          WHERE c.payroll_run_id = $1 AND c.status IN ('draft', 'final')
          ORDER BY p.employee_number, cc.code NULLS LAST`,
        [runId]
      );
      const rows: PayrollCostingRowView[] = r.rows.map((x) => ({
        payslipId: x.payslip_id,
        employeeId: x.employee_id,
        employeeNumber: x.employee_number,
        costCenterId: x.cost_center_id ?? null,
        costCenterCode: x.cc_code ?? null,
        profitCenterId: x.profit_center_id ?? null,
        profitCenterCode: x.pc_code ?? null,
        allocationPercentage: Number(x.allocation_percentage),
        allocationSource: x.allocation_source,
        grossCost: Number(x.gross_cost),
        employerCost: Number(x.employer_cost),
        totalCost: Number(x.total_cost),
        status: x.status,
      }));
      const groups = new Map<string, PayrollCostingSummaryView["byCostCenter"][number] & { _emp: Set<string> }>();
      for (const row of rows) {
        const k = row.costCenterId ?? "none";
        const g = groups.get(k) ?? { costCenterId: row.costCenterId, costCenterCode: row.costCenterCode, profitCenterId: row.profitCenterId, grossCost: 0, employerCost: 0, totalCost: 0, employees: 0, _emp: new Set<string>() };
        g.grossCost = fromCents(cents(g.grossCost) + cents(row.grossCost));
        g.employerCost = fromCents(cents(g.employerCost) + cents(row.employerCost));
        g.totalCost = fromCents(cents(g.totalCost) + cents(row.totalCost));
        g._emp.add(row.employeeId);
        g.employees = g._emp.size;
        groups.set(k, g);
      }
      return {
        payrollRunId: runId,
        rows,
        byCostCenter: [...groups.values()].map(({ _emp, ...rest }) => { void _emp; return rest; }),
        totalCost: fromCents(rows.reduce((a, x) => a + cents(x.totalCost), 0)),
      };
    });
  }

  /** Costing without a journal (for a tenant that has not mapped its accounts yet). Replaces draft rows; final rows stay. */
  async generateCosting(claims: RequestClaims, runId: string): Promise<PayrollCostingSummaryView> {
    await this.db.withClaims(claims, async (client) => {
      const run = await this.requireRunAccess(claims, client, runId, [ACT_BASE], "Not permitted to generate payroll costing");
      if (!POSTABLE_RUN_STATUSES.includes(run.status)) throw new BadRequestException(`Payroll run is ${run.status}; costing is generated for a finalised run`);
      const final = await client.query("SELECT 1 FROM payroll_costing_results WHERE payroll_run_id = $1 AND status = 'final' LIMIT 1", [runId]);
      if (final.rowCount) throw new ConflictException("This run's costing is final (its journal is posted)");
      const built = await this.build(client, run, true);
      const draftJournal = await client.query("SELECT id FROM payroll_journals WHERE payroll_run_id = $1 AND journal_kind = 'run' AND status = 'draft'", [runId]);
      await client.query("DELETE FROM payroll_costing_results WHERE payroll_run_id = $1 AND status = 'draft'", [runId]);
      await this.insertCosting(client, claims.company_id!, runId, draftJournal.rows[0]?.id ?? null, built);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_costing.generate",
        target: runId,
        metadata: { rows: built.costing.length, unallocatedEmployees: built.unallocatedEmployees },
      });
    });
    return this.costing(claims, runId);
  }

  // ------------------------------------------------------------------ internals

  private async insertLines(client: PoolClient, companyId: string, journalId: string, lines: BuiltLine[]): Promise<void> {
    let n = 0;
    for (const l of lines) {
      n += 1;
      await client.query(
        `INSERT INTO payroll_journal_lines (company_id, journal_id, line_no, account_code, debit, credit, line_kind, component_key, description, cost_center_id, profit_center_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [companyId, journalId, n, l.accountCode, l.signed > 0 ? fromCents(l.signed) : 0, l.signed < 0 ? fromCents(-l.signed) : 0, l.kind, l.componentKey, l.description, l.costCenterId, l.profitCenterId]
      );
    }
  }

  private async insertCosting(client: PoolClient, companyId: string, runId: string, journalId: string | null, built: Built): Promise<void> {
    for (const c of built.costing) {
      await client.query(
        `INSERT INTO payroll_costing_results
           (company_id, payroll_run_id, journal_id, payslip_id, employee_id, cost_center_id, profit_center_id, allocation_percentage, allocation_source, gross_cost, employer_cost, total_cost, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'draft')`,
        [companyId, runId, journalId, c.payslipId, c.employeeId, c.share.costCenterId, c.share.profitCenterId, c.pct, c.share.source, fromCents(c.gross), fromCents(c.employer), fromCents(c.gross + c.employer)]
      );
    }
  }

  /** Builds (without writing) the journal lines and the costing rows of a run. `costingOnly` skips the account checks. */
  private async build(client: PoolClient, run: RunRow, costingOnly = false): Promise<Built> {
    const slips = await client.query(
      `SELECT p.id, p.employee_id, p.employee_number, p.gross_pay, p.net_pay, p.employer_cost, e.position_id
         FROM payslips p JOIN employees e ON e.id = p.employee_id
        WHERE p.payroll_run_id = $1 AND p.status <> 'voided' ORDER BY p.employee_number`,
      [run.id]
    );
    if (slips.rowCount === 0) throw new BadRequestException("This run has no payslips");
    const lines = await client.query(
      `SELECT payslip_id, line_no, component_key, label, category, affects, amount FROM payroll_component_results
        WHERE payroll_run_id = $1 AND payslip_id = ANY($2::uuid[]) ORDER BY payslip_id, line_no`,
      [run.id, slips.rows.map((s) => s.id)]
    );
    const byPayslip = new Map<string, typeof lines.rows>();
    for (const l of lines.rows) byPayslip.set(l.payslip_id, [...(byPayslip.get(l.payslip_id) ?? []), l]);

    const empties = slips.rows.filter((s) => !byPayslip.get(s.id)?.length).map((s) => s.employee_number);
    if (empties.length) throw new BadRequestException(`Payslip(s) ${empties.slice(0, 5).join(", ")}${empties.length > 5 ? "..." : ""} have no component lines (calculated before structured results existed); recalculate the run first`);
    const off: string[] = [];
    for (const s of slips.rows) {
      const sum = (byPayslip.get(s.id) ?? []).filter((l) => l.affects !== "employer_cost").reduce((a, l) => a + cents(l.amount), 0);
      if (sum !== cents(s.net_pay)) off.push(s.employee_number);
    }
    if (off.length) throw new BadRequestException(`The component lines of payslip(s) ${off.slice(0, 5).join(", ")}${off.length > 5 ? "..." : ""} do not add up to net pay; run the calculation reconciliation first`);

    // mappings
    const mapRows = await client.query("SELECT * FROM payroll_gl_mappings WHERE is_active = true");
    const byKey = new Map<string, { d: string | null; c: string | null }>();
    const byCategory = new Map<string, { d: string | null; c: string | null }>();
    let netPayAccount: string | null = null;
    for (const m of mapRows.rows) {
      const v = { d: m.debit_account_code as string | null, c: m.credit_account_code as string | null };
      if (m.match_type === "component_key") byKey.set(m.match_value, v);
      else if (m.match_type === "category") byCategory.set(m.match_value, v);
      else if (m.match_value === NET_PAY_SPECIAL) netPayAccount = v.c;
    }
    const gl = await client.query("SELECT key, gl_account_code FROM compensation_components WHERE gl_account_code IS NOT NULL");
    const compGl = new Map(gl.rows.map((r) => [r.key as string, r.gl_account_code as string]));

    // cost and profit centres
    const shares = await this.loadShares(client, slips.rows);

    const unmapped = new Map<string, { key: string; category: string; affects: string; label: string }>();
    const acc = new Map<string, BuiltLine>();
    const add = (account: string, signed: number, kind: PayrollJournalLineKind, componentKey: string | null, description: string, cc: string | null, pc: string | null) => {
      if (signed === 0) return;
      const k = `${account}|${kind}|${componentKey ?? ""}|${cc ?? ""}|${pc ?? ""}`;
      const cur = acc.get(k);
      if (cur) cur.signed += signed;
      else acc.set(k, { accountCode: account, signed, kind, componentKey, description, costCenterId: cc, profitCenterId: pc });
    };
    const need = (l: { component_key: string; category: string; affects: string; label: string }) => unmapped.set(l.component_key, { key: l.component_key, category: l.category, affects: l.affects, label: l.label });

    const costing: Built["costing"] = [];
    for (const s of slips.rows) {
      const sh = shares.get(s.id)!;
      const grossParts = splitCents(cents(s.gross_pay), sh.map((x) => x.weight));
      // payslips.employer_cost is the whole cost to the employer (gross pay plus employer contributions)
      const employerParts = splitCents(cents(s.employer_cost) - cents(s.gross_pay), sh.map((x) => x.weight));
      const total = sh.reduce((a, x) => a + x.weight, 0);
      sh.forEach((share, i) => costing.push({ payslipId: s.id, employeeId: s.employee_id, employeeNumber: s.employee_number, share, pct: total > 0 ? Number(((share.weight * 100) / total).toFixed(4)) : 100, gross: grossParts[i], employer: employerParts[i] }));
      if (costingOnly) continue;

      for (const l of byPayslip.get(s.id) ?? []) {
        const amt = cents(l.amount);
        if (amt === 0) continue;
        const m = byKey.get(l.component_key) ?? byCategory.get(l.category);
        const debitAccount = m?.d ?? compGl.get(l.component_key) ?? null;
        const creditAccount = m?.c ?? null;
        if (l.affects === "gross" || (l.affects === "net" && amt > 0)) {
          const account = debitAccount ?? (amt < 0 ? creditAccount : null);
          if (!account) { need(l); continue; }
          const parts = splitCents(amt, sh.map((x) => x.weight));
          sh.forEach((share, i) => add(account, parts[i], "expense", l.component_key, l.label, share.costCenterId, share.profitCenterId));
        } else if (l.affects === "net") {
          if (!creditAccount) { need(l); continue; }
          add(creditAccount, amt, "liability", l.component_key, l.label, null, null);
        } else {
          if (!debitAccount || !creditAccount) { need(l); continue; }
          const parts = splitCents(amt, sh.map((x) => x.weight));
          sh.forEach((share, i) => add(debitAccount, parts[i], "employer_expense", l.component_key, l.label, share.costCenterId, share.profitCenterId));
          add(creditAccount, -amt, "employer_liability", l.component_key, l.label, null, null);
        }
      }
      if (netPayAccount) add(netPayAccount, -cents(s.net_pay), "net_pay", null, "Net pay payable", null, null);
    }

    const built = [...acc.values()].filter((l) => l.signed !== 0).sort((a, b) => a.kind.localeCompare(b.kind) || a.accountCode.localeCompare(b.accountCode) || (a.componentKey ?? "").localeCompare(b.componentKey ?? ""));
    const debit = built.filter((l) => l.signed > 0).reduce((a, l) => a + l.signed, 0);
    const credit = built.filter((l) => l.signed < 0).reduce((a, l) => a - l.signed, 0);
    const missingSpecial = !costingOnly && !netPayAccount ? [NET_PAY_SPECIAL] : [];
    if (!costingOnly && unmapped.size === 0 && missingSpecial.length === 0 && debit !== credit) {
      throw new Error(`Payroll journal for run ${run.id} does not balance (debit ${debit}, credit ${credit})`);
    }
    return {
      lines: built,
      costing,
      unmapped,
      missingSpecial,
      unallocatedEmployees: new Set(costing.filter((c) => c.share.source === "unallocated").map((c) => c.employeeId)).size,
      totalDebit: fromCents(debit),
      totalCredit: fromCents(credit),
    };
  }

  /** Cost / profit centre shares per payslip: the employee's active allocations, else the position's cost centre, else unallocated. */
  private async loadShares(client: PoolClient, slips: Array<{ id: string; employee_id: string; position_id: string | null }>): Promise<Map<string, Share[]>> {
    const centers = await client.query(
      `SELECT cc.id, cc.code, cc.org_unit_id, (SELECT pc.id FROM profit_centers pc WHERE pc.org_unit_id = cc.org_unit_id AND cc.org_unit_id IS NOT NULL AND pc.status = 'active' ORDER BY pc.code LIMIT 1) AS pc_id
         FROM cost_centers cc`
    );
    const profit = await client.query("SELECT id, code FROM profit_centers");
    const pcCode = new Map(profit.rows.map((p) => [p.id as string, p.code as string | null]));
    const ccById = new Map(centers.rows.map((c) => [c.id as string, c]));
    const allocs = await client.query(
      "SELECT employee_id, cost_center_id, allocation_percentage FROM employee_cost_allocations WHERE employee_id = ANY($1::uuid[]) AND status = 'active' ORDER BY is_primary DESC, created_at",
      [slips.map((s) => s.employee_id)]
    );
    const positions = await client.query(
      "SELECT id, cost_center_id, profit_center_id FROM positions WHERE id = ANY($1::uuid[])",
      [slips.map((s) => s.position_id).filter(Boolean)]
    );
    const posById = new Map(positions.rows.map((p) => [p.id as string, p]));
    const out = new Map<string, Share[]>();
    for (const s of slips) {
      const mine = allocs.rows.filter((a) => a.employee_id === s.employee_id && ccById.has(a.cost_center_id));
      let shares: Share[] = [];
      if (mine.length) {
        const sum = mine.reduce((a, x) => a + Number(x.allocation_percentage), 0);
        shares = mine.map((a) => {
          const cc = ccById.get(a.cost_center_id)!;
          return { costCenterId: cc.id, costCenterCode: cc.code ?? null, profitCenterId: cc.pc_id ?? null, profitCenterCode: cc.pc_id ? pcCode.get(cc.pc_id) ?? null : null, weight: Number(a.allocation_percentage), source: "allocation" as const };
        });
        if (sum < 100) shares.push({ costCenterId: null, costCenterCode: null, profitCenterId: null, profitCenterCode: null, weight: 100 - sum, source: "unallocated" });
      } else {
        const pos = s.position_id ? posById.get(s.position_id) : undefined;
        const cc = pos?.cost_center_id ? ccById.get(pos.cost_center_id) : undefined;
        if (cc) {
          const pcId = pos.profit_center_id ?? cc.pc_id ?? null;
          shares = [{ costCenterId: cc.id, costCenterCode: cc.code ?? null, profitCenterId: pcId, profitCenterCode: pcId ? pcCode.get(pcId) ?? null : null, weight: 100, source: "position" }];
        } else {
          shares = [{ costCenterId: null, costCenterCode: null, profitCenterId: null, profitCenterCode: null, weight: 100, source: "unallocated" }];
        }
      }
      out.set(s.id, shares);
    }
    return out;
  }

  private async ensureTypes(client: PoolClient, companyId: string): Promise<void> {
    for (const t of BUILT_IN_TYPES) {
      await client.query(
        `INSERT INTO payroll_journal_types (company_id, code, name, purpose, number_prefix) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [companyId, t.code, t.name, t.purpose, t.prefix]
      );
    }
  }

  private async nextNumber(client: PoolClient, typeId: string, postingDate: unknown): Promise<string> {
    const t = await client.query("UPDATE payroll_journal_types SET next_number = next_number + 1, updated_at = now() WHERE id = $1 RETURNING number_prefix, next_number - 1 AS n", [typeId]);
    return `${t.rows[0].number_prefix}-${day(postingDate).slice(0, 4)}-${String(t.rows[0].n).padStart(6, "0")}`;
  }

  /** Creates and posts the mirror of a posted run journal, then marks the original reversed. Returns the mirror's id. */
  private async reverseJournal(client: PoolClient, claims: RequestClaims, j: RunRow, reason: string): Promise<string> {
    await this.ensureTypes(client, j.company_id);
    const type = (await client.query("SELECT * FROM payroll_journal_types WHERE company_id = $1 AND purpose = 'reversal'", [j.company_id])).rows[0];
    const number = await this.nextNumber(client, type.id, j.posting_date);
    const m = await client.query(
      `INSERT INTO payroll_journals (company_id, payroll_run_id, journal_type_id, journal_kind, journal_number, status, reverses_journal_id, posting_date, currency_code,
                                     total_debit, total_credit, line_count, notes, generated_by, posted_by, posted_at, correlation_id)
       VALUES ($1, $2, $3, 'reversal', $4, 'posted', $5, $6, $7, $8, $9, $10, $11, $12, $12, now(), $13) RETURNING *`,
      [j.company_id, j.payroll_run_id, type.id, number, j.id, j.posting_date, j.currency_code, j.total_credit, j.total_debit, j.line_count, `Reversal of ${j.journal_number}: ${reason}`, claims.sub, currentCorrelationId()]
    );
    await client.query(
      `INSERT INTO payroll_journal_lines (company_id, journal_id, line_no, account_code, debit, credit, line_kind, component_key, description, cost_center_id, profit_center_id)
       SELECT company_id, $2, line_no, account_code, credit, debit, line_kind, component_key, description, cost_center_id, profit_center_id FROM payroll_journal_lines WHERE journal_id = $1`,
      [j.id, m.rows[0].id]
    );
    const orig = await client.query("UPDATE payroll_journals SET status = 'reversed', reversed_at = now(), reversed_by = $2 WHERE id = $1 RETURNING *", [j.id, claims.sub]);
    await client.query("UPDATE payroll_costing_results SET status = 'superseded' WHERE journal_id = $1 AND status = 'final'", [j.id]);
    await publishPostingStatusChanged(client, claims, orig.rows[0], "posted");
    await publishPostingStatusChanged(client, claims, m.rows[0], null);
    return m.rows[0].id;
  }

  private async onRunReversed(client: PoolClient, claims: RequestClaims, run: RunRow): Promise<void> {
    const reason = String(run.reversal_reason ?? "Payroll run reversed");
    const live = await client.query("SELECT * FROM payroll_journals WHERE payroll_run_id = $1 AND journal_kind = 'run' AND status IN ('draft', 'posted') FOR UPDATE", [run.id]);
    for (const j of live.rows) {
      if (j.status === "posted") {
        await this.reverseJournal(client, claims, j, reason);
      } else {
        await client.query("DELETE FROM payroll_journal_lines WHERE journal_id = $1", [j.id]);
        const d = await client.query("UPDATE payroll_journals SET status = 'discarded', line_count = 0, total_debit = 0, total_credit = 0 WHERE id = $1 RETURNING *", [j.id]);
        await publishPostingStatusChanged(client, claims, d.rows[0], "draft");
      }
    }
    await client.query("DELETE FROM payroll_costing_results WHERE payroll_run_id = $1 AND status = 'draft'", [run.id]);
    await client.query("UPDATE payroll_costing_results SET status = 'superseded' WHERE payroll_run_id = $1 AND status = 'final'", [run.id]);
  }

  private async lockJournal(client: PoolClient, id: string): Promise<RunRow> {
    const r = await client.query("SELECT * FROM payroll_journals WHERE id = $1 FOR UPDATE", [id]);
    if (!r.rowCount) throw new NotFoundException("Journal not found");
    return r.rows[0];
  }

  private async loadJournal(client: PoolClient, id: string, withLines: boolean): Promise<PayrollJournalView> {
    const r = await client.query("SELECT j.*, t.code AS type_code FROM payroll_journals j JOIN payroll_journal_types t ON t.id = j.journal_type_id WHERE j.id = $1", [id]);
    if (!r.rowCount) throw new NotFoundException("Journal not found");
    let lines: PayrollJournalLineView[] | undefined;
    if (withLines) {
      const l = await client.query(
        `SELECT l.*, cc.code AS cc_code, pc.code AS pc_code FROM payroll_journal_lines l
           LEFT JOIN cost_centers cc ON cc.id = l.cost_center_id LEFT JOIN profit_centers pc ON pc.id = l.profit_center_id
          WHERE l.journal_id = $1 ORDER BY l.line_no`,
        [id]
      );
      lines = l.rows.map((x) => ({
        lineNo: x.line_no,
        accountCode: x.account_code,
        debit: Number(x.debit),
        credit: Number(x.credit),
        lineKind: x.line_kind,
        componentKey: x.component_key ?? null,
        description: x.description ?? null,
        costCenterId: x.cost_center_id ?? null,
        costCenterCode: x.cc_code ?? null,
        profitCenterId: x.profit_center_id ?? null,
        profitCenterCode: x.pc_code ?? null,
      }));
    }
    return toJournal(r.rows[0], r.rows[0].type_code, lines);
  }

  // ------------------------------------------------------------------ access

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!claims.company_id) throw new ForbiddenException();
  }

  private async requirePermission(claims: RequestClaims, permission: string, message: string): Promise<void> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, permission)) && !(await this.rbac.can(claims, "payroll.manage.all"))) throw new ForbiddenException(message);
  }

  private async canView(claims: RequestClaims): Promise<boolean> {
    if (await resolvePayrollAreaAccess(this.db, this.rbac, claims, VIEW_BASES)) return true;
    return this.rbac.can(claims, "payroll.approve.all");
  }

  private async requireRunAccess(claims: RequestClaims, client: PoolClient, runId: string, bases: string[], message: string): Promise<RunRow> {
    await this.requireModule(claims);
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
