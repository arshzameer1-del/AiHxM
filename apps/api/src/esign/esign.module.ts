import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { MailerModule } from "../mailer/mailer.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { RbacModule } from "../rbac/rbac.module";
import { EsignController } from "./esign.controller";
import { EsignService } from "./esign.service";

@Module({ imports: [RbacModule, EntitlementsModule, AuditModule, MailerModule, NotificationsModule], controllers: [EsignController], providers: [EsignService], exports: [EsignService] })
export class EsignModule {}
