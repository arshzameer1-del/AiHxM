import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { FileStorageModule } from "../file-storage/file-storage.module";
import { MailerModule } from "../mailer/mailer.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { RbacModule } from "../rbac/rbac.module";
import { RecruitmentModule } from "../recruitment/recruitment.module";
import { CareersAdminController, PublicCareersController } from "./careers.controller";
import { CareersService } from "./careers.service";

@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule, FileStorageModule, MailerModule, NotificationsModule, RecruitmentModule],
  controllers: [CareersAdminController, PublicCareersController],
  providers: [CareersService],
})
export class CareersModule {}
