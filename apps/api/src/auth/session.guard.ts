import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import * as jwt from "jsonwebtoken";
import type { AuthedRequest } from "./platform-admin.guard";

type SessionTokenPayload = {
  sub: string;
  is_platform_admin: boolean;
  company_id?: string | null;
};

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
 */
@Injectable()
export class SessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
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

    req.claims = {
      sub: payload.sub,
      is_platform_admin: payload.is_platform_admin,
      company_id: payload.company_id ?? null,
    };
    return true;
  }
}
