import { Module } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Injectable, Logger } from "@nestjs/common";
import { WorkflowController } from "./workflow.controller";
import { WorkflowService } from "./workflow.service";
import { WorkflowAdapterRegistry } from "./workflow-adapter.registry";
import { InboxService } from "./inbox.service";
import { InboxController, DelegationsController } from "./inbox.controller";
import { DelegationsService } from "./delegations.service";
import { RbacModule } from "../rbac/rbac.module";
import { AuditModule } from "../audit/audit.module";
import { FileStorageModule } from "../file-storage/file-storage.module";
import { NotificationsModule } from "../notifications/notifications.module";

/**
 * Wraps the SLA sweeps in recurring triggers. Plain @nestjs/schedule cron rather
 * than BullMQ/Redis: each sweep is a single idempotent DB pass that is trivially
 * testable by calling the method directly (see KNOWN_ISSUES.md).
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
    const reminded = await this.workflow.remindDue();
    if (reminded > 0) this.logger.log(`Recorded ${reminded} workflow reminder(s)`);
  }
}

@Module({
  imports: [RbacModule, AuditModule, FileStorageModule, NotificationsModule],
  controllers: [WorkflowController, InboxController, DelegationsController],
  providers: [WorkflowAdapterRegistry, WorkflowService, InboxService, DelegationsService, WorkflowEscalationScheduler],
  exports: [WorkflowService, WorkflowAdapterRegistry, InboxService, DelegationsService],
})
export class WorkflowModule {}
