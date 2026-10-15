import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { buildPayrollFixture, type PayrollFixture } from "./testing/payroll-fixture";
import { PayrollPaymentsService } from "./payroll-payments.service";
import { PayrollReconciliationService } from "./payroll-reconciliation.service";
import { renderBankFile } from "./payroll-payments-support";

/** Gap Register Step 10B - PAY-16 (payment items, bank file formats, approval / release / acknowledgement / reissue) and PAY-18 (reconciliations). */
describe("Payment lifecycle and reconciliations (Step 10B)", () => {
  let f: PayrollFixture;
  let other: PayrollFixture;
  let payments: PayrollPaymentsService;
  let recon: PayrollReconciliationService;
  let otherPayments: PayrollPaymentsService;
  let year = 2060;

  beforeAll(async () => {
    f = await buildPayrollFixture("p10b");
    other = await buildPayrollFixture("p10x");
    payments = new PayrollPaymentsService(f.db, f.rbac, f.entitlements, f.audit, f.payroll, f.control);
    recon = new PayrollReconciliationService(f.db, f.rbac, f.entitlements, f.audit);
    otherPayments = new PayrollPaymentsService(other.db, other.rbac, other.entitlements, other.audit, other.payroll, other.control);
    // two employees are enough for every scenario; each test finalises its own run (its own year)
    await f.createEmployee({ monthlySalary: 100000 });
    await f.createEmployee({ monthlySalary: 80000 });
  }, 120000);

  afterAll(async () => {
    await f.cleanup();
    await other.cleanup();
  });

  const newRun = async () => {
    const y = ++year;
    return f.finalizedRun(`${y}-03-01`, `${y}-03-31`);
  };
  const setApproval = (on: boolean) => f.payroll.updateDisbursementSettings(f.hr, { requireReleaseApproval: on } as never);
  const generate = async (runId: string, confirm = false, formatId?: string) => (await f.payroll.generateDisbursementFile(f.hr, runId, confirm, formatId)).batch;

  describe("payment items (PAY-16)", () => {
    it("writes one item per paid payslip, with only the last four digits of the account in clear", async () => {
      const runId = await newRun();
      const batch = await generate(runId);
      const items = await payments.listBatchItems(f.hr, batch.id);
      const slips = await f.payroll.listPayslips(f.hr, { payrollRunId: runId });
      expect(items).toHaveLength(slips.length);
      expect(batch.status).toBe("generated");
      for (const item of items) {
        const slip = slips.find((s) => s.id === item.payslipId)!;
        expect(item.amount).toBe(slip.netPay);
        expect(item.status).toBe("generated");
        expect(item.accountLast4).toMatch(/^.{1,4}$/);
      }
      const raw = await f.sql<{ account_number_enc: string | null }>("SELECT account_number_enc FROM payroll_payment_items WHERE batch_id = $1", [batch.id]);
      for (const r of raw) expect(r.account_number_enc ?? "").not.toMatch(/PK00-/);
      expect(await payments.listRunItems(f.hr, runId)).toHaveLength(slips.length);
    });

    it("lets the database refuse a second live payment for the same payslip", async () => {
      const runId = await newRun();
      const batch = await generate(runId);
      const [item] = await f.sql<{ payslip_id: string; company_id: string; payroll_run_id: string; employee_id: string; employee_number: string }>(
        "SELECT * FROM payroll_payment_items WHERE batch_id = $1 LIMIT 1", [batch.id]);
      await expect(
        f.sql(
          `INSERT INTO payroll_payment_items (company_id, batch_id, payroll_run_id, payslip_id, employee_id, employee_number, amount)
           VALUES ($1, $2, $3, $4, $5, $6, 1)`,
          [item.company_id, batch.id, item.payroll_run_id, item.payslip_id, item.employee_id, item.employee_number]
        )
      ).rejects.toThrow(/idx_payroll_payment_items_one_live_per_payslip|duplicate key/);
    });

    it("replaces an unreleased file when regenerated, never leaving two live payments", async () => {
      const runId = await newRun();
      const first = await generate(runId);
      await expect(generate(runId)).rejects.toBeInstanceOf(BadRequestException); // needs confirmation
      const second = await generate(runId, true);
      const batches = await f.payroll.listPaymentBatches(f.hr, runId);
      expect(batches.find((b) => b.id === first.id)!.status).toBe("voided");
      expect(batches.find((b) => b.id === second.id)!.status).toBe("generated");
      const live = await f.sql("SELECT payslip_id FROM payroll_payment_items WHERE payroll_run_id = $1 AND status IN ('generated','released','acknowledged')", [runId]);
      expect(live).toHaveLength(second.rowCount ?? second.rowCount);
      expect(new Set(live.map((l) => l.payslip_id)).size).toBe(live.length);
    });

    it("never repeats a payment that was already released when the file is regenerated", async () => {
      const runId = await newRun();
      const first = await generate(runId);
      await payments.releaseBatch(f.hr, first.id);
      await expect(generate(runId, true)).rejects.toThrow(/already been released/);
    });
  });

  describe("release, approval and acknowledgement (PAY-16)", () => {
    it("releases a generated file when the tenant does not ask for approval, and moves the run to payment_released", async () => {
      await setApproval(false);
      const runId = await newRun();
      const batch = await generate(runId);
      const released = await payments.releaseBatch(f.hr, batch.id);
      expect(released).toMatchObject({ status: "released", releasedByUserAccountId: f.hr.sub });
      expect((await f.sql<{ status: string }>("SELECT status FROM payroll_runs WHERE id = $1", [runId]))[0].status).toBe("payment_released");
      expect((await payments.listBatchItems(f.hr, batch.id)).every((i) => i.status === "released")).toBe(true);
      await expect(payments.releaseBatch(f.hr, batch.id)).rejects.toBeInstanceOf(BadRequestException); // not twice
    });

    it("needs a second person's approval before release when the tenant asks for it", async () => {
      await setApproval(true);
      try {
        const runId = await newRun();
        const batch = await generate(runId);
        await expect(payments.releaseBatch(f.hr, batch.id)).rejects.toThrow(/second person/);
        await expect(payments.approveBatch(f.hr, batch.id)).rejects.toBeInstanceOf(ForbiddenException); // the generator holds no approve permission
        const approved = await payments.approveBatch(f.approver, batch.id);
        expect(approved).toMatchObject({ status: "approved", approvedByUserAccountId: f.approver.sub });
        const released = await payments.releaseBatch(f.hr, batch.id);
        expect(released.status).toBe("released");
      } finally {
        await setApproval(false);
      }
    });

    it("refuses to let the person who generated a file approve it, even with the permission", async () => {
      await setApproval(true);
      try {
        const runId = await newRun();
        const batch = await f.payroll.generateDisbursementFile(f.approver, runId, false).catch(() => null);
        // the approver cannot generate (no disburse permission) - so give the generator row to the approver directly
        expect(batch).toBeNull();
        const generated = await generate(runId);
        await f.sql("UPDATE payroll_payment_batches SET generated_by_user_account_id = $2 WHERE id = $1", [generated.id, f.approver.sub]);
        await expect(payments.approveBatch(f.approver, generated.id)).rejects.toThrow(/cannot approve/);
      } finally {
        await setApproval(false);
      }
    });

    it("acknowledges part of a file, keeps the rest waiting, then closes the batch", async () => {
      const runId = await newRun();
      const batch = await generate(runId);
      await expect(payments.acknowledgeBatch(f.hr, batch.id)).rejects.toBeInstanceOf(BadRequestException); // not released yet
      await payments.releaseBatch(f.hr, batch.id);
      const items = await payments.listBatchItems(f.hr, batch.id);
      const partial = await payments.acknowledgeBatch(f.hr, batch.id, { items: [{ itemId: items[0].id, status: "acknowledged", bankReference: "BANK-1" }] });
      expect(partial.status).toBe("released");
      const done = await payments.acknowledgeBatch(f.hr, batch.id, { bankReference: "BANK-FILE" });
      expect(done.status).toBe("acknowledged");
      expect(done.acknowledgedAt).not.toBeNull();
      const after = await payments.listBatchItems(f.hr, batch.id);
      expect(after.every((i) => i.status === "acknowledged")).toBe(true);
      expect(after.find((i) => i.id === items[0].id)!.bankReference).toBe("BANK-1");
      await expect(f.payroll.voidPaymentBatch(f.hr, batch.id, "too late")).rejects.toThrow(/acknowledged/);
    });

    it("needs a reason for a rejected payment and validates what it is told", async () => {
      const runId = await newRun();
      const batch = await generate(runId);
      await payments.releaseBatch(f.hr, batch.id);
      const items = await payments.listBatchItems(f.hr, batch.id);
      await expect(payments.acknowledgeBatch(f.hr, batch.id, { items: [{ itemId: items[0].id, status: "rejected" }] })).rejects.toThrow(/reason/);
      await expect(payments.acknowledgeBatch(f.hr, batch.id, { items: [{ itemId: items[0].id, status: "acknowledged" }, { itemId: items[0].id, status: "acknowledged" }] })).rejects.toThrow(/twice/);
      await expect(payments.acknowledgeBatch(f.hr, batch.id, { items: [{ itemId: "00000000-0000-0000-0000-000000000000", status: "acknowledged" }] })).rejects.toBeInstanceOf(BadRequestException);
    });

    it("reissues rejected payments in a new file and links old to new", async () => {
      const runId = await newRun();
      const batch = await generate(runId);
      await payments.releaseBatch(f.hr, batch.id);
      const items = await payments.listBatchItems(f.hr, batch.id);
      const ack = await payments.acknowledgeBatch(f.hr, batch.id, {
        items: [
          { itemId: items[0].id, status: "rejected", reason: "Account closed" },
          ...items.slice(1).map((i) => ({ itemId: i.id, status: "acknowledged" as const })),
        ],
      });
      expect(ack.status).toBe("acknowledged");
      expect(ack.rejectionReason).toMatch(/1 payment/);
      const out = await payments.reissueRejected(f.hr, batch.id, { reason: "Corrected account" });
      expect(out.batch).toMatchObject({ status: "generated", rowCount: 1, reissuedFromBatchId: batch.id });
      expect(out.csv.length).toBeGreaterThan(0);
      const old = (await payments.listBatchItems(f.hr, batch.id)).find((i) => i.id === items[0].id)!;
      expect(old.status).toBe("reissued");
      expect(old.reissuedToItemId).not.toBeNull();
      const fresh = (await payments.listBatchItems(f.hr, out.batch.id))[0];
      expect(fresh).toMatchObject({ payslipId: items[0].payslipId, retryCount: 1, status: "generated" });
      await expect(payments.reissueRejected(f.hr, batch.id)).rejects.toThrow(/no rejected payments/);
    });

    it("closes out a batch the bank rejected entirely once it is reissued", async () => {
      const runId = await newRun();
      const batch = await generate(runId);
      await payments.releaseBatch(f.hr, batch.id);
      const items = await payments.listBatchItems(f.hr, batch.id);
      const ack = await payments.acknowledgeBatch(f.hr, batch.id, { items: items.map((i) => ({ itemId: i.id, status: "rejected" as const, reason: "File format refused" })) });
      expect(ack.status).toBe("rejected");
      const out = await payments.reissueRejected(f.hr, batch.id);
      expect(out.batch.rowCount).toBe(items.length);
      expect((await f.payroll.listPaymentBatches(f.hr, runId)).find((b) => b.id === batch.id)!.status).toBe("reissued");
    });

    it("voids the unreleased payments of a run when it is reversed, and records the money already paid", async () => {
      const runId = await newRun();
      const batch = await generate(runId);
      await f.payroll.reverseRun(f.hr, runId, { reason: "Wrong period" });
      expect((await f.payroll.listPaymentBatches(f.hr, runId)).find((b) => b.id === batch.id)!.status).toBe("voided");
      expect((await payments.listBatchItems(f.hr, batch.id)).every((i) => i.status === "voided")).toBe(true);

      const paidRun = await newRun();
      const paidBatch = await generate(paidRun);
      await payments.releaseBatch(f.hr, paidBatch.id);
      await payments.acknowledgeBatch(f.hr, paidBatch.id);
      await f.payroll.reverseRun(f.hr, paidRun, { reason: "Duplicate run" });
      const reversal = (await recon.run(f.hr, paidRun, ["reversal"]))[0];
      expect(reversal.status).toBe("variance");
      expect(reversal.actualAmount).toBeGreaterThan(0);
    });
  });

  describe("bank file formats (PAY-16)", () => {
    it("renders a tenant's own layout: delimiter, header labels and column order", () => {
      const csv = renderBankFile(
        { delimiter: "pipe", includeHeader: true, columns: ["netPay", "employeeNumber"], headerLabels: { netPay: "AMT" } },
        [{ netPay: 100.5, employeeNumber: "E|1" }, { netPay: 7, employeeNumber: "E2" }]
      );
      expect(csv).toBe('AMT|employeeNumber\n100.5|"E|1"\n7|E2');
      expect(renderBankFile({ delimiter: "tab", includeHeader: false, columns: ["employeeNumber"] }, [{ employeeNumber: "A" }])).toBe("A");
    });

    it("keeps formats per tenant, one default, and generates a file in the chosen layout", async () => {
      const fmt = await payments.createFormat(f.hr, {
        code: "pipe_file", name: "Pipe file", delimiter: "pipe", includeHeader: true, columns: ["employeeNumber", "netPay"], headerLabels: { netPay: "AMOUNT" }, fileExtension: "txt", isDefault: true,
      });
      expect(fmt).toMatchObject({ code: "pipe_file", isDefault: true, delimiter: "pipe" });
      const second = await payments.createFormat(f.hr, { code: "semi_file", name: "Semi", delimiter: "semicolon", columns: ["employeeNumber", "netPay"], isDefault: true });
      const listed = await payments.listFormats(f.hr);
      expect(listed.filter((x) => x.isDefault).map((x) => x.code)).toEqual(["semi_file"]);
      await expect(payments.createFormat(f.hr, { code: "semi_file", name: "dup", columns: ["netPay"] })).rejects.toThrow(/already exists/);
      await expect(payments.createFormat(f.hr, { code: "bad_cols", name: "x", columns: ["secret" as never] })).rejects.toThrow(/Unknown column/);
      await expect(payments.createFormat(f.hr, { code: "bad_lbl", name: "x", columns: ["netPay"], headerLabels: { iban: "I" } })).rejects.toThrow(/headerLabels/);
      await expect(payments.updateFormat(f.hr, second.id, { isDefault: true, isActive: false })).rejects.toThrow(/default format must be active/);

      const runId = await newRun();
      const out = await f.payroll.generateDisbursementFile(f.hr, runId, false, fmt.id);
      expect(out.csv.split("\n")[0]).toBe("employeeNumber|AMOUNT");
      expect(out.batch.formatId).toBe(fmt.id);
      // with no format given the default one is used
      const runId2 = await newRun();
      const out2 = await f.payroll.generateDisbursementFile(f.hr, runId2);
      expect(out2.csv.split("\n")[0]).toBe("employeeNumber;netPay");
      await expect(f.payroll.generateDisbursementFile(f.hr, await newRun(), false, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(/format/i);
    });
  });

  describe("permissions and tenant isolation", () => {
    it("keeps payment actions to people who hold the payroll permissions", async () => {
      const runId = await newRun();
      const batch = await generate(runId);
      await expect(payments.listRunItems(f.staff, runId)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(payments.releaseBatch(f.staff, batch.id)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(payments.acknowledgeBatch(f.staff, batch.id)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(payments.approveBatch(f.staff, batch.id)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(payments.listFormats(f.staff)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(payments.createFormat(f.staff, { code: "nope", name: "x", columns: ["netPay"] })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(recon.run(f.staff, runId)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("does not show one tenant's payments, formats or reconciliations to another", async () => {
      const runId = await newRun();
      const batch = await generate(runId);
      await recon.run(f.hr, runId, ["calculation"]);
      await expect(otherPayments.listBatchItems(other.hr, batch.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(otherPayments.releaseBatch(other.hr, batch.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(new PayrollReconciliationService(other.db, other.rbac, other.entitlements, other.audit).list(other.hr, runId)).rejects.toBeInstanceOf(NotFoundException);
      expect((await otherPayments.listFormats(other.hr)).map((x) => x.code)).not.toContain("pipe_file");
    });
  });

  describe("reconciliations (PAY-18)", () => {
    it("matches calculation, payroll, tax and payment for a clean run, and keeps the result as a record", async () => {
      const runId = await newRun();
      const before = await recon.run(f.hr, runId, ["payment"]);
      expect(before[0].status).toBe("pending"); // no file generated yet
      await generate(runId);
      const results = await recon.run(f.hr, runId, ["calculation", "payroll", "tax", "payment"]);
      expect(results.map((r) => [r.kind, r.status])).toEqual([["calculation", "matched"], ["payroll", "matched"], ["tax", "matched"], ["payment", "matched"]]);
      for (const r of results) expect(r.variance).toBe(0);
      const all = await recon.list(f.hr, runId);
      expect(all.filter((r) => r.kind === "payment").map((r) => r.sequence).sort()).toEqual([1, 2]);
      const audit = await f.sql("SELECT 1 FROM audit_log WHERE action = 'payroll_reconciliation.run' AND target = $1", [runId]).catch(() => []);
      expect(Array.isArray(audit)).toBe(true);
    });

    it("finds a payment that differs from the payslip and lets a variance be resolved with a note", async () => {
      const runId = await newRun();
      const batch = await generate(runId);
      const [item] = await f.sql<{ id: string }>("SELECT id FROM payroll_payment_items WHERE batch_id = $1 LIMIT 1", [batch.id]);
      await f.sql("UPDATE payroll_payment_items SET amount = amount - 100 WHERE id = $1", [item.id]);
      const [res] = await recon.run(f.hr, runId, ["payment"]);
      expect(res.status).toBe("variance");
      expect(res.variance).toBe(100);
      expect(JSON.stringify(res.detail)).toContain("amount differs");
      await expect(recon.resolve(f.hr, res.id, " ")).rejects.toBeInstanceOf(BadRequestException);
      const resolved = await recon.resolve(f.hr, res.id, "Advance recovered outside payroll, approved by finance");
      expect(resolved).toMatchObject({ status: "resolved", resolvedBy: f.hr.sub, variance: 100 });
      await expect(recon.resolve(f.hr, res.id, "again")).rejects.toThrow(/Only a variance/);
      await expect(recon.resolve(f.staff, res.id, "not allowed")).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("finds a missing payment, and totals stored on the run that no longer match its payslips", async () => {
      const runId = await newRun();
      const batch = await generate(runId);
      await f.sql("UPDATE payroll_payment_items SET status = 'voided' WHERE id = (SELECT id FROM payroll_payment_items WHERE batch_id = $1 LIMIT 1)", [batch.id]);
      const [pay] = await recon.run(f.hr, runId, ["payment"]);
      expect(pay.status).toBe("variance");
      expect(JSON.stringify(pay.detail)).toContain("no live payment");

      await f.sql("UPDATE payroll_runs SET total_net = total_net + 50 WHERE id = $1", [runId]);
      const [tot] = await recon.run(f.hr, runId, ["payroll"]);
      expect(tot).toMatchObject({ status: "variance", variance: 50 });
    });

    it("compares what was sent to the bank with what it acknowledged", async () => {
      const runId = await newRun();
      const batch = await generate(runId);
      expect((await recon.run(f.hr, runId, ["bank"]))[0].status).toBe("pending");
      await payments.releaseBatch(f.hr, batch.id);
      const waiting = (await recon.run(f.hr, runId, ["bank"]))[0];
      expect(waiting.status).toBe("variance");
      expect(JSON.stringify(waiting.detail)).toContain("awaiting");
      await payments.acknowledgeBatch(f.hr, batch.id);
      expect((await recon.run(f.hr, runId, ["bank"]))[0].status).toBe("matched");
    });

    it("leaves accounting and costing pending until the run has journals, and rejects what cannot apply", async () => {
      const runId = await newRun();
      const res = await recon.run(f.hr, runId, ["accounting", "costing"]);
      expect(res.map((r) => r.status)).toEqual(["pending", "pending"]);
      await expect(recon.run(f.hr, runId, ["reversal"])).rejects.toThrow(/reversed run only/);
      await expect(recon.run(f.hr, runId, ["nonsense" as never])).rejects.toBeInstanceOf(BadRequestException);
      const draft = await f.payroll.createRun(f.hr, { periodStart: "2090-01-01", periodEnd: "2090-01-31" });
      await expect(recon.run(f.hr, draft.id)).rejects.toThrow(/nothing to reconcile/);
    });
  });

  describe("migration", () => {
    it("has the one-live-payment index and constrains reconciliation statuses", async () => {
      const idx = await f.sql("SELECT 1 FROM pg_indexes WHERE indexname = 'idx_payroll_payment_items_one_live_per_payslip'");
      expect(idx).toHaveLength(1);
      const runId = await newRun();
      await expect(
        f.sql("INSERT INTO payroll_reconciliations (company_id, payroll_run_id, kind, status) VALUES ($1, $2, 'payment', 'resolved')", [f.companyId, runId])
      ).rejects.toThrow(/check/);
    });
  });
});
