import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import * as jwt from "jsonwebtoken";
import type { RequestClaims } from "../database/tenant-context";
import { SessionSecurityService } from "./session-security.service";
import { SCOPED_COMPANY_PARAM } from "./scoped-company-param.decorator";

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
  constructor(
    private readonly sessionSecurity: SessionSecurityService,
    private readonly reflector: Reflector
  ) {}

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

    // Phase 2 gap-fill item #7 — Platform Admin delegation. A 'read_only'
    // admin can reach every route a 'full' admin can (GET), but anything
    // that mutates state is rejected here, uniformly, before any handler
    // runs — no per-route opt-in needed for this half of the feature.
    // 'scoped' additionally requires the target company (read off the
    // route param the controller class named via @ScopedCompanyParam) to
    // be one this admin was explicitly granted.
    const access = await this.sessionSecurity.getPlatformAdminAccess(payload.sub);

    if (access.accessLevel === "read_only" && req.method !== "GET") {
      throw new ForbiddenException(
        "Your Platform Admin access is read-only — this action requires full access."
      );
    }

    if (access.accessLevel === "scoped") {
      const paramName = this.reflector.getAllAndOverride<string | undefined>(SCOPED_COMPANY_PARAM, [
        context.getHandler(),
        context.getClass(),
      ]);
      const targetCompanyId = paramName ? req.params[paramName] : undefined;
      if (targetCompanyId && !access.scopedCompanyIds.includes(targetCompanyId)) {
        throw new ForbiddenException("This tenant is outside your assigned access scope.");
      }
    }

    req.claims = {
      sub: payload.sub,
      is_platform_admin: payload.is_platform_admin,
      company_id: payload.company_id ?? null,
      platformAdminAccessLevel: access.accessLevel,
      platformAdminScopedCompanyIds: access.scopedCompanyIds,
      // Phase 2 gap-fill item #2 — lets StepUpGuard key a step-up grant to
      // this exact session, same `jti` the revocation check above already
      // trusts.
      sessionId: payload.jti,
    };
    return true;
  }
}
