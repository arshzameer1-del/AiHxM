import { Injectable, Logger, Module } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { CompaniesController } from "./companies.controller";
import { CompaniesService } from "./companies.service";
import { TenantProvisioningController } from "./tenant-provisioning.controller";
import { AuditModule } from "../audit/audit.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { FileStorageModule } from "../file-storage/file-storage.module";
import { MailerModule } from "../mailer/mailer.module";
import type { RequestClaims } from "../database/tenant-context";

const SWEEP_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "companies-lifecycle-sweep" };

/**
 * TM-038's grace-period purge — same shape as WorkflowModule's
 * WorkflowEscalationScheduler (a plain @nestjs/schedule cron wrapping one
 * directly-testable, idempotent service method; see
 * CompaniesService.purgeExpiredDeletions's own doc comment for why this
 * pattern rather than BullMQ/Redis).
 */
@Injectable()
class CompaniesLifecycleScheduler {
  private readonly logger = new Logger(CompaniesLifecycleScheduler.name);
  constructor(private readonly companies: CompaniesService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleDeletionGraceSweep() {
    const count = await this.companies.purgeExpiredDeletions(SWEEP_CLAIMS);
    if (count > 0) {
      this.logger.log(`Archived ${count} company(ies) whose deletion grace period elapsed`);
    }
  }
}

@Module({
  imports: [AuditModule, EntitlementsModule, FileStorageModule, MailerModule],
  controllers: [CompaniesController, TenantProvisioningController],
  providers: [CompaniesService, CompaniesLifecycleScheduler],
})
export class CompaniesModule {}
