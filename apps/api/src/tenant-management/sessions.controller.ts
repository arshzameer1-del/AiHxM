import { Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { SessionsService } from "./sessions.service";

// No common path prefix: this controller intentionally serves both
// /platform/sessions/... (TM-029) and /platform/users/:id/sessions/...
// (TM-017), exactly as the spec's own Route column names them, rather
// than forcing both under one prefix that neither route actually uses.
@Controller()
@UseGuards(PlatformAdminGuard)
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  // TM-029 Tenant Security tab: GET /platform/sessions?companyId=...
  @Get("platform/sessions")
  list(@CurrentClaims() claims: RequestClaims, @Query("companyId") companyId?: string) {
    return this.sessions.list(claims, companyId || undefined);
  }

  // TM-029 Tenant Security tab: per-row Revoke.
  @Post("platform/sessions/:id/revoke")
  async revokeOne(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    await this.sessions.revokeOne(claims, id);
    return { message: "Session revoked." };
  }

  // TM-017 Tenant Users tab: Force Logout — every session for this user.
  @Post("platform/users/:userAccountId/sessions/revoke")
  async revokeAllForUser(@CurrentClaims() claims: RequestClaims, @Param("userAccountId") userAccountId: string) {
    const revokedCount = await this.sessions.revokeAllForUser(claims, userAccountId);
    return { message: `Signed out ${revokedCount} active session(s).`, revokedCount };
  }
}
