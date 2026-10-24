import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { SchedulesService } from "./schedules.service";

/** Delivers due report schedules every five minutes and removes stored files after their 14 days. Set REPORT_SCHEDULER_DISABLED=true to pause on one instance. */
@Injectable()
export class ReportScheduleWorker {
  private readonly logger = new Logger(ReportScheduleWorker.name);
  private busy = false;
  constructor(private readonly schedules: SchedulesService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    if (process.env.REPORT_SCHEDULER_DISABLED === "true" || this.busy) return;
    this.busy = true;
    try {
      const n = await this.schedules.runDue();
      if (n > 0) this.logger.log(`Delivered ${n} scheduled report(s)`);
    } catch (e) {
      this.logger.warn(`Report schedule run failed: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async purge(): Promise<void> {
    if (process.env.REPORT_SCHEDULER_DISABLED === "true") return;
    try {
      const n = await this.schedules.purgeExpiredFiles();
      if (n > 0) this.logger.log(`Removed ${n} expired report file(s)`);
    } catch (e) {
      this.logger.warn(`Report file cleanup failed: ${(e as Error).message}`);
    }
  }
}
