import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { DatabaseModule } from "./database/database.module";
import { AuthModule } from "./auth/auth.module";
import { CompaniesModule } from "./companies/companies.module";
import { AuditModule } from "./audit/audit.module";
import { PlatformAdminsModule } from "./platform-admins/platform-admins.module";

/**
 * Phase 2/3 root module: health check, the Platform Provisioning Panel
 * (companies, config, admins, audit log), Platform Admin management, and
 * real auth (password + mandatory MFA). Phase 4 adds the RBAC /
 * field-permission engine as a module every subsequent tenant-facing
 * feature module depends on.
 */
@Module({
  imports: [DatabaseModule, AuthModule, CompaniesModule, AuditModule, PlatformAdminsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
