import { Module } from "@nestjs/common";
import { EmployeesController } from "./employees.controller";
import { EmployeesService } from "./employees.service";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AuditModule } from "../audit/audit.module";
import { FileStorageModule } from "../file-storage/file-storage.module";
import { WebhooksModule } from "../webhooks/webhooks.module";

@Module({
  // Phase 3 item #4 — WebhooksModule is deliberately slim (exports only
  // WebhookDispatchService, imports nothing of ours) specifically so this
  // module can depend on it without pulling in TenantManagementModule —
  // see WebhooksModule's own doc comment.
  imports: [RbacModule, EntitlementsModule, AuditModule, FileStorageModule, WebhooksModule],
  controllers: [EmployeesController],
  providers: [EmployeesService],
  exports: [EmployeesService],
})
export class EmployeesModule {}
