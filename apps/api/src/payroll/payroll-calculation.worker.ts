import { ExclusiveCron } from "../common/cron-lock";
import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { BackgroundJobsService } from "../background-jobs/background-jobs.service";
import { PAYROLL_CALCULATION_JOB, PayrollService } from "./payroll.service";

// Only used to lease and report on the job row (background_jobs spans tenants); the calculation itself runs with
// the claims of the user who started it, so tenant isolation applies exactly as it does to an interactive call.
const SERVICE: RequestClaims = { is_platform_admin: false, is_service: true, sub: "payroll-calculation-worker" };

type CalculationPayload = Parameters<PayrollService["runCalculationJob"]>[0];

/**
 * Gap Register PAY-06 - drains `payroll_calculation` jobs. runOnce() leases one job (SKIP LOCKED, crash-safe
 * lease), runs it from wherever it stopped, and completes / fails the job. A job that has used all its attempts
 * puts the run back to draft with the reason, so nothing is left in `calculating` forever.
 */
@Injectable()
export class PayrollCalculationWorker {
  private readonly logger = new Logger(PayrollCalculationWorker.name);
  private busy = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly jobs: BackgroundJobsService,
    private readonly payroll: PayrollService
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  @ExclusiveCron("PayrollCalculationWorker.tick")
  async tick(): Promise<void> {
    if (this.busy || process.env.PAYROLL_WORKER_DISABLED === "true") return;
    this.busy = true;
    try {
      while (await this.runOnce(`payroll-worker-${process.pid}`)) {
        /* keep draining */
      }
    } catch (err) {
      this.logger.error(`payroll worker tick failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.busy = false;
    }
  }

  /** Returns true when a job was processed (successfully or not). */
  async runOnce(workerId: string): Promise<boolean> {
    const job = await this.db.withClaims(SERVICE, (c) => this.jobs.claimNext(c, workerId, { jobTypes: [PAYROLL_CALCULATION_JOB], leaseSeconds: 300 }));
    if (!job) return false;
    const payload = job.payload as unknown as CalculationPayload;
    try {
      const result = await this.payroll.runCalculationJob(payload, (percent, note) =>
        this.db.withClaims(SERVICE, (c) => this.jobs.reportProgress(c, job.id, percent, note))
      );
      await this.db.withClaims(SERVICE, (c) => this.jobs.complete(c, job.id, result ?? { skipped: true }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed = await this.db.withClaims(SERVICE, (c) => this.jobs.fail(c, job.id, message));
      if (failed.status === "failed") await this.payroll.failCalculationJob(payload, message);
      this.logger.warn(`payroll calculation ${payload.runId} attempt ${job.attempts} failed: ${message}`);
    }
    return true;
  }
}
