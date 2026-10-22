import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { AttendanceAutoCloseService } from "./attendance-auto-close.service";

/** Hourly sweep: a clock-in with no clock-out from an earlier day gets the shift end time as its clock-out. */
@Injectable()
export class AttendanceAutoCloseScheduler {
  private readonly logger = new Logger(AttendanceAutoCloseScheduler.name);
  constructor(private readonly autoClose: AttendanceAutoCloseService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleSweep(): Promise<void> {
    try {
      const closed = await this.autoClose.closeAllDue();
      if (closed > 0) this.logger.log(`Auto clock-out applied to ${closed} forgotten record(s)`);
    } catch (err) {
      this.logger.warn(`Auto clock-out sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
