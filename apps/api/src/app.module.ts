import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { DatabaseModule } from "./database/database.module";
import { AuthModule } from "./auth/auth.module";
import { CompaniesModule } from "./companies/companies.module";
import { AuditModule } from "./audit/audit.module";

/**
 * Phase 2 root module: health check plus the Platform Provisioning Panel
 * (companies, config, admins, audit log, auth). Phase 4 adds the RBAC /
 * field-permission engine as a module every subsequent tenant-facing
 * feature module depends on.
 */
@Module({
  imports: [DatabaseModule, AuthModule, CompaniesModule, AuditModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
