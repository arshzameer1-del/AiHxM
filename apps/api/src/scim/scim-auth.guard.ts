import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { createHash, timingSafeEqual } from "crypto";
import type { Request } from "express";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

export type ScimAuthedRequest = Request & { claims: RequestClaims; scimCompanyId: string };

/** Never carries a real user's claims — the bearer-token equivalent of SsoService's own SERVICE_CLAIMS. */
export const SCIM_SERVICE_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "scim-service" };

export function hashScimToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Authenticates every inbound SCIM request. Unlike every other guard in
 * this codebase, there is no session JWT here at all: an IdP's SCIM
 * connector authenticates with a single, long-lived, per-tenant bearer
 * token (RFC 7644 §2's "OAuth Bearer Token" scheme — the one authentication
 * mode every major IdP's SCIM app configuration actually offers), generated
 * once by a Platform Admin from that tenant's Integrations tab
 * (ScimAdminController) and pasted into the IdP's own SCIM setup screen.
 *
 * The company is resolved from the URL's `:companySlug` segment (an IdP's
 * "SCIM connector base URL" setting IS this whole prefix, the same
 * "company recovered from a fixed URL, not a header" shape `SsoController`
 * already uses for `:companySlug/login`), then the presented token is
 * hashed and compared — in constant time, since this is a real
 * bearer-credential check, not a cosmetic lookup — against that SPECIFIC
 * tenant's own stored hash. A token that happens to be valid for a
 * DIFFERENT tenant never matches here, even though both are 64
 * hex-character random values from the same generator.
 */
@Injectable()
export class ScimAuthGuard implements CanActivate {
  constructor(private readonly db: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ScimAuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing bearer token");
    }
    const token = header.slice("Bearer ".length).trim();
    const companySlug = (req.params.companySlug ?? "").toLowerCase();

    const { companyId, tokenHash, scimEnabled } = await this.db.withClaims(SCIM_SERVICE_CLAIMS, async (client) => {
      const result = await client.query(
        `SELECT c.id AS company_id, ti.scim_bearer_token_hash AS token_hash, ti.scim_enabled AS scim_enabled
         FROM companies c
         JOIN tenant_integrations ti ON ti.company_id = c.id AND ti.provider_key = 'sso'
         WHERE c.slug = $1 AND c.status NOT IN ('archived', 'churned')`,
        [companySlug]
      );
      const row = result.rows[0];
      return {
        companyId: row?.company_id as string | undefined,
        tokenHash: row?.token_hash as string | null | undefined,
        scimEnabled: Boolean(row?.scim_enabled),
      };
    });

    if (!companyId || !scimEnabled || !tokenHash) {
      throw new UnauthorizedException("SCIM provisioning is not enabled for this company");
    }

    const presentedHash = Buffer.from(hashScimToken(token));
    const storedHash = Buffer.from(tokenHash);
    if (presentedHash.length !== storedHash.length || !timingSafeEqual(presentedHash, storedHash)) {
      throw new UnauthorizedException("Invalid bearer token");
    }

    req.claims = SCIM_SERVICE_CLAIMS;
    req.scimCompanyId = companyId;
    return true;
  }
}
