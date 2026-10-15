import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { buildPayrollFixture, type PayrollFixture } from "./testing/payroll-fixture";
import { PayrollAccountingService, splitCents } from "./payroll-accounting.service";
import { PayrollDocumentsService, renderPlaceholders, taxYearBounds } from "./payroll-documents.service";
import { PayrollBenefitsService, monthsBetween } from "./payroll-benefits.service";
import { PayrollDashboardService } from "./payroll-dashboard.service";
import { PayrollInputImportService } from "./payroll-input-import.service";
import { PayrollInputImportWorker } from "./payroll-input-import.worker";
import { PayrollReconciliationService } from "./payroll-reconciliation.service";
import { monthsBetween as _unused } from "./payroll-benefits.service";
import type { CompensationComponentView } from "@aihxm/shared-types";

void _unused;

/** Gap Register Step 10D - PAY-17 (accounting, costing), PAY-20 (documents), PAY-22 (benefits), PAY-25 (dashboard), PAY-26 (bulk inputs), PAY-27 (events). */
describe("Accounting, documents, benefits, dashboard, bulk inputs and events (Step 10D)", () => {
  let f: PayrollFixture;
  let other: PayrollFixture;
  let accounting: PayrollAccountingService;
  let documents: PayrollDocumentsService;
  let benefits: PayrollBenefitsService;
  let dashboard: PayrollDashboardService;
  let imports: PayrollInputImportService;
  let worker: PayrollInputImportWorker;
  let recon: PayrollReconciliationService;
  let otherAccounting: PayrollAccountingService;
  let otherDocuments: PayrollDocumentsService;
  let otherBenefits: PayrollBenefitsService;
  let essEmployee: { id: string; employeeNumber: string };
  let year = 2100;
  let essUser: Awaited<ReturnType<PayrollFixture["makeUser"]>>;

  const build = (fx: PayrollFixture) => ({
    accounting: new PayrollAccountingService(fx.db, fx.rbac, fx.entitlements, fx.audit, fx.control),
    documents: new PayrollDocumentsService(fx.db, fx.rbac, fx.entitlements, fx.audit),
    benefits: new PayrollBenefitsService(fx.db, fx.rbac, fx.entitlements, fx.audit, fx.compensation),
  });

  beforeAll(async () => {
    f = await buildPayrollFixture("s10d");
    other = await buildPayrollFixture("s10y");
    const o = build(other);
    otherAccounting = o.accounting;
    otherDocuments = o.documents;
    otherBenefits = o.benefits;
    const mine = build(f); // the primary tenant's hooks are registered last
    accounting = mine.accounting;
    documents = mine.documents;
    benefits = mine.benefits;
    dashboard = new PayrollDashboardService(f.db, f.rbac, f.entitlements);
    imports = new PayrollInputImportService(f.db, f.rbac, f.entitlements, f.audit, f.jobs, f.compensation, f.additionalPayments);
    worker = new PayrollInputImportWorker(f.db, f.jobs, imports);
    recon = new PayrollReconciliationService(f.db, f.rbac, f.entitlements, f.audit);
    essUser = await f.makeUser("ess", ["employee_self_service"]);
    essEmployee = await f.createEmployee({ userAccountId: essUser.uid, monthlySalary: 90000 });
  }, 120000);

  afterAll(async () => {
    await f.cleanup();
    await other.cleanup();
  });

  const nextYear = () => ++year;
  const drain = async () => {
    while (await worker.runOnce(`test-${process.pid}`)) {
      /* process every queued job */
    }
  };

  /** The accounts a tenant would map; the codes are test values, not a chart of accounts. */
  async function mapAccounts() {
    const m = (matchType: string, matchValue: string, debitAccountCode: string | null, creditAccountCode: string | null) =>
      accounting.upsertMapping(f.hr, { matchType, matchValue, debitAccountCode, creditAccountCode } as never);
    await m("component_key", "basic_salary", "T-5000", null);
    await m("component_key", "eobi_employee", null, "T-2100");
    await m("component_key", "income_tax", null, "T-2200");
    await m("component_key", "eobi_employer", "T-5100", "T-2300");
    await m("component_key", "social_security_employer", "T-5101", "T-2301");
    await m("category", "employer_contribution", "T-5199", "T-2399"); // any other employer-paid component, e.g. a benefit plan's
    await m("special", "net_pay_payable", null, "T-2000");
  }
  const unmap = () => f.sql("DELETE FROM payroll_gl_mappings WHERE company_id = $1", [f.companyId]);

  describe("pure helpers", () => {
    it("splits cents without losing or inventing one", () => {
      expect(splitCents(10000, [60, 40])).toEqual([6000, 4000]);
      expect(splitCents(10001, [50, 50]).reduce((a, b) => a + b, 0)).toBe(10001);
      expect(splitCents(100, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(100);
      expect(splitCents(-10001, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(-10001);
      expect(splitCents(500, [0, 0])).toEqual([500, 0]);
    });

    it("renders placeholders, counts whole months and bounds tax years", () => {
      expect(renderPlaceholders("Hi {{ name }} {{missing}}!", { name: "Sana" })).toBe("Hi Sana !");
      expect(monthsBetween("2024-01-15", "2024-03-14")).toBe(1);
      expect(monthsBetween("2024-01-15", "2024-03-15")).toBe(2);
      expect(taxYearBounds(2027)).toEqual({ start: "2026-07-01", end: "2027-06-30" });
    });
  });

  describe("GL mappings and journal types (PAY-17)", () => {
    it("keeps configuration to people allowed to configure payroll and to their own tenant", async () => {
      await expect(accounting.listMappings(f.staff)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(accounting.upsertMapping(f.staff, { matchType: "category", matchValue: "tax", creditAccountCode: "X" })).rejects.toBeInstanceOf(ForbiddenException);
      const created = await accounting.upsertMapping(f.hr, { matchType: "category", matchValue: "tax", creditAccountCode: " T-2201 " });
      expect(created).toMatchObject({ matchType: "category", matchValue: "tax", creditAccountCode: "T-2201", debitAccountCode: null, isActive: true });
      const again = await accounting.upsertMapping(f.hr, { matchType: "category", matchValue: "tax", creditAccountCode: "T-2202", description: "changed" });
      expect(again.id).toBe(created.id);
      expect(again.creditAccountCode).toBe("T-2202");
      expect((await otherAccounting.listMappings(other.hr)).map((x) => x.id)).not.toContain(created.id);
      await expect(otherAccounting.deleteMapping(other.hr, created.id)).rejects.toBeInstanceOf(NotFoundException);
      await accounting.deleteMapping(f.hr, created.id);
    });

    it("validates mappings", async () => {
      await expect(accounting.upsertMapping(f.hr, { matchType: "component_key", matchValue: "x" })).rejects.toBeInstanceOf(BadRequestException);
      await expect(accounting.upsertMapping(f.hr, { matchType: "special", matchValue: "nonsense", creditAccountCode: "A" })).rejects.toBeInstanceOf(BadRequestException);
      await expect(accounting.upsertMapping(f.hr, { matchType: "special", matchValue: "net_pay_payable", debitAccountCode: "A" })).rejects.toBeInstanceOf(BadRequestException);
    });

    it("creates the journal types on first use and lets the tenant rename their prefix", async () => {
      const types = await accounting.listJournalTypes(f.hr);
      expect(types.map((t) => t.purpose).sort()).toEqual(["final_settlement", "payroll_run", "reversal"]);
      const run = types.find((t) => t.purpose === "payroll_run")!;
      await expect(accounting.updateJournalType(f.hr, run.id, { numberPrefix: "bad prefix!" })).rejects.toBeInstanceOf(BadRequestException);
      expect((await accounting.updateJournalType(f.hr, run.id, { numberPrefix: "PAY" })).numberPrefix).toBe("PAY");
      await accounting.updateJournalType(f.hr, run.id, { numberPrefix: "PJ" });
      await expect(accounting.updateJournalType(f.staff, run.id, { name: "x" })).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("journals, costing and posting (PAY-17)", () => {
    let cc1: string;
    let cc2: string;
    let emp1: { id: string; employeeNumber: string };
    let emp2: { id: string; employeeNumber: string };

    beforeAll(async () => {
      cc1 = (await f.sql<{ id: string }>("INSERT INTO cost_centers (company_id, code, name) VALUES ($1, 'CC-A', 'Alpha') RETURNING id", [f.companyId]))[0].id;
      cc2 = (await f.sql<{ id: string }>("INSERT INTO cost_centers (company_id, code, name) VALUES ($1, 'CC-B', 'Beta') RETURNING id", [f.companyId]))[0].id;
      emp1 = await f.createEmployee({ monthlySalary: 100001 });
      emp2 = await f.createEmployee({ monthlySalary: 80000 });
      await f.sql(
        "INSERT INTO employee_cost_allocations (company_id, employee_id, cost_center_id, allocation_percentage, is_primary) VALUES ($1,$2,$3,60,true),($1,$2,$4,40,false)",
        [f.companyId, emp1.id, cc1, cc2]
      );
    });

    it("refuses to build a journal while accounts are missing and lists exactly what is missing", async () => {
      await unmap();
      const y = nextYear();
      const runId = await f.finalizedRun(`${y}-02-01`, `${y}-02-28`);
      const preview = await accounting.preview(f.hr, runId);
      expect(preview.ready).toBe(false);
      expect(preview.missingSpecial).toEqual(["net_pay_payable"]);
      expect(preview.unmappedKeys.map((k) => k.key)).toEqual(expect.arrayContaining(["basic_salary", "eobi_employee", "eobi_employer"]));
      await expect(accounting.generate(f.hr, runId)).rejects.toThrow(/no GL account for: .*basic_salary/);
      expect(await f.sql("SELECT 1 FROM payroll_journals WHERE payroll_run_id = $1", [runId])).toHaveLength(0);
      await expect(accounting.preview(f.staff, runId)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("builds a balanced double-entry journal from the payslip lines, with cost centres on the expense side", async () => {
      await unmap();
      await mapAccounts();
      const y = nextYear();
      const runId = await f.finalizedRun(`${y}-03-01`, `${y}-03-31`);
      const j = await accounting.generate(f.hr, runId, { notes: "March" });
      expect(j).toMatchObject({ status: "draft", journalNumber: null, journalKind: "run", journalTypeCode: "PAYROLL", postingDate: `${y}-03-31`, notes: "March" });
      expect(j.totalDebit).toBe(j.totalCredit);
      expect(j.lines!.reduce((a, l) => a + l.debit, 0)).toBeCloseTo(j.totalDebit, 2);
      expect(j.lines!.reduce((a, l) => a + l.credit, 0)).toBeCloseTo(j.totalCredit, 2);

      const slips = await f.payroll.listPayslips(f.hr, { payrollRunId: runId });
      const gross = slips.reduce((a, s) => a + s.grossPay, 0);
      const net = slips.reduce((a, s) => a + s.netPay, 0);
      // payslips.employer_cost is the whole cost to the employer: gross pay plus employer contributions
      const employer = (await f.sql<{ t: string }>("SELECT SUM(employer_cost) AS t FROM payslips WHERE payroll_run_id = $1", [runId]))[0].t;
      expect(j.totalDebit).toBeCloseTo(Number(employer), 2);
      const netLine = j.lines!.filter((l) => l.lineKind === "net_pay");
      expect(netLine).toHaveLength(1);
      expect(netLine[0]).toMatchObject({ accountCode: "T-2000", debit: 0 });
      expect(netLine[0].credit).toBeCloseTo(net, 2);
      // expense debits carry the cost centres; liability credits carry none
      const expense = j.lines!.filter((l) => l.lineKind === "expense" && l.componentKey === "basic_salary");
      expect(expense.map((l) => l.costCenterCode).sort()).toEqual(["CC-A", "CC-B", null]);
      expect(expense.reduce((a, l) => a + l.debit, 0)).toBeCloseTo(gross, 2);
      expect(j.lines!.filter((l) => l.lineKind !== "expense" && l.lineKind !== "employer_expense").every((l) => l.costCenterId === null)).toBe(true);
      // the 60 / 40 split of the first employee's pay is exact to the cent
      const costing = await accounting.costing(f.hr, runId);
      const mine = costing.rows.filter((r) => r.employeeId === emp1.id);
      expect(mine.map((r) => [r.costCenterCode, r.allocationPercentage]).sort()).toEqual([["CC-A", 60], ["CC-B", 40]]);
      const slip1 = slips.find((s) => s.employeeId === emp1.id)!;
      expect(mine.reduce((a, r) => a + r.grossCost, 0)).toBeCloseTo(slip1.grossPay, 2);
      expect(costing.rows.filter((r) => r.employeeId === emp2.id)).toMatchObject([{ costCenterId: null, allocationSource: "unallocated", allocationPercentage: 100 }]);
      expect(costing.totalCost).toBeCloseTo(Number(employer), 2);
      expect(costing.rows.every((r) => r.status === "draft")).toBe(true);
    }, 60000);

    it("posts the journal once: numbered, frozen, run moves to accounting, costing final", async () => {
      await unmap();
      await mapAccounts();
      const y = nextYear();
      const runId = await f.finalizedRun(`${y}-04-01`, `${y}-04-30`);
      const draft = await accounting.generate(f.hr, runId);
      await expect(accounting.post(f.staff, draft.id)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(otherAccounting.post(other.hr, draft.id)).rejects.toBeInstanceOf(NotFoundException);
      const posted = await accounting.post(f.hr, draft.id, { postingReference: "ERP-77" });
      expect(posted.status).toBe("posted");
      expect(posted.journalNumber).toMatch(new RegExp(`^PJ-${y}-\\d{6}$`));
      expect(posted.postingReference).toBe("ERP-77");
      expect((await f.payroll.getRun(f.hr, runId)).status).toBe("accounting");
      expect((await accounting.costing(f.hr, runId)).rows.every((r) => r.status === "final")).toBe(true);

      await expect(accounting.post(f.hr, draft.id)).rejects.toThrow(/Only a draft journal/);
      await expect(accounting.generate(f.hr, runId)).rejects.toBeInstanceOf(ConflictException);
      await expect(accounting.discard(f.hr, draft.id)).rejects.toBeInstanceOf(BadRequestException);
      await expect(f.sql("UPDATE payroll_journals SET total_debit = 1, total_credit = 1 WHERE id = $1", [draft.id])).rejects.toThrow(/immutable/);
      await expect(f.sql("DELETE FROM payroll_journal_lines WHERE journal_id = $1", [draft.id])).rejects.toThrow(/posted/);
      await expect(f.sql("UPDATE payroll_costing_results SET total_cost = 1 WHERE payroll_run_id = $1", [runId])).rejects.toThrow(/immutable/);
      await expect(f.sql("DELETE FROM payroll_journals WHERE id = $1", [draft.id])).rejects.toThrow(/permission denied/);

      const second = await f.finalizedRun(`${y}-05-01`, `${y}-05-31`);
      const next = await accounting.post(f.hr, (await accounting.generate(f.hr, second)).id);
      expect(Number(next.journalNumber!.slice(-6))).toBe(Number(posted.journalNumber!.slice(-6)) + 1);
      const csv = await accounting.journalCsv(f.hr, draft.id);
      expect(csv.split("\n")[0]).toBe("journal_number,posting_date,line_no,account_code,debit,credit,component_key,cost_center,profit_center,description");
      expect(csv).toContain(posted.journalNumber!);
    }, 90000);

    it("replaces a draft when regenerated, and discards one on request", async () => {
      await unmap();
      await mapAccounts();
      const y = nextYear();
      const runId = await f.finalizedRun(`${y}-06-01`, `${y}-06-30`);
      const a = await accounting.generate(f.hr, runId);
      const b = await accounting.generate(f.hr, runId, { postingDate: `${y}-07-02` });
      expect(b.id).not.toBe(a.id);
      expect(b.postingDate).toBe(`${y}-07-02`);
      const all = await accounting.listJournals(f.hr, runId);
      expect(all.map((j) => j.status).sort()).toEqual(["discarded", "draft"]);
      expect((await accounting.costing(f.hr, runId)).rows.length).toBeGreaterThan(0);
      const gone = await accounting.discard(f.hr, b.id);
      expect(gone.status).toBe("discarded");
      expect((await accounting.costing(f.hr, runId)).rows).toHaveLength(0);
    }, 60000);

    it("reverses a posting with a mirror journal and lets a fresh one be generated", async () => {
      await unmap();
      await mapAccounts();
      const y = nextYear();
      const runId = await f.finalizedRun(`${y}-08-01`, `${y}-08-31`);
      const posted = await accounting.post(f.hr, (await accounting.generate(f.hr, runId)).id);
      await expect(accounting.reversePosting(f.hr, posted.id, "x")).rejects.toBeInstanceOf(BadRequestException);
      await expect(accounting.reversePosting(f.staff, posted.id, "Wrong cost centres")).rejects.toBeInstanceOf(ForbiddenException);
      const original = await accounting.reversePosting(f.hr, posted.id, "Wrong cost centres");
      expect(original.status).toBe("reversed");
      const all = await accounting.listJournals(f.hr, runId);
      const mirror = all.find((j) => j.journalKind === "reversal")!;
      expect(mirror).toMatchObject({ status: "posted", reversesJournalId: posted.id, totalDebit: posted.totalCredit, totalCredit: posted.totalDebit });
      expect(mirror.journalNumber).toMatch(/^RJ-/);
      const mirrorFull = await accounting.getJournal(f.hr, mirror.id);
      expect(mirrorFull.lines!.reduce((a, l) => a + l.debit - l.credit, 0)).toBeCloseTo(0, 2);
      expect((await accounting.costing(f.hr, runId)).rows).toHaveLength(0);
      await accounting.generate(f.hr, runId); // a new draft is allowed now
      await expect(accounting.reversePosting(f.hr, posted.id, "again")).rejects.toBeInstanceOf(BadRequestException);
    }, 90000);

    it("reverses the posting when the run itself is reversed, and discards a draft", async () => {
      await unmap();
      await mapAccounts();
      const y = nextYear();
      const postedRun = await f.finalizedRun(`${y}-09-01`, `${y}-09-30`);
      const posted = await accounting.post(f.hr, (await accounting.generate(f.hr, postedRun)).id);
      const draftRun = await f.finalizedRun(`${y}-10-01`, `${y}-10-31`);
      const draft = await accounting.generate(f.hr, draftRun);

      await f.payroll.reverseRun(f.hr, postedRun, { reason: "Wrong period" });
      await f.payroll.reverseRun(f.hr, draftRun, { reason: "Wrong period" });
      const after = await accounting.listJournals(f.hr, postedRun);
      expect(after.find((j) => j.id === posted.id)!.status).toBe("reversed");
      expect(after.find((j) => j.journalKind === "reversal")).toMatchObject({ status: "posted", reversesJournalId: posted.id });
      expect((await accounting.listJournals(f.hr, draftRun)).find((j) => j.id === draft.id)!.status).toBe("discarded");
      expect((await accounting.costing(f.hr, postedRun)).rows).toHaveLength(0);
    }, 120000);

    it("reconciles accounting and costing against the payslips", async () => {
      await unmap();
      await mapAccounts();
      const y = nextYear();
      const runId = await f.finalizedRun(`${y}-11-01`, `${y}-11-30`);
      const before = await recon.run(f.hr, runId, ["accounting", "costing"]);
      expect(before.map((r) => r.status)).toEqual(["pending", "pending"]);

      const draft = await accounting.generate(f.hr, runId);
      const mid = await recon.run(f.hr, runId, ["accounting", "costing"]);
      expect(mid.find((r) => r.kind === "accounting")!.status).toBe("pending"); // not posted yet
      expect(mid.find((r) => r.kind === "costing")!.status).toBe("variance"); // costing still a draft
      expect(JSON.stringify(mid.find((r) => r.kind === "costing")!.detail)).toMatch(/still a draft/);

      await accounting.post(f.hr, draft.id);
      const after = await recon.run(f.hr, runId, ["accounting", "costing"]);
      const acct = after.find((r) => r.kind === "accounting")!;
      expect(acct.status).toBe("matched");
      expect(acct.expectedAmount).toBe(acct.actualAmount);
      expect(after.find((r) => r.kind === "costing")!.status).toBe("matched");

      await f.payroll.reverseRun(f.hr, runId, { reason: "Redo" });
      const reversed = await recon.run(f.hr, runId, ["accounting"]);
      expect(reversed[0]).toMatchObject({ status: "matched", actualAmount: 0 });
    }, 120000);

    it("generates costing without a journal for a tenant that has not mapped accounts", async () => {
      await unmap();
      const y = nextYear();
      const runId = await f.finalizedRun(`${y}-12-01`, `${y}-12-31`);
      const summary = await accounting.generateCosting(f.hr, runId);
      expect(summary.rows.length).toBeGreaterThan(0);
      expect(summary.byCostCenter.map((g) => g.costCenterCode).sort()).toEqual(["CC-A", "CC-B", null]);
      await expect(accounting.generateCosting(f.staff, runId)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(otherAccounting.generateCosting(other.hr, runId)).rejects.toBeInstanceOf(NotFoundException);
    }, 60000);
  });

  describe("payroll domain events (PAY-27)", () => {
    const events = (type: string, runId: string) =>
      f.sql<{ payload: Record<string, unknown>; schema_version: number; aggregate_type: string; aggregate_id: string }>(
        "SELECT payload, schema_version, aggregate_type, aggregate_id FROM domain_events WHERE company_id = $1 AND event_type = $2 AND aggregate_id = $3 ORDER BY occurred_at",
        [f.companyId, type, runId]
      );

    it("announces state changes and finalisation with versioned payloads, in the same transaction", async () => {
      const y = nextYear();
      const run = await f.payroll.createRun(f.hr, { periodStart: `${y}-01-01`, periodEnd: `${y}-01-31` });
      await f.payroll.calculateRun(f.hr, run.id);
      await f.submitAndApprove(run.id);
      await f.payroll.finalizeRun(f.hr, run.id);
      const changes = await events("payroll.run.state_changed", run.id);
      const path = changes.map((c) => c.payload.to);
      expect(path).toEqual(expect.arrayContaining(["calculated", "pending_approval", "approved", "finalized"]));
      expect(changes.every((c) => c.schema_version === 1 && c.aggregate_type === "payroll_run")).toBe(true);
      expect(changes.find((c) => c.payload.to === "finalized")!.payload).toMatchObject({ runId: run.id, from: "approved", periodStart: `${y}-01-01`, periodEnd: `${y}-01-31`, action: expect.any(String) });
      const fin = await events("payroll.run.finalized", run.id);
      expect(fin).toHaveLength(1);
      const slips = await f.payroll.listPayslips(f.hr, { payrollRunId: run.id });
      expect(fin[0].payload).toMatchObject({ runId: run.id, payslipCount: slips.length, currencyCode: "PKR" });
      expect(Number(fin[0].payload.totalPayable)).toBeCloseTo(slips.reduce((a, s) => a + s.netPay, 0), 2);
      // the event commits with the change: when the transaction rolls back, the event goes with it
      await expect(
        f.db.withClaims(f.hr, async (c) => {
          await f.control.transition(c, f.hr, run.id, "closed", { action: "close" });
          throw new Error("rolled back");
        })
      ).rejects.toThrow("rolled back");
      expect((await events("payroll.run.state_changed", run.id)).some((e) => e.payload.to === "closed")).toBe(false);
      expect((await f.payroll.getRun(f.hr, run.id)).status).toBe("finalized");
    }, 60000);

    it("publishes one event per payslip only while a subscription listens, and one per payment batch change and posting change", async () => {
      await unmap();
      await mapAccounts();
      const y = nextYear();
      const quiet = await f.payroll.createRun(f.hr, { periodStart: `${y}-02-01`, periodEnd: `${y}-02-28` });
      await f.payroll.calculateRun(f.hr, quiet.id);
      expect(await events("payroll.employee.calculated", quiet.id)).toHaveLength(0);

      await f.sql(
        "INSERT INTO event_subscriptions (company_id, name, event_patterns, target_kind, target_url) VALUES ($1, 'payroll listener', ARRAY['payroll.*'], 'webhook', 'https://example.invalid/hook')",
        [f.companyId]
      );
      const loud = await f.payroll.createRun(f.hr, { periodStart: `${y}-03-01`, periodEnd: `${y}-03-31` });
      await f.payroll.calculateRun(f.hr, loud.id);
      const perEmployee = await events("payroll.employee.calculated", loud.id);
      const slips = await f.payroll.listPayslips(f.hr, { payrollRunId: loud.id });
      expect(perEmployee).toHaveLength(slips.length);
      expect(perEmployee[0].payload).toEqual(expect.objectContaining({ runId: loud.id, payslipId: expect.any(String), employeeId: expect.any(String) }));
      // SEC-13: an individual's pay never travels in an event
      expect(JSON.stringify(perEmployee[0].payload)).not.toMatch(/gross|net_?pay|REDACTED/i);
      // deliveries were fanned out for the matching subscription
      expect((await f.sql<{ n: string }>("SELECT COUNT(*) AS n FROM event_deliveries d JOIN domain_events e ON e.id = d.event_id WHERE e.aggregate_id = $1", [loud.id]))[0].n).not.toBe("0");

      await f.submitAndApprove(loud.id);
      await f.payroll.finalizeRun(f.hr, loud.id);
      const gen = await f.payroll.generateDisbursementFile(f.hr, loud.id);
      const pay = await events("payroll.payment.status_changed", gen.batch.id);
      expect(pay.map((e) => [e.payload.from, e.payload.to])).toEqual([[null, "generated"]]);
      expect(pay[0].aggregate_type).toBe("payroll_payment_batch");
      expect(pay[0].payload).toMatchObject({ runId: loud.id, batchReference: gen.batch.batchReference, totalPayable: gen.batch.totalNetPay });

      const j = await accounting.generate(f.hr, loud.id);
      await accounting.post(f.hr, j.id);
      const posting = await events("payroll.posting.status_changed", j.id);
      expect(posting.map((e) => [e.payload.from, e.payload.to])).toEqual([[null, "draft"], ["draft", "posted"]]);
      expect(posting[1].payload).toMatchObject({ journalKind: "run", journalNumber: expect.stringMatching(/^PJ-/) });
      await f.sql("DELETE FROM event_subscriptions WHERE company_id = $1", [f.companyId]);
    }, 120000);
  });

  describe("payslip and certificate documents (PAY-20)", () => {
    const count = async (runId: string) => (await f.payroll.listPayslips(f.hr, { payrollRunId: runId })).length;

    it("generates one immutable, hashed payslip document per payslip, once, and supersedes on request", async () => {
      const y = nextYear();
      const runId = await f.finalizedRun(`${y}-01-01`, `${y}-01-31`);
      const n = await count(runId);
      await expect(documents.generatePayslips(f.staff, runId)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(otherDocuments.generatePayslips(other.hr, runId)).rejects.toBeInstanceOf(NotFoundException);
      const draft = await f.payroll.createRun(f.hr, { periodStart: `${y}-02-01`, periodEnd: `${y}-02-28` });
      await expect(documents.generatePayslips(f.hr, draft.id)).rejects.toBeInstanceOf(BadRequestException);

      expect(await documents.generatePayslips(f.hr, runId)).toEqual({ generated: n, skipped: 0, published: 0 });
      expect(await documents.generatePayslips(f.hr, runId)).toEqual({ generated: 0, skipped: n, published: 0 });
      const docs = await documents.list(f.hr, { runId, documentType: "payslip" });
      expect(docs).toHaveLength(n);
      const mine = docs.find((d) => d.employeeId === essEmployee.id)!;
      const full = await documents.get(f.hr, mine.id);
      expect(full.content).toContain(essEmployee.employeeNumber);
      expect(full.content).toContain("NET PAY:");
      expect(full.content).toContain(`${y}-01-01 to ${y}-01-31`);
      expect(full.contentHash).toBe(createHash("sha256").update(full.content!).digest("hex"));
      expect(full).toMatchObject({ templateSource: "built_in", templateKey: null, status: "issued", publishedAt: null });
      await expect(f.sql("UPDATE generated_documents SET content = 'forged' WHERE id = $1", [mine.id])).rejects.toThrow(/immutable/);
      await expect(f.sql("DELETE FROM generated_documents WHERE id = $1", [mine.id])).rejects.toThrow(/permission denied|cannot be deleted/);

      expect(await documents.generatePayslips(f.hr, runId, { replace: true })).toMatchObject({ generated: n, skipped: 0 });
      const all = await documents.list(f.hr, { runId });
      expect(all.filter((d) => d.status === "superseded")).toHaveLength(n);
      expect(all.filter((d) => d.status === "issued")).toHaveLength(n);
    }, 90000);

    it("shows an employee their payslip at once by default, and only after publication when the tenant requires it", async () => {
      const y = nextYear();
      const runId = await f.finalizedRun(`${y}-01-01`, `${y}-01-31`);
      const slipId = (await f.payroll.listPayslips(f.hr, { payrollRunId: runId })).find((p) => p.employeeId === essEmployee.id)!.id;
      expect((await f.payroll.listPayslips(essUser, {})).map((p) => p.id)).toContain(slipId);

      await expect(documents.updateSettings(f.staff, { requirePublication: true })).rejects.toBeInstanceOf(ForbiddenException);
      await documents.updateSettings(f.hr, { requirePublication: true });
      expect((await f.payroll.listPayslips(essUser, {})).map((p) => p.id)).not.toContain(slipId);
      await expect(f.payroll.getPayslip(essUser, slipId)).rejects.toBeInstanceOf(NotFoundException);
      await expect(f.payroll.getPayslipDetail(essUser, slipId)).rejects.toBeInstanceOf(NotFoundException);
      expect((await f.payroll.listPayslips(f.hr, { payrollRunId: runId })).map((p) => p.id)).toContain(slipId); // payroll staff are never affected

      await documents.generatePayslips(f.hr, runId);
      expect(await documents.listMine(essUser)).toEqual([]); // generated but not published
      expect(await documents.setRunPublication(f.hr, runId, true)).toEqual({ changed: await count(runId) });
      expect((await f.payroll.listPayslips(essUser, {})).map((p) => p.id)).toContain(slipId);
      await expect(f.payroll.getPayslip(essUser, slipId)).resolves.toMatchObject({ id: slipId });
      const mine = await documents.listMine(essUser);
      expect(mine.filter((d) => d.payrollRunId === runId)).toHaveLength(1);
      const text = await documents.get(essUser, mine.find((d) => d.payrollRunId === runId)!.id);
      expect(text.content).toContain(essEmployee.employeeNumber);
      const others = (await documents.list(f.hr, { runId })).find((d) => d.employeeId !== essEmployee.id)!;
      await expect(documents.get(essUser, others.id)).rejects.toBeInstanceOf(NotFoundException);

      await documents.setRunPublication(f.hr, runId, false);
      expect(await documents.listMine(essUser)).toEqual([]);
      await documents.setPublication(f.hr, mine.find((d) => d.payrollRunId === runId)!.id, true);
      await documents.revoke(f.hr, mine.find((d) => d.payrollRunId === runId)!.id, "Issued in error");
      expect(await documents.listMine(essUser)).toEqual([]);
      await expect(documents.revoke(f.staff, mine[0].id, "Not allowed")).rejects.toBeInstanceOf(ForbiddenException);
      await expect(documents.revoke(f.hr, mine[0].id, "x")).rejects.toBeInstanceOf(BadRequestException);

      await documents.updateSettings(f.hr, { requirePublication: false });
      expect((await f.payroll.listPayslips(essUser, {})).map((p) => p.id)).toContain(slipId);
    }, 90000);

    it("revokes a run's payslip documents when the run is reversed", async () => {
      const y = nextYear();
      const runId = await f.finalizedRun(`${y}-01-01`, `${y}-01-31`);
      await documents.generatePayslips(f.hr, runId, { publish: true });
      await f.payroll.reverseRun(f.hr, runId, { reason: "Wrong rates" });
      const docs = await documents.list(f.hr, { runId });
      expect(docs.length).toBeGreaterThan(0);
      expect(docs.every((d) => d.status === "revoked" && d.revokeReason === "Payroll run reversed")).toBe(true);
      expect((await documents.listMine(essUser)).some((d) => d.payrollRunId === runId)).toBe(false);
    }, 90000);

    it("renders a template the tenant selected, and falls back to the built-in body when it is deselected", async () => {
      await f.sql("INSERT INTO document_templates (company_id, key, name, object_key, template_body) VALUES ($1, 'my_payslip', 'My payslip', 'payslip', 'SLIP {{employeeNumber}} NET={{netPay}} X={{unknown}}')", [f.companyId]);
      await expect(documents.updateSettings(f.hr, { templateChoices: [{ documentType: "payslip", templateKey: "nope" }] })).rejects.toBeInstanceOf(BadRequestException);
      const settings = await documents.updateSettings(f.hr, { templateChoices: [{ documentType: "payslip", templateKey: "my_payslip" }] });
      expect(settings.templateChoices.find((c) => c.documentType === "payslip")!.templateKey).toBe("my_payslip");
      expect(settings.availableTemplates.map((t) => t.key)).toContain("my_payslip");
      const y = nextYear();
      const runId = await f.finalizedRun(`${y}-01-01`, `${y}-01-31`);
      await documents.generatePayslips(f.hr, runId);
      const doc = await documents.get(f.hr, (await documents.list(f.hr, { runId, documentType: "payslip" })).find((d) => d.employeeId === essEmployee.id)!.id);
      expect(doc).toMatchObject({ templateSource: "custom", templateKey: "my_payslip" });
      expect(doc.content).toMatch(new RegExp(`^SLIP ${essEmployee.employeeNumber} NET=PKR [\\d,]+\\.\\d\\d X=$`));
      await documents.updateSettings(f.hr, { templateChoices: [{ documentType: "payslip", templateKey: null }] });
      const run2 = await f.finalizedRun(`${nextYear()}-01-01`, `${year}-01-31`);
      await documents.generatePayslips(f.hr, run2);
      expect((await documents.list(f.hr, { runId: run2 }))[0].templateSource).toBe("built_in");
      expect(documents.placeholders().map((p) => p.documentType)).toEqual(["payslip", "tax_certificate", "salary_certificate"]);
      await expect(otherDocuments.getSettings(other.hr)).resolves.toMatchObject({ requirePublication: false, availableTemplates: [] });
    }, 90000);

    it("issues an annual tax certificate from the tax year's totals and supersedes it when re-issued", async () => {
      const y = nextYear();
      const runId = await f.finalizedRun(`${y}-02-01`, `${y}-02-28`);
      void runId;
      await expect(documents.generateTaxCertificate(f.staff, { employeeId: essEmployee.id, taxYear: y })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(otherDocuments.generateTaxCertificate(other.hr, { employeeId: essEmployee.id, taxYear: y })).rejects.toBeInstanceOf(NotFoundException);
      await expect(documents.generateTaxCertificate(f.hr, { employeeId: essEmployee.id, taxYear: y + 40 })).rejects.toThrow(/no finalised payroll/);
      await expect(documents.generateTaxCertificate(f.hr, { employeeId: essEmployee.id, taxYear: 1800 })).rejects.toBeInstanceOf(BadRequestException);

      const cert = await documents.generateTaxCertificate(f.hr, { employeeId: essEmployee.id, taxYear: y });
      expect(cert).toMatchObject({ documentType: "tax_certificate", taxYear: y, status: "issued", employeeNumber: essEmployee.employeeNumber });
      expect(cert.content).toContain(`TAX YEAR ${y} (${y - 1}-07-01 to ${y}-06-30)`);
      expect(cert.content).toContain("Gross salary:   PKR 90,000.00");
      expect(cert.content).toContain(`${y}-02-01 - ${y}-02-28`);
      const again = await documents.generateTaxCertificate(f.hr, { employeeId: essEmployee.id, taxYear: y });
      const history = await documents.list(f.hr, { employeeId: essEmployee.id, documentType: "tax_certificate" });
      expect(history.filter((d) => d.taxYear === y).map((d) => d.status).sort()).toEqual(["issued", "superseded"]);
      expect(again.id).not.toBe(cert.id);

      await expect(documents.get(essUser, again.id)).rejects.toBeInstanceOf(NotFoundException); // not published
      await documents.setPublication(f.hr, again.id, true);
      expect((await documents.get(essUser, again.id)).content).toContain("Tax withheld");
      expect((await documents.listMine(essUser)).map((d) => d.id)).toContain(again.id);
    }, 90000);

    it("issues a salary certificate from the employee's current earning components", async () => {
      const sc = await documents.generateSalaryCertificate(f.hr, { employeeId: essEmployee.id, addressedTo: "The Branch Manager", purpose: "a bank account" });
      expect(sc.content).toContain("The Branch Manager");
      expect(sc.content).toContain("a bank account");
      expect(sc.content).toContain("monthly gross salary is PKR 90,000.00");
      const bare = await f.createEmployee({ monthlySalary: null });
      await expect(documents.generateSalaryCertificate(f.hr, { employeeId: bare.id })).rejects.toThrow(/no current earning components/);
      await expect(documents.generateSalaryCertificate(f.staff, { employeeId: essEmployee.id })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(otherDocuments.generateSalaryCertificate(other.hr, { employeeId: essEmployee.id })).rejects.toBeInstanceOf(NotFoundException);
    }, 60000);
  });

  describe("benefits (PAY-22)", () => {
    let deduction: CompensationComponentView;
    let employerPart: CompensationComponentView;

    beforeAll(async () => {
      deduction = (await f.compensation.createCompensationComponent(f.hr, { name: `Health premium ${Date.now()}`, componentType: "deduction", calculationType: "fixed" } as never)) as CompensationComponentView;
      employerPart = (await f.compensation.createCompensationComponent(f.hr, { name: `Health employer ${Date.now()}`, componentType: "employer_contribution", calculationType: "fixed" } as never)) as CompensationComponentView;
    });

    const plan = (over: Record<string, unknown> = {}) =>
      benefits.upsertPlan(f.hr, {
        code: "HEALTH",
        name: "Health cover",
        benefitType: "health_insurance",
        employeeComponentId: deduction.id,
        employerComponentKey: employerPart.key,
        employeeContributionMode: "fixed",
        employeeContributionValue: 1500,
        minServiceMonths: 12,
        employmentTypes: ["permanent"],
        effectiveFrom: "2020-01-01",
        ...over,
      } as never);

    it("validates and stores plans per tenant, to people allowed to manage payroll", async () => {
      await expect(plan({ code: "bad code!" })).rejects.toBeInstanceOf(BadRequestException);
      await expect(plan({ name: " " })).rejects.toBeInstanceOf(BadRequestException);
      await expect(plan({ effectiveTo: "2019-01-01" })).rejects.toBeInstanceOf(BadRequestException);
      await expect(plan({ employeeContributionValue: -5 })).rejects.toBeInstanceOf(BadRequestException);
      await expect(plan({ employeeComponentId: "00000000-0000-0000-0000-000000000000" })).rejects.toBeInstanceOf(BadRequestException);
      await expect(plan({ employerComponentKey: "no_such_component" })).rejects.toBeInstanceOf(BadRequestException);
      await expect(benefits.upsertPlan(f.staff, { code: "X", name: "X", effectiveFrom: "2020-01-01" })).rejects.toBeInstanceOf(ForbiddenException);
      const created = await plan();
      expect(created).toMatchObject({ code: "HEALTH", employeeComponentKey: deduction.key, employerComponentKey: employerPart.key, employeeContributionValue: 1500, status: "active", enrolledCount: 0 });
      const renamed = await plan({ name: "Health cover plus" });
      expect(renamed.id).toBe(created.id);
      expect((await benefits.listPlans(f.hr)).map((p) => p.code)).toContain("HEALTH");
      expect(await otherBenefits.listPlans(other.hr)).toEqual([]);
      await expect(benefits.listPlans(f.staff)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("judges eligibility by service, employment type, area and dates, and says why", async () => {
      const p = await plan();
      const veteran = await f.createEmployee({ dateOfJoining: "2020-01-01", monthlySalary: 100000 });
      const fresh = await f.createEmployee({ dateOfJoining: "2100-12-01", monthlySalary: 100000 });
      expect(await benefits.checkEligibility(f.hr, p.id, veteran.id, "2101-01-01")).toMatchObject({ eligible: true, reasons: [] });
      const no = await benefits.checkEligibility(f.hr, p.id, fresh.id, "2101-01-01");
      expect(no.eligible).toBe(false);
      expect(no.reasons.join(" ")).toMatch(/Needs 12 month\(s\) of service; the employee has 1/);
      await f.sql("UPDATE employees SET employment_type = 'contract' WHERE id = $1", [veteran.id]);
      expect((await benefits.checkEligibility(f.hr, p.id, veteran.id, "2101-01-01")).reasons.join(" ")).toMatch(/permanent/);
      await f.sql("UPDATE employees SET employment_type = 'permanent' WHERE id = $1", [veteran.id]);
      expect((await benefits.checkEligibility(f.hr, p.id, veteran.id, "2019-01-01")).reasons.join(" ")).toMatch(/starts on 2020-01-01/);
      await expect(otherBenefits.checkEligibility(other.hr, p.id, veteran.id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("enrols an eligible employee through the pay component, accrues contributions from the payslip, and stops cleanly", async () => {
      const y = nextYear();
      const p = await plan();
      const emp = await f.createEmployee({ dateOfJoining: "2020-01-01", monthlySalary: 100000 });
      await f.compensation.setCompensationComponents(f.hr, { employeeId: emp.id, effectiveFrom: "2020-01-01", components: [{ componentId: employerPart.id, amount: 1100 }] } as never);
      const fresh = await f.createEmployee({ dateOfJoining: `${y}-01-01`, monthlySalary: 100000 });

      await expect(benefits.enrol(f.hr, { planId: p.id, employeeId: fresh.id, effectiveFrom: `${y}-01-15` })).rejects.toThrow(/Not eligible/);
      await expect(benefits.enrol(f.staff, { planId: p.id, employeeId: emp.id, effectiveFrom: `${y}-01-01` })).rejects.toBeInstanceOf(ForbiddenException);
      const waived = await benefits.enrol(f.hr, { planId: p.id, employeeId: fresh.id, effectiveFrom: `${y}-01-15`, waive: true });
      expect(waived.status).toBe("waived");
      expect((await f.compensation.getCompensationHistory(f.hr, fresh.id)).some((c) => c.componentId === deduction.id)).toBe(false);

      const e = await benefits.enrol(f.hr, { planId: p.id, employeeId: emp.id, effectiveFrom: `${y}-01-01`, coverageLevel: "family" });
      expect(e).toMatchObject({ status: "enrolled", planCode: "HEALTH", coverageLevel: "family", employeeNumber: emp.employeeNumber });
      const row = (await f.compensation.getCompensationHistory(f.hr, emp.id)).find((c) => c.componentId === deduction.id)!;
      expect(row).toMatchObject({ amount: 1500, effectiveFrom: `${y}-01-01` });
      await expect(benefits.enrol(f.hr, { planId: p.id, employeeId: emp.id, effectiveFrom: `${y}-02-01` })).rejects.toBeInstanceOf(ConflictException);
      expect((await benefits.listPlans(f.hr)).find((x) => x.id === p.id)!.enrolledCount).toBe(1);

      const jan = await f.finalizedRun(`${y}-01-01`, `${y}-01-31`);
      const accrued = await benefits.listContributions(f.hr, { planId: p.id, runId: jan });
      expect(accrued).toHaveLength(1);
      expect(accrued[0]).toMatchObject({ employeeId: emp.id, employeeAmount: 1500, employerAmount: 1100, status: "accrued", periodEnd: `${y}-01-31` });

      await expect(benefits.endEnrolment(f.hr, e.id, { effectiveTo: `${y}-01-31`, reason: "x" })).rejects.toBeInstanceOf(BadRequestException);
      const ended = await benefits.endEnrolment(f.hr, e.id, { effectiveTo: `${y}-01-31`, reason: "Left the scheme" });
      expect(ended).toMatchObject({ status: "ended", effectiveTo: `${y}-01-31`, endReason: "Left the scheme" });
      const stop = (await f.compensation.getCompensationHistory(f.hr, emp.id)).filter((c) => c.componentId === deduction.id).find((c) => c.effectiveFrom === `${y}-02-01`)!;
      expect(stop.amount).toBe(0);
      await expect(benefits.endEnrolment(f.hr, e.id, { effectiveTo: `${y}-02-28`, reason: "again" })).rejects.toBeInstanceOf(BadRequestException);

      const mar = await f.finalizedRun(`${y}-03-01`, `${y}-03-31`);
      expect(await benefits.listContributions(f.hr, { planId: p.id, runId: mar })).toHaveLength(0);

      await f.payroll.reverseRun(f.hr, jan, { reason: "Redo" });
      expect((await benefits.listContributions(f.hr, { planId: p.id, runId: jan }))[0].status).toBe("reversed");
      expect((await benefits.listEnrolments(f.hr, { employeeId: emp.id })).map((x) => x.status)).toEqual(["ended"]);
      expect(await otherBenefits.listEnrolments(other.hr, { employeeId: emp.id })).toEqual([]);
    }, 120000);
  });

  describe("payroll dashboard (PAY-25)", () => {
    it("shows active and recent runs with progress, partitions, payment and posting state, and what needs attention", async () => {
      await unmap();
      await mapAccounts();
      const y = nextYear();
      const done = await f.finalizedRun(`${y}-01-01`, `${y}-01-31`);
      await f.payroll.generateDisbursementFile(f.hr, done);
      await accounting.post(f.hr, (await accounting.generate(f.hr, done)).id);
      const draft = await f.payroll.createRun(f.hr, { periodStart: `${y}-02-01`, periodEnd: `${y}-02-28` });
      const async_ = await f.payroll.createRun(f.hr, { periodStart: `${y}-03-01`, periodEnd: `${y}-03-31` });
      await f.payroll.calculateRunAsync(f.hr, async_.id);
      // the job cuts the partitions when it starts; none is running here, so cut one by hand
      await f.sql(
        "INSERT INTO payroll_run_partitions (company_id, payroll_run_id, calculation_sequence, partition_no, employee_ids, employee_count) VALUES ($1, $2, 1, 1, '{}', 5)",
        [f.companyId, async_.id]
      );

      const d = await dashboard.get(f.hr);
      expect(d.runsByStatus.draft).toBeGreaterThanOrEqual(1);
      expect(d.active.find((r) => r.runId === draft.id)).toMatchObject({ status: "draft", paymentStatus: null, postingStatus: null });
      const calc = d.active.find((r) => r.runId === async_.id)!;
      expect(calc.status).toBe("calculating");
      expect(calc.partitions.total).toBeGreaterThanOrEqual(1);
      expect(calc.partitions.byState.pending).toBeGreaterThanOrEqual(1);
      expect(calc.progressPercent).toBe(0);
      expect(calc.jobStatus).toBe("queued");
      const fin = d.recent.find((r) => r.runId === done)!;
      expect(fin).toMatchObject({ status: "accounting", paymentStatus: "generated", postingStatus: "posted", progressPercent: 100 });
      expect(fin.totalNet).toBeGreaterThan(0);

      // a failed partition surfaces as something that needs attention
      await f.sql("UPDATE payroll_run_partitions SET state = 'failed', last_error = 'boom' WHERE payroll_run_id = $1", [async_.id]);
      const again = await dashboard.get(f.hr);
      expect(again.attention.some((a) => a.runId === async_.id && a.kind === "failed_partitions")).toBe(true);
      await f.sql("UPDATE payroll_run_partitions SET state = 'completed', calculated_count = employee_count, started_at = now() - interval '2 minutes', completed_at = now() - interval '1 minute' WHERE payroll_run_id = $1", [async_.id]);
      const progressed = (await dashboard.get(f.hr)).active.find((r) => r.runId === async_.id)!;
      expect(progressed.progressPercent).toBe(100);
    }, 120000);

    it("is closed to people without payroll access and to other tenants' runs", async () => {
      await expect(dashboard.get(f.staff)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(dashboard.get(f.approver)).resolves.toBeDefined();
      const theirs = await new PayrollDashboardService(other.db, other.rbac, other.entitlements).get(other.hr);
      expect([...theirs.active, ...theirs.recent]).toEqual([]);
    });
  });

  describe("bulk payroll inputs (PAY-26)", () => {
    const sal = "employeeNumber,componentKey,effectiveFrom,amount,percentage\n";
    const lastBatch = (batchId: string) => f.sql<{ status: string; imported_rows: number; failed_rows: number; checkpoint_row: number }>("SELECT status, imported_rows, failed_rows, checkpoint_row FROM import_batches WHERE id = $1", [batchId]);

    it("describes the templates and keeps the feature to payroll staff and their own tenant", async () => {
      expect(imports.templates().map((t) => t.importType)).toEqual(["payroll_components", "payroll_payments"]);
      expect(imports.templates()[0].example.split("\n")[0]).toContain("componentKey");
      await expect(imports.dryRun(f.staff, { importType: "payroll_components", csv: sal + "A,basic_salary,2102-01-01,1," })).rejects.toBeInstanceOf(ForbiddenException);
      const e = await f.createEmployee({ monthlySalary: 50000 });
      const b = await imports.dryRun(f.hr, { importType: "payroll_components", csv: `${sal}${e.employeeNumber},basic_salary,2102-01-01,51000,` });
      await expect(new PayrollInputImportService(other.db, other.rbac, other.entitlements, other.audit, other.jobs, other.compensation, other.additionalPayments).get(other.hr, b.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(f.sql("INSERT INTO import_batches (company_id, import_type, source_hash, config_hash) VALUES ($1, 'bogus', 'a', 'b')", [f.companyId])).rejects.toThrow(/import_type_check/);
    });

    it("validates every row without creating anything, then applies the valid ones through a background job", async () => {
      const a = await f.createEmployee({ monthlySalary: 50000 });
      const b = await f.createEmployee({ monthlySalary: 60000 });
      const csv = [
        sal.trim(),
        `${a.employeeNumber},basic_salary,2102-01-01,111111,`,
        `NOPE-1,basic_salary,2102-01-01,5,`,
        `${b.employeeNumber},basic_salary,2102-13-45,5,`,
        `${b.employeeNumber},basic_salary,2102-01-01,5,10`,
        `${a.employeeNumber},basic_salary,2102-01-01,222222,`,
        `${b.employeeNumber},ghost_component,2102-01-01,5,`,
        `${b.employeeNumber},basic_salary,2102-02-01,-4,`,
        `${b.employeeNumber},basic_salary,2102-03-01,66666,`,
      ].join("\n") + "\n";
      await expect(imports.dryRun(f.hr, { importType: "payroll_components", csv: "employeeNumber,amount\nX,1\n" })).rejects.toThrow(/Missing required column/);
      await expect(imports.dryRun(f.hr, { importType: "payroll_components", csv: sal.trim() + ",bonus\n" + `${a.employeeNumber},basic_salary,2102-01-01,1,,2\n` })).rejects.toThrow(/Unknown column/);
      await expect(imports.dryRun(f.hr, { importType: "payroll_components", csv: sal })).rejects.toThrow(/no data rows/);
      const dry = await imports.dryRun(f.hr, { importType: "payroll_components", csv, fileName: "salaries.csv" });
      expect(dry).toMatchObject({ status: "dry_run_complete", totalRows: 8, validRows: 2, invalidRows: 6, importedRows: 0 });
      const rows = await imports.rows(f.hr, dry.id);
      const errs = (n: number) => rows.find((r) => r.rowNumber === n)!.errors.map((e) => e.message).join("|");
      expect(errs(3)).toMatch(/No employee with the number/);
      expect(errs(4)).toMatch(/real date/);
      expect(errs(5)).toMatch(/not both/);
      expect(errs(6)).toMatch(/Same employee, component and date as row 2/);
      expect(errs(7)).toMatch(/No pay component/);
      expect(errs(8)).toMatch(/non-negative/);
      expect((await f.compensation.getCompensationHistory(f.hr, a.id)).some((c) => c.amount === 111111)).toBe(false); // a dry run changes nothing
      expect(await imports.errorReportCsv(f.hr, dry.id)).toMatch(/row,status,errors,employeeNumber/);

      await expect(imports.execute(f.hr, dry.id)).rejects.toThrow(/failed validation/);
      const partial = await imports.dryRun(f.hr, { importType: "payroll_components", csv, allowPartial: true });
      const queued = await imports.execute(f.hr, partial.id);
      expect(queued.status).toBe("queued");
      expect(queued.backgroundJobId).toBeTruthy();
      expect((await imports.execute(f.hr, partial.id)).status).toBe("queued"); // a retried execute returns the same batch
      await drain();
      expect((await lastBatch(partial.id))[0]).toMatchObject({ status: "completed", imported_rows: 2, failed_rows: 0 });
      const history = await f.compensation.getCompensationHistory(f.hr, a.id);
      expect(history.find((c) => c.effectiveFrom === "2102-01-01" && c.componentKey === "basic_salary")!.amount).toBe(111111);
      expect((await f.compensation.getCompensationHistory(f.hr, b.id)).find((c) => c.effectiveFrom === "2102-03-01")!.amount).toBe(66666);
      // the values are scrubbed from the stored rows once the batch is done
      const stored = await imports.rows(f.hr, partial.id, { status: "imported" });
      expect(stored).toHaveLength(2);
      expect(stored.every((r) => !("amount" in r.payload))).toBe(true);
      await expect(imports.execute(f.hr, dry.id)).rejects.toThrow(/failed validation/);
    }, 90000);

    it("is idempotent per key and refuses to run once the pay component catalog has changed", async () => {
      const e = await f.createEmployee({ monthlySalary: 50000 });
      const csv = `${sal}${e.employeeNumber},basic_salary,2103-01-01,70000,\n`;
      const one = await imports.dryRun(f.hr, { importType: "payroll_components", csv }, "key-1");
      expect((await imports.dryRun(f.hr, { importType: "payroll_components", csv }, "key-1")).id).toBe(one.id);
      await expect(imports.dryRun(f.hr, { importType: "payroll_components", csv: csv + `${e.employeeNumber},basic_salary,2103-02-01,71000,\n` }, "key-1")).rejects.toBeInstanceOf(ConflictException);
      await f.compensation.createCompensationComponent(f.hr, { name: `Extra ${Date.now()}`, componentType: "earning", calculationType: "fixed" } as never);
      await expect(imports.execute(f.hr, one.id)).rejects.toBeInstanceOf(ConflictException);
    }, 60000);

    it("resumes after its checkpoint, records a failing row without stopping the rest, retries it, and cancels cleanly", async () => {
      const es = [await f.createEmployee({ monthlySalary: 40000 }), await f.createEmployee({ monthlySalary: 41000 }), await f.createEmployee({ monthlySalary: 42000 })];
      const csv = sal + es.map((e, i) => `${e.employeeNumber},basic_salary,2104-0${i + 1}-01,${50000 + i},`).join("\n") + "\n";
      const batch = await imports.dryRun(f.hr, { importType: "payroll_components", csv });
      await imports.execute(f.hr, batch.id);
      // a crash after row 2: the first rows are done, the checkpoint says so
      await f.sql("UPDATE import_rows SET status = 'imported' WHERE batch_id = $1 AND row_number <= 3", [batch.id]);
      await f.sql("UPDATE import_batches SET checkpoint_row = 3, imported_rows = 2 WHERE id = $1", [batch.id]);
      await drain();
      expect((await lastBatch(batch.id))[0]).toMatchObject({ status: "completed", imported_rows: 3, checkpoint_row: 4 });
      expect((await f.compensation.getCompensationHistory(f.hr, es[0].id)).some((c) => c.effectiveFrom === "2104-01-01" && c.amount === 50000)).toBe(false); // not re-applied
      expect((await f.compensation.getCompensationHistory(f.hr, es[2].id)).some((c) => c.effectiveFrom === "2104-03-01" && c.amount === 50002)).toBe(true); // the unfinished row ran

      // one row's pay component disappears between the dry run and the run: that row fails, the other succeeds
      const x = await f.createEmployee({ monthlySalary: 40000 });
      const y = await f.createEmployee({ monthlySalary: 40000 });
      const withFailure = await imports.dryRun(f.hr, { importType: "payroll_components", csv: `${sal}${x.employeeNumber},basic_salary,2105-01-01,1000,\n${y.employeeNumber},basic_salary,2105-01-01,2000,\n` });
      await imports.execute(f.hr, withFailure.id);
      await f.sql(
        "UPDATE import_rows SET payload = jsonb_set(payload, '{componentId}', '\"00000000-0000-0000-0000-000000000000\"') WHERE batch_id = $1 AND employee_id = $2",
        [withFailure.id, x.id]
      ); // the component the row pointed at was removed after the dry run
      await drain();
      expect((await lastBatch(withFailure.id))[0]).toMatchObject({ status: "completed_with_errors", imported_rows: 1, failed_rows: 1 });
      const failed = await imports.rows(f.hr, withFailure.id, { status: "failed" });
      expect(failed[0].errors[0].message).toMatch(/component|not found/i);
      expect(await imports.errorReportCsv(f.hr, withFailure.id)).toMatch(/failed/);
      const retried = await imports.retryFailed(f.hr, withFailure.id);
      expect(retried.status).toBe("queued");
      await drain();
      expect((await lastBatch(withFailure.id))[0]).toMatchObject({ status: "completed_with_errors", failed_rows: 1 });
      await expect(imports.retryFailed(f.hr, batch.id)).rejects.toBeInstanceOf(ConflictException);

      const toCancel = await imports.dryRun(f.hr, { importType: "payroll_components", csv: `${sal}${y.employeeNumber},basic_salary,2106-01-01,3000,\n` });
      expect((await imports.cancel(f.hr, toCancel.id)).status).toBe("cancelled");
      expect((await imports.rows(f.hr, toCancel.id))[0].payload).not.toHaveProperty("amount");
      await expect(imports.execute(f.hr, toCancel.id)).rejects.toBeInstanceOf(ConflictException);
      expect((await imports.list(f.hr)).map((b) => b.importType)).toEqual(expect.arrayContaining(["payroll_components"]));
    }, 120000);

    it("imports one-time earnings and deductions as additional payments", async () => {
      const e = await f.createEmployee({ monthlySalary: 50000 });
      const pay = "employeeNumber,paymentType,amount,effectiveDate,label,isTaxable,reasonNote\n";
      const csv = pay + [
        `${e.employeeNumber},earning,25000,2107-01-15,Performance bonus,true,Q4`,
        `${e.employeeNumber},deduction,3000,2107-01-15,Canteen,,`,
        `${e.employeeNumber},refund,10,2107-01-15,Bad,,`,
        `${e.employeeNumber},earning,0,2107-01-15,Zero,,`,
        `${e.employeeNumber},earning,10,2107-01-15,,,`,
      ].join("\n") + "\n";
      const dry = await imports.dryRun(f.hr, { importType: "payroll_payments", csv, allowPartial: true });
      expect(dry).toMatchObject({ validRows: 2, invalidRows: 3 });
      await imports.execute(f.hr, dry.id);
      await drain();
      expect((await lastBatch(dry.id))[0]).toMatchObject({ status: "completed", imported_rows: 2 });
      const made = await f.additionalPayments.list(f.hr, e.id);
      expect(made.map((m) => [m.paymentType, m.label, m.amount]).sort()).toEqual([["deduction", "Canteen", 3000], ["earning", "Performance bonus", 25000]]);
      expect(made.find((m) => m.paymentType === "earning")!.isTaxable).toBe(true);
      expect(made.find((m) => m.paymentType === "deduction")!.isTaxable).toBe(false);
    }, 90000);
  });
});
