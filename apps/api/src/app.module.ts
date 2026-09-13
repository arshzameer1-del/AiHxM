import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";

/**
 * Phase 1 root module: just the health check.
 *
 * Phase 2 adds PlatformAdminModule (companies, company_config,
 * company_admins, platform_admins, audit_log). Phase 4 adds the RBAC /
 * field-permission engine as a global module every subsequent feature
 * module depends on.
 */
@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
