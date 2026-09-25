import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import * as jwt from "jsonwebtoken";
import type { RequestClaims } from "../database/tenant-context";
import { SessionSecurityService } from "./session-security.service";

export type AuthedRequest = Request & { claims: RequestClaims };

export type SessionTokenPayload = {
  sub: string;
  is_platform_admin: boolean;
  company_id?: string | null;
  /** Session id (also `user_sessions.id`) — absent only on tokens minted
   *  before sessions existed. "Login As" impersonation tokens carry a real
   *  one too, as of Tenant Management gap-fill Phase 1 item #4; see
   *  SessionSecurityService's doc comment. */
  jti?: string;
};

/**
 * Verifies a real session JWT issued by AuthService (Phase 3 — password +
 * mandatory MFA; see auth.service.ts) and requires is_platform_admin.
 *
 * Deliberately reads exactly three fields off the decoded payload rather
 * than assigning it wholesale to req.claims: RequestClaims also has an
 * `is_service` field that must never originate from a client-supplied
 * token (see tenant-context.ts and migration 0002's header comment) —
 * whitelisting fields here is what makes that true by construction, not
 * just by the fact that forging a JWT without JWT_SECRET is already
 * impossible.
 *
 * Also checks `jti` against `SessionSecurityService.isRevoked()` — the
 * Tenant Management "Force Logout" feature revokes a `user_sessions` row,
 * and without this check that revocation had no actual effect on a token
 * already in someone's browser (it would just keep working until its own
 * 12h expiry).
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
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

    if (!payload.is_platform_admin) {
      throw new UnauthorizedException("Platform admin access required");
    }

    if (await this.sessionSecurity.isRevoked(payload.jti)) {
      throw new UnauthorizedException("This session has been signed out remotely. Please log in again.");
    }

    req.claims = {
      sub: payload.sub,
      is_platform_admin: payload.is_platform_admin,
      company_id: payload.company_id ?? null,
    };
    return true;
  }
}
