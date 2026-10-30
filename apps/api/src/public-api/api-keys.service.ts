import { createHash, randomBytes } from "node:crypto";
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { ApiKeyScope, ApiKeyView, CreatedApiKey } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";

export const API_KEY_SCOPES: ApiKeyScope[] = ["employees.read", "org.read"];
const LOOKUP_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "public-api-key-lookup" };
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Read-only API keys. The secret is shown once when created and only its hash is stored, so a lost key cannot be recovered, only replaced.
 * A key can read only the scopes it was given and can be revoked at any time.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async list(claims: RequestClaims): Promise<ApiKeyView[]> {
    await this.require(claims);
    return this.db.withClaims(claims, async (c) => (await c.query("SELECT * FROM api_keys WHERE company_id = $1 ORDER BY created_at DESC LIMIT 100", [claims.company_id])).rows.map(toView));
  }

  async create(claims: RequestClaims, name: string, scopes: ApiKeyScope[]): Promise<CreatedApiKey> {
    await this.require(claims);
    const n = (name ?? "").trim();
    if (!n || n.length > 80) throw new BadRequestException("Give the key a name so you know what uses it");
    const sc = [...new Set(scopes ?? [])];
    if (sc.length === 0 || sc.some((s) => !API_KEY_SCOPES.includes(s))) throw new BadRequestException("Choose what the key may read");
    const secret = `ahx_${randomBytes(30).toString("base64url")}`;
    return this.db.withClaims(claims, async (c) => {
      const open = (await c.query("SELECT count(*)::int AS n FROM api_keys WHERE revoked_at IS NULL")).rows[0].n as number;
      if (open >= 20) throw new BadRequestException("You already have 20 active keys. Revoke one you no longer use first.");
      const r = (await c.query("INSERT INTO api_keys (company_id, name, key_prefix, key_sha256, scopes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [claims.company_id, n, secret.slice(0, 10), sha(secret), sc, claims.sub])).rows[0];
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "api_key.create", target: r.id, metadata: { name: n, scopes: sc } });
      return { ...toView(r), secret };
    });
  }

  async revoke(claims: RequestClaims, id: string): Promise<ApiKeyView[]> {
    await this.require(claims);
    await this.db.withClaims(claims, async (c) => {
      const r = await c.query("UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id", [id]);
      if (!r.rowCount) throw new NotFoundException("Key not found");
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "api_key.revoke", target: id, metadata: {} });
    });
    return this.list(claims);
  }

  /** Used by the guard. Returns null for anything that is not a live key. */
  async authenticate(raw: string): Promise<{ id: string; companyId: string; scopes: ApiKeyScope[] } | null> {
    if (!/^ahx_[A-Za-z0-9_-]{30,80}$/.test(raw)) return null;
    return this.db.withClaims(LOOKUP_CLAIMS, async (c) => {
      const r = (await c.query("SELECT id, company_id, scopes, last_used_at FROM api_keys WHERE key_sha256 = $1 AND revoked_at IS NULL", [sha(raw)])).rows[0];
      if (!r) return null;
      if (!r.last_used_at || Date.now() - r.last_used_at.getTime() > 5 * 60_000) await c.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [r.id]);
      return { id: r.id, companyId: r.company_id, scopes: r.scopes };
    });
  }

  private async require(claims: RequestClaims) {
    if (!(await this.entitlements.isModuleEnabled(claims, "employee"))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, "api_key.manage"))) throw new ForbiddenException("Not permitted to manage API keys");
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(x: any): ApiKeyView {
  return { id: x.id, name: x.name, keyPrefix: x.key_prefix, scopes: x.scopes, createdAt: x.created_at.toISOString(), lastUsedAt: x.last_used_at ? x.last_used_at.toISOString() : null, revokedAt: x.revoked_at ? x.revoked_at.toISOString() : null };
}
