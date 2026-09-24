import { Module } from "@nestjs/common";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { MailerModule } from "../mailer/mailer.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { PlatformAdminGuard } from "./platform-admin.guard";
import { SessionGuard } from "./session.guard";
import { SessionSecurityModule } from "./session-security.module";

@Module({
  imports: [EntitlementsModule, MailerModule, SessionSecurityModule],
  controllers: [AuthController],
  providers: [AuthService, PlatformAdminGuard, SessionGuard],
  exports: [AuthService, PlatformAdminGuard, SessionGuard, SessionSecurityModule],
})
export class AuthModule {}
