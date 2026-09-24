import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import * as jwt from "jsonwebtoken";
import type { AuthedRequest, SessionTokenPayload } from "./platform-admin.guard";
import { SessionSecurityService } from "./session-security.service";

/**
 * Accepts any real session JWT issued by AuthService — Platform Admin or
 * Company Super Admin (and, from Phase 7 on, Employee/Manager, once those
 * exist) — unlike PlatformAdminGuard, which additionally requires
 * `is_platform_admin`. The RBAC engine (rbac.service.ts) is explicitly
 * for "ordinary end-user roles" (plan doc Section 3), so its endpoints
 * need a guard that doesn't gate on admin tier at all; the engine itself
 * is what decides what a given session can actually see.
 *
 * Same field-whitelisting discipline as PlatformAdminGuard, for the same
 * reason: `is_service` must never originate from a client-supplied token.
 *
 * Also checks (a) `jti` revocation, same as PlatformAdminGuard, and (b)
 * the token's own company's lifecycle status via
 * `SessionSecurityService.companyAccessStatus()` — Tenant Lock (TM-030)
 * and Suspend (TM-005) are both real gaps otherwise: `companies.status`
 * could already be set to `suspended` (migration 0001), but nothing in
 * the request path ever actually checked it, so a "suspended" tenant's
 * existing logged-in sessions kept working exactly as before. An
 * impersonation ("Login As") token has no `jti` to revoke individually,
 * but IS a normal company-scoped token, so it's still blocked the moment
 * the company it targets is locked/suspended/archived.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessionSecurity: SessionSecurityService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing bearer token");
    }

    const token = header.slice("Bearer ".length);
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error("JWT_SECRET is not set");
    }

    let payload: SessionTokenPayload;
    try {
      payload = jwt.verify(token, secret) as SessionTokenPayload;
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }

    if (await this.sessionSecurity.isRevoked(payload.jti)) {
      throw new UnauthorizedException("This session has been signed out remotely. Please log in again.");
    }

    if (payload.company_id) {
      const status = await this.sessionSecurity.companyAccessStatus(payload.company_id);
      if (status !== "ok") {
        throw new UnauthorizedException(
          status === "not_found"
            ? "This company no longer exists."
            : `Access to this company has been ${status}. Contact your Platform Admin.`
        );
      }
    }

    req.claims = {
      sub: payload.sub,
      is_platform_admin: payload.is_platform_admin,
      company_id: payload.company_id ?? null,
    };
    return true;
  }
}
