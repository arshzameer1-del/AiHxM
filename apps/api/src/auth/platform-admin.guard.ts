import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import * as jwt from "jsonwebtoken";
import type { RequestClaims } from "../database/tenant-context";

export type AuthedRequest = Request & { claims: RequestClaims };

/**
 * Phase 2 stand-in for real auth. There is exactly one identity this
 * guard can ever produce — the shared platform-admin dev credential from
 * PlatformAuthController — because Phase 2's whole scope is the internal
 * Platform Admin panel, not tenant end-user login. Phase 3 (Auth &
 * Identity) replaces this guard's verify step with real Supabase Auth JWT
 * verification and starts producing company-scoped, non-platform-admin
 * claims too; RequestClaims and runInTenantContext() do not need to
 * change when that happens, only what populates them.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
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

    let payload: RequestClaims;
    try {
      payload = jwt.verify(token, secret) as RequestClaims;
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }

    if (!payload.is_platform_admin) {
      throw new UnauthorizedException("Platform admin access required");
    }

    req.claims = payload;
    return true;
  }
}
