import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { MailerModule } from "../mailer/mailer.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { RbacModule } from "../rbac/rbac.module";
import { HelpdeskController } from "./helpdesk.controller";
import { HelpdeskService } from "./helpdesk.service";

@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule, MailerModule, NotificationsModule],
  controllers: [HelpdeskController],
  providers: [HelpdeskService],
  exports: [HelpdeskService],
})
export class HelpdeskModule {}
