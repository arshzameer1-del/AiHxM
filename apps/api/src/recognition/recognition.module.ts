import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { MailerModule } from "../mailer/mailer.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { RbacModule } from "../rbac/rbac.module";
import { RecognitionController } from "./recognition.controller";
import { RecognitionService } from "./recognition.service";

@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule, MailerModule, NotificationsModule],
  controllers: [RecognitionController],
  providers: [RecognitionService],
  exports: [RecognitionService],
})
export class RecognitionModule {}
