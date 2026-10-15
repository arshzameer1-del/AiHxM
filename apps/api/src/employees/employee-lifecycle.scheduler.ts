import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { EmployeeLifecycleService } from "./employee-lifecycle.service";

/**
 * LIF-03: applies future-dated lifecycle actions on their effective date.
 * Same shape as OrgChangeExecutionScheduler: a plain hourly cron around a
 * service method that is also called directly by the tests.
 */
@Injectable()
export class EmployeeLifecycleScheduler {
  private readonly logger = new Logger(EmployeeLifecycleScheduler.name);
  constructor(private readonly lifecycle: EmployeeLifecycleService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleSweep(): Promise<void> {
    const applied = await this.lifecycle.executeDueEvents();
    if (applied > 0) this.logger.log(`Applied ${applied} scheduled lifecycle action(s)`);
  }
}
