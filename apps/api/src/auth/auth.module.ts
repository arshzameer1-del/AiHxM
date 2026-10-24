import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { MailerModule } from "../mailer/mailer.module";
import { AccountSecurityController } from "./account-security.controller";
import { AccountSecurityService } from "./account-security.service";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { PlatformAdminGuard } from "./platform-admin.guard";
import { SessionGuard } from "./session.guard";
import { StepUpGuard } from "./step-up.guard";
import { StepUpService } from "./step-up.service";
import { SessionSecurityModule } from "./session-security.module";

@Module({
  // AuditModule — Phase 3 item #8's `auth.suspicious_login` event, written
  // in the same transaction as the `user_sessions` insert (see
  // AuthService.issueSessionToken's doc comment).
  imports: [EntitlementsModule, MailerModule, SessionSecurityModule, AuditModule],
  controllers: [AuthController, AccountSecurityController],
  providers: [AuthService, AccountSecurityService, PlatformAdminGuard, SessionGuard, StepUpGuard, StepUpService],
  exports: [AuthService, PlatformAdminGuard, SessionGuard, StepUpGuard, SessionSecurityModule],
})
export class AuthModule {}
