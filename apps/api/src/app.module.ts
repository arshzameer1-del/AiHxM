import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { DatabaseModule } from "./database/database.module";
import { AuthModule } from "./auth/auth.module";
import { CompaniesModule } from "./companies/companies.module";
import { AuditModule } from "./audit/audit.module";
import { PlatformAdminsModule } from "./platform-admins/platform-admins.module";
import { RbacModule } from "./rbac/rbac.module";
import { DummyModule } from "./dummy/dummy.module";

/**
 * Phase 2/3/4 root module: health check, the Platform Provisioning Panel
 * (companies, config, admins, audit log), Platform Admin management, real
 * auth (password + mandatory MFA), and the RBAC / field-permission engine
 * every subsequent tenant-facing feature module (starting with Employee
 * Core, Phase 7) is built against.
 */
@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    CompaniesModule,
    AuditModule,
    PlatformAdminsModule,
    RbacModule,
    DummyModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
