import { Module } from "@nestjs/common";
import { EmployeesController } from "./employees.controller";
import { EmployeesService } from "./employees.service";
import { PersonsService } from "./persons.service";
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
  // Core Employee Enterprise Phase 1 — PersonsService lives here, not its
  // own module, deliberately: see that service's own class doc comment.
  // Exported too, so a later phase's own module (Hiring Process Engine)
  // can read persons without duplicating this provider.
  providers: [EmployeesService, PersonsService],
  exports: [EmployeesService, PersonsService],
})
export class EmployeesModule {}
