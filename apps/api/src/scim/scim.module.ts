import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { SsoModule } from "../sso/sso.module";
import { ScimController } from "./scim.controller";
import { ScimAdminController } from "./scim-admin.controller";
import { ScimService } from "./scim.service";
import { ScimAuthGuard } from "./scim-auth.guard";

/**
 * Phase 3 item #1, slice 3 — SCIM 2.0 inbound provisioning. Depends on
 * SsoModule for `SsoService.resolveRoleKey()` (the exact same default-role
 * logic OIDC/SAML JIT provisioning already uses) and on AuthModule for
 * `SessionSecurityModule` (force-ending sessions on deprovisioning — see
 * ScimService.setAccountActive()'s doc comment).
 */
@Module({
  imports: [AuditModule, AuthModule, SsoModule],
  controllers: [ScimController, ScimAdminController],
  providers: [ScimService, ScimAuthGuard],
})
export class ScimModule {}
