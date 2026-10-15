import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { BackgroundJobsService } from "../background-jobs/background-jobs.service";
import { PAYROLL_INPUT_IMPORT_JOB, PayrollInputImportService } from "./payroll-input-import.service";

const SERVICE: RequestClaims = { is_platform_admin: false, is_service: true, sub: "payroll-input-import-worker" };

/** PAY-26 - drains `payroll_input_import` jobs; the same lease / retry shape as the employee import worker. */
@Injectable()
export class PayrollInputImportWorker {
  private readonly logger = new Logger(PayrollInputImportWorker.name);
  private busy = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly jobs: BackgroundJobsService,
    private readonly imports: PayrollInputImportService
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async tick(): Promise<void> {
    if (this.busy || process.env.IMPORT_WORKER_DISABLED === "true") return;
    this.busy = true;
    try {
      while (await this.runOnce(`payroll-input-worker-${process.pid}`)) {
        /* keep draining */
      }
    } catch (err) {
      this.logger.error(`payroll input import tick failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.busy = false;
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async hygiene(): Promise<void> {
    await this.imports.expireStaleBatches();
  }

  /** Returns true when a job was processed (successfully or not). */
  async runOnce(workerId: string): Promise<boolean> {
    const job = await this.db.withClaims(SERVICE, (c) => this.jobs.claimNext(c, workerId, { jobTypes: [PAYROLL_INPUT_IMPORT_JOB], leaseSeconds: 300 }));
    if (!job) return false;
    const batchId = String((job.payload as { batchId?: string }).batchId ?? "");
    try {
      await this.imports.processBatch(batchId, (percent, note) => this.db.withClaims(SERVICE, (c) => this.jobs.reportProgress(c, job.id, percent, note)));
      await this.db.withClaims(SERVICE, (c) => this.jobs.complete(c, job.id, { batchId }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed = await this.db.withClaims(SERVICE, (c) => this.jobs.fail(c, job.id, message));
      await this.imports.recordJobFailure(batchId, message, failed.status === "failed");
      this.logger.warn(`payroll input import ${batchId} attempt ${job.attempts} failed: ${message}`);
    }
    return true;
  }
}
