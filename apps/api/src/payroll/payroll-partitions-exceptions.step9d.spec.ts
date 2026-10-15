import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { buildPayrollFixture, type PayrollFixture } from "./testing/payroll-fixture";
import { PayrollCalculationWorker } from "./payroll-calculation.worker";
import { PAYROLL_CALCULATION_JOB } from "./payroll.service";

/** Gap Register Step 9D - PAY-06: partitions, background calculation, failure isolation and the exception queue. */
describe("Payroll partitions, background calculation and exceptions (Step 9D)", () => {
  let f: PayrollFixture;
  let other: PayrollFixture;
  let worker: PayrollCalculationWorker;
  const previousSize = process.env.PAYROLL_PARTITION_SIZE;

  beforeAll(async () => {
    process.env.PAYROLL_PARTITION_SIZE = "2";
    f = await buildPayrollFixture("par");
    other = await buildPayrollFixture("par2");
    worker = new PayrollCalculationWorker(f.db, f.jobs, f.payroll);
  }, 90000);

  afterAll(async () => {
    if (previousSize === undefined) delete process.env.PAYROLL_PARTITION_SIZE;
    else process.env.PAYROLL_PARTITION_SIZE = previousSize;
    await f.cleanup();
    await other.cleanup();
  });

  async function drain() {
    let n = 0;
    while (await worker.runOnce("test-worker")) n++;
    return n;
  }

  describe("immediate calculation feeds the exception queue", () => {
    it("records a failing employee, and a recalculation supersedes the earlier exception", async () => {
      const ok = await f.createEmployee({ monthlySalary: 90000 });
      const broken = await f.createEmployee({ monthlySalary: null });
      const run = await f.payroll.createRun(f.hr, { periodStart: "2038-01-01", periodEnd: "2038-01-31" });
      const res = await f.payroll.calculateRun(f.hr, run.id);
      expect(res.errors.map((e) => e.employeeId)).toContain(broken.id);
      expect(res.run.failedCount).toBeGreaterThanOrEqual(1);
      const open = await f.control.listExceptions(f.hr, run.id, "open");
      const mine = open.find((e) => e.employeeId === broken.id)!;
      expect(mine).toMatchObject({ exceptionClass: "calculation", status: "open", calculationSequence: 1, retryCount: 0 });
      expect(mine.employeeNumber).toBe(broken.employeeNumber);
      expect(open.find((e) => e.employeeId === ok.id)).toBeUndefined();

      await f.payroll.calculateRun(f.hr, run.id);
      const after = await f.control.listExceptions(f.hr, run.id);
      expect(after.find((e) => e.id === mine.id)!.status).toBe("superseded");
      const fresh = after.find((e) => e.employeeId === broken.id && e.status === "open")!;
      expect(fresh.calculationSequence).toBe(2);
    });
  });

  describe("background calculation", () => {
    it("queues, partitions, calculates and finishes - and matches an immediate calculation of the same data", async () => {
      for (let i = 0; i < 3; i++) await f.createEmployee({ monthlySalary: 80000 + i * 10000 });
      const run = await f.payroll.createRun(f.hr, { periodStart: "2038-02-01", periodEnd: "2038-02-28" });
      const started = await f.payroll.calculateRunAsync(f.hr, run.id);
      expect(started.run.status).toBe("calculating");
      expect(started.jobId).toBeTruthy();
      const job = (await f.sql<{ job_type: string; status: string }>("SELECT job_type, status FROM background_jobs WHERE id = $1", [started.jobId]))[0];
      expect(job).toMatchObject({ job_type: PAYROLL_CALCULATION_JOB, status: "queued" });

      // while it is queued nothing else may calculate or reuse the run
      await expect(f.payroll.calculateRun(f.hr, run.id)).rejects.toThrow(/background/);
      await expect(f.payroll.calculateRunAsync(f.hr, run.id)).rejects.toThrow(/background/);
      await expect(f.payroll.submitForApproval(f.hr, run.id)).rejects.toBeInstanceOf(BadRequestException);

      expect(await drain()).toBe(1);
      const progress = await f.control.getCalculationProgress(f.hr, run.id);
      expect(progress).toMatchObject({ status: "calculated", calculationMode: "async", jobStatus: "completed", progressPercent: 100, calculationSequence: 1 });
      expect(progress.partitionCount).toBeGreaterThan(1); // size 2 and more than 2 employees
      expect(progress.partitionsCompleted).toBe(progress.partitionCount);
      expect(progress.partitions.every((p) => p.state === "completed")).toBe(true);
      expect(progress.partitions.reduce((a, p) => a + p.employeeCount, 0)).toBeGreaterThanOrEqual(3);

      const asyncRun = await f.payroll.getRun(f.hr, run.id);
      expect(asyncRun.status).toBe("calculated");
      expect(asyncRun.calculationMode).toBe("async");
      expect(asyncRun.ruleSnapshotId).toBeTruthy();
      const asyncSlips = await f.payroll.listPayslips(f.hr, { payrollRunId: run.id });
      expect(asyncSlips.length).toBeGreaterThanOrEqual(3);
      const detail = await f.payroll.getPayslipDetail(f.hr, asyncSlips[0].id);
      expect(detail.components.length).toBeGreaterThan(0);
      expect(detail.calculationSequence).toBe(1);

      // the population of the calculation is recorded, with the failing employee marked as such
      const population = await f.control.listPopulation(f.hr, run.id);
      expect(population.length).toBe(asyncRun.populationCount);
      expect(population.filter((p) => p.status === "calculated").length).toBe(asyncSlips.length);

      // identical numbers to the immediate path
      const key = (s: { employeeId: string; grossPay: number; netPay: number; incomeTaxMonthly: number }) => `${s.employeeId}:${s.grossPay}:${s.netPay}:${s.incomeTaxMonthly}`;
      const before = asyncSlips.map(key).sort();
      await f.payroll.calculateRun(f.hr, run.id);
      const syncSlips = await f.payroll.listPayslips(f.hr, { payrollRunId: run.id });
      expect(syncSlips.map(key).sort()).toEqual(before);
      expect((await f.payroll.getRun(f.hr, run.id)).calculationMode).toBe("sync");
    });

    it("a failing employee never stops the rest; the retry works once the data is fixed", async () => {
      const broken = await f.createEmployee({ monthlySalary: null });
      const run = await f.payroll.createRun(f.hr, { periodStart: "2038-03-01", periodEnd: "2038-03-31" });
      await f.payroll.calculateRunAsync(f.hr, run.id);
      await drain();
      const calculated = await f.payroll.getRun(f.hr, run.id);
      expect(calculated.status).toBe("calculated");
      expect(calculated.failedCount).toBeGreaterThanOrEqual(1);
      const slipsBefore = await f.payroll.listPayslips(f.hr, { payrollRunId: run.id });
      expect(slipsBefore.find((s) => s.employeeId === broken.id)).toBeUndefined();
      expect(slipsBefore.length).toBe(calculated.populationCount - calculated.failedCount);

      const ex = (await f.control.listExceptions(f.hr, run.id, "open")).find((e) => e.employeeId === broken.id)!;
      expect(ex.payrollPartitionId).toBeTruthy();
      const parts = (await f.control.getCalculationProgress(f.hr, run.id)).partitions;
      expect(parts.reduce((a, p) => a + p.failedCount, 0)).toBe(calculated.failedCount);

      // retry while still broken: stays open, retry count moves
      const again = await f.payroll.retryException(f.hr, run.id, ex.id);
      expect(again.resolved).toBe(false);
      expect(again.exception).toMatchObject({ status: "open", retryCount: 1 });
      expect(again.exception.lastRetryAt).toBeTruthy();

      // fix the data (give them a salary), retry again
      await f.compensation.setCompensation(f.hr, { employeeId: broken.id, monthlySalary: 70000, effectiveFrom: "2020-01-01" });
      const fixed = await f.payroll.retryException(f.hr, run.id, ex.id);
      expect(fixed.resolved).toBe(true);
      expect(fixed.exception).toMatchObject({ status: "resolved", resolution: "retried", retryCount: 2 });
      const slipsAfter = await f.payroll.listPayslips(f.hr, { payrollRunId: run.id });
      const mine = slipsAfter.find((s) => s.employeeId === broken.id)!;
      expect(mine).toBeDefined();
      expect(slipsAfter.length).toBe(slipsBefore.length + 1);
      expect((await f.payroll.getPayslipDetail(f.hr, mine.id)).calculationSequence).toBe(1);
      const afterRun = await f.payroll.getRun(f.hr, run.id);
      expect(afterRun.failedCount).toBe(calculated.failedCount - 1);
      expect(afterRun.totals!.gross).toBeCloseTo(slipsAfter.reduce((a, s) => a + s.grossPay, 0), 2);
      const pop = (await f.control.listPopulation(f.hr, run.id)).find((p) => p.employeeId === broken.id)!;
      expect(pop.status).toBe("calculated");
      // a resolved exception cannot be retried again
      await expect(f.payroll.retryException(f.hr, run.id, ex.id)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("a retry is refused once the rules have changed since the run was calculated", async () => {
      const broken = await f.createEmployee({ monthlySalary: null });
      const run = await f.payroll.createRun(f.hr, { periodStart: "2038-04-01", periodEnd: "2038-04-30" });
      await f.payroll.calculateRunAsync(f.hr, run.id);
      await drain();
      const ex = (await f.control.listExceptions(f.hr, run.id, "open")).find((e) => e.employeeId === broken.id)!;
      await f.compensation.setCompensation(f.hr, { employeeId: broken.id, monthlySalary: 65000, effectiveFrom: "2020-01-01" });
      await f.payroll.updateSettings(f.hr, { eobiEmployeeRatePercent: 3 });
      try {
        await expect(f.payroll.retryException(f.hr, run.id, ex.id)).rejects.toBeInstanceOf(ConflictException);
        // the whole run recalculated under the new rules is the way forward, and it works
        await f.payroll.calculateRun(f.hr, run.id);
        expect((await f.payroll.listPayslips(f.hr, { payrollRunId: run.id })).find((s) => s.employeeId === broken.id)).toBeDefined();
      } finally {
        await f.payroll.updateSettings(f.hr, { eobiEmployeeRatePercent: 1 });
      }
    });

    it("waiving an exception leaves the employee out knowingly and says why", async () => {
      const broken = await f.createEmployee({ monthlySalary: null });
      const run = await f.payroll.createRun(f.hr, { periodStart: "2038-05-01", periodEnd: "2038-05-31" });
      await f.payroll.calculateRunAsync(f.hr, run.id);
      await drain();
      const ex = (await f.control.listExceptions(f.hr, run.id, "open")).find((e) => e.employeeId === broken.id)!;
      await expect(f.control.waiveException(f.hr, run.id, ex.id, "x")).rejects.toBeInstanceOf(BadRequestException);
      const before = (await f.payroll.getRun(f.hr, run.id)).failedCount;
      const waived = await f.control.waiveException(f.hr, run.id, ex.id, "Contract still being drawn up; paid off-cycle");
      expect(waived).toMatchObject({ status: "waived", resolution: "waived" });
      expect(waived.resolvedBy).toBe(f.hr.sub);
      expect((await f.payroll.getRun(f.hr, run.id)).failedCount).toBe(before - 1);
      const pop = (await f.control.listPopulation(f.hr, run.id)).find((p) => p.employeeId === broken.id)!;
      expect(pop.status).toBe("excluded");
      expect(pop.exclusionReason).toMatch(/off-cycle/);
      await expect(f.control.waiveException(f.hr, run.id, ex.id, "second attempt works?")).rejects.toBeInstanceOf(BadRequestException);
    });

    it("resumes after a crash: completed partitions are kept, the remaining ones are calculated", async () => {
      const run = await f.payroll.createRun(f.hr, { periodStart: "2038-06-01", periodEnd: "2038-06-30" });
      const started = await f.payroll.calculateRunAsync(f.hr, run.id);
      // simulate a worker that crashed after the start phase and the first partition: do those two steps by hand
      const jobRow = (await f.sql<{ payload: any }>("SELECT payload FROM background_jobs WHERE id = $1", [started.jobId]))[0]; // eslint-disable-line @typescript-eslint/no-explicit-any
      let reported = 0;
      await expect(
        f.payroll.runCalculationJob(jobRow.payload, async () => {
          reported++;
          if (reported === 2) throw new Error("simulated crash after the first partition");
        })
      ).rejects.toThrow(/simulated crash/);
      const mid = await f.control.getCalculationProgress(f.hr, run.id);
      expect(mid.status).toBe("calculating");
      expect(mid.partitions.filter((p) => p.state === "completed").length).toBe(1);
      const firstSlips = (await f.payroll.listPayslips(f.hr, { payrollRunId: run.id })).length;
      expect(firstSlips).toBeGreaterThan(0);

      // the real worker now picks the (still leased/queued) job up again
      await f.sql("UPDATE background_jobs SET status = 'queued', locked_until = NULL, run_after = now() WHERE id = $1", [started.jobId]);
      await drain();
      const done = await f.control.getCalculationProgress(f.hr, run.id);
      expect(done.status).toBe("calculated");
      expect(done.partitions.every((p) => p.state === "completed")).toBe(true);
      expect(done.calculationSequence).toBe(1); // one snapshot, not a restart
      const slips = await f.payroll.listPayslips(f.hr, { payrollRunId: run.id });
      expect(new Set(slips.map((s) => s.employeeId)).size).toBe(slips.length); // nobody calculated twice
      const finished = await f.payroll.getRun(f.hr, run.id);
      expect(slips.length).toBe(finished.populationCount - finished.failedCount);
    });

    it("a job that keeps failing puts the run back to draft with the reason and a system exception", async () => {
      const run = await f.payroll.createRun(f.hr, { periodStart: "2038-07-01", periodEnd: "2038-07-31" });
      const started = await f.payroll.calculateRunAsync(f.hr, run.id);
      await f.sql("UPDATE background_jobs SET max_attempts = 1 WHERE id = $1", [started.jobId]);
      // change the rules after the run has started its first partition so every attempt fails the rule check
      const jobRow = (await f.sql<{ payload: any }>("SELECT payload FROM background_jobs WHERE id = $1", [started.jobId]))[0]; // eslint-disable-line @typescript-eslint/no-explicit-any
      let reported = 0;
      await expect(
        f.payroll.runCalculationJob(jobRow.payload, async () => {
          reported++;
          if (reported === 1) {
            await f.payroll.updateSettings(f.hr, { eobiEmployeeRatePercent: 4 });
          }
        })
      ).rejects.toThrow(/rules .* have changed/i);
      try {
        await drain(); // the worker's own attempt: fails again, exhausts the job and fails the run
      } finally {
        await f.payroll.updateSettings(f.hr, { eobiEmployeeRatePercent: 1 });
      }
      const after = await f.payroll.getRun(f.hr, run.id);
      expect(after.status).toBe("draft");
      const progress = await f.control.getCalculationProgress(f.hr, run.id);
      expect(progress.lastError).toMatch(/rules .* have changed/i);
      const sys = (await f.control.listExceptions(f.hr, run.id)).find((e) => e.employeeId === null)!;
      expect(sys.exceptionClass).toBe("rule_change");
      const events = await f.control.listEvents(f.hr, run.id);
      expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(["calculate_start", "calculate_failed"]));
      // and the run can be calculated again normally
      const ok = await f.payroll.calculateRun(f.hr, run.id);
      expect(ok.run.status).toBe("calculated");
    });
  });

  describe("permissions and tenant isolation", () => {
    it("needs payroll permissions to queue a calculation or read the queue", async () => {
      const run = await f.payroll.createRun(f.hr, { periodStart: "2038-08-01", periodEnd: "2038-08-31" });
      await expect(f.payroll.calculateRunAsync(f.staff, run.id)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(f.control.listExceptions(f.staff, run.id)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(f.control.getCalculationProgress(f.staff, run.id)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(f.control.waiveException(f.staff, run.id, "00000000-0000-0000-0000-000000000000", "not allowed to")).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("another company can neither see nor act on this company's partitions and exceptions", async () => {
      const broken = await f.createEmployee({ monthlySalary: null });
      const run = await f.payroll.createRun(f.hr, { periodStart: "2038-09-01", periodEnd: "2038-09-30" });
      await f.payroll.calculateRunAsync(f.hr, run.id);
      await drain();
      const ex = (await f.control.listExceptions(f.hr, run.id, "open")).find((e) => e.employeeId === broken.id)!;

      const seen = await other.db.withClaims(other.hr, async (c) => ({
        partitions: (await c.query("SELECT 1 FROM payroll_run_partitions WHERE payroll_run_id = $1", [run.id])).rowCount,
        exceptions: (await c.query("SELECT 1 FROM payroll_exceptions WHERE payroll_run_id = $1", [run.id])).rowCount,
      }));
      expect(seen).toEqual({ partitions: 0, exceptions: 0 });
      expect(await other.control.listExceptions(other.hr, run.id)).toEqual([]);
      await expect(other.payroll.retryException(other.hr, run.id, ex.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(other.payroll.calculateRunAsync(other.hr, run.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(other.control.waiveException(other.hr, run.id, ex.id, "should not be possible")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("a payroll run's worker payload carries only the caller's identity, never a service identity", async () => {
      const run = await f.payroll.createRun(f.hr, { periodStart: "2038-10-01", periodEnd: "2038-10-31" });
      const started = await f.payroll.calculateRunAsync(f.hr, run.id);
      const payload = (await f.sql<{ payload: { claims: Record<string, unknown> } }>("SELECT payload FROM background_jobs WHERE id = $1", [started.jobId]))[0].payload;
      expect(payload.claims).toEqual({ sub: f.hr.sub, company_id: f.companyId, is_platform_admin: false });
      await drain();
    });
  });

  describe("migration 0145", () => {
    it("is additive: the new tables are tenant-scoped, RLS-forced and keyed uniquely", async () => {
      const rows = await f.sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('payroll_run_partitions','payroll_exceptions')"
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
      // one open exception per employee per calculation, enforced by the database
      const run = await f.payroll.createRun(f.hr, { periodStart: "2038-11-01", periodEnd: "2038-11-30" });
      const emp = await f.createEmployee({ monthlySalary: null });
      await f.payroll.calculateRun(f.hr, run.id);
      await expect(
        f.sql(
          `INSERT INTO payroll_exceptions (company_id, payroll_run_id, employee_id, calculation_sequence, message) VALUES ($1,$2,$3,1,'dup')`,
          [f.companyId, run.id, emp.id]
        )
      ).rejects.toThrow(/duplicate key|payroll_exceptions_open_uq/);
    });
  });
});
