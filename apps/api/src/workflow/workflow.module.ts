import { Module } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Injectable, Logger } from "@nestjs/common";
import { WorkflowController } from "./workflow.controller";
import { WorkflowService } from "./workflow.service";
import { RbacModule } from "../rbac/rbac.module";
import { AuditModule } from "../audit/audit.module";

/**
 * Wraps WorkflowService.escalateOverdue in a real recurring trigger for
 * production use. A plain @nestjs/schedule cron rather than BullMQ/Redis
 * (the plan doc's original Section 8 pick for "SLA timers") — see
 * KNOWN_ISSUES.md for the reasoning: a single idempotent DB sweep, run
 * every few minutes, needs no extra infrastructure and is trivially
 * testable by calling escalateOverdue() directly, which is exactly what
 * this phase's automated test suite does rather than waiting on a timer.
 */
@Injectable()
class WorkflowEscalationScheduler {
  private readonly logger = new Logger(WorkflowEscalationScheduler.name);
  constructor(private readonly workflow: WorkflowService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleEscalationSweep() {
    const count = await this.workflow.escalateOverdue();
    if (count > 0) {
      this.logger.log(`Escalated ${count} overdue workflow approval(s)`);
    }
  }
}

@Module({
  imports: [RbacModule, AuditModule],
  controllers: [WorkflowController],
  providers: [WorkflowService, WorkflowEscalationScheduler],
  exports: [WorkflowService],
})
export class WorkflowModule {}
