import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { MODULE_KEYS, type ModuleKey, type PackageTier } from "@boostfactor/shared-types";

/**
 * Plan doc Section 4's FIRST enforcement gate: "is the module even
 * licensed" — checked BEFORE RbacService.can() ever runs, not instead of
 * it. `0006_module_entitlement.sql`'s header comment has the full design;
 * the short version is that `tenant_module_entitlement` is the sole source
 * of truth this service ever answers from, and `package_tier_modules` is a
 * template consulted only once, when a new company is created.
 *
 * Same no-bypass stance as RbacService: a Platform Admin session has no
 * `company_id` to check entitlement against at all (Section 3 — Platform
 * Admin "never touches a tenant's HR data," including never getting to
 * skip past its licensing gate). `isModuleEnabled` returns `false`
 * immediately for such a session rather than special-casing it to `true`.
 *
 * Phase 14 note: this read runs on nearly every authenticated request, and
 * was evaluated as a caching candidate. It was deliberately NOT cached —
 * see `docs/performance-caching-strategy.md` for why an authorization gate
 * is the wrong place to start, and where Phase 14 caching landed instead.
 */
@Injectable()
export class EntitlementsService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * The actual gate. Any module-owning service calls this before doing
   * anything else — including its own RbacService.can() — so that a
   * disabled module fails closed before RBAC ever gets a chance to grant
   * anything. A missing row (never seeded, or the module was retired from
   * the catalog after this tenant's entitlement was last touched) is
   * treated the same as an explicit `enabled = false` — safe-deny, the
   * same posture RbacService.resolveFieldAccess takes for an unmatched
   * field.
   */
  async isModuleEnabled(claims: RequestClaims, moduleKey: ModuleKey): Promise<boolean> {
    if (!claims.company_id) return false;

    return this.db.withClaims(claims, async (client) => {
      const result = await client.query<{ enabled: boolean }>(
        `SELECT enabled FROM tenant_module_entitlement WHERE company_id = $1 AND module_key = $2`,
        [claims.company_id, moduleKey]
      );
      return result.rowCount !== 0 && result.rows[0].enabled === true;
    });
  }

  /**
   * Canonical read of a company's currently-enabled modules — what
   * `CompanyDetail.config.enabledModules` actually answers from, and what
   * gets written back into `company_config.enabled_modules`'s cache
   * column after any change. Runs inside the caller's own transaction
   * (the `client` CompaniesService is already using), same pattern as
   * `AuditService.record`.
   */
  async getEnabledModuleKeys(client: PoolClient, companyId: string): Promise<ModuleKey[]> {
    const result = await client.query<{ module_key: ModuleKey }>(
      `SELECT module_key FROM tenant_module_entitlement
       WHERE company_id = $1 AND enabled = true
       ORDER BY module_key`,
      [companyId]
    );
    return result.rows.map((r) => r.module_key);
  }

  /**
   * Seeds a brand-new company's entitlement rows: `package_tier_modules`'
   * default set for its tier, unless the caller passed an explicit
   * `enabledModules` list at creation time (CreateCompanyRequest already
   * had this field pre-Phase-5 — it now seeds real rows instead of only
   * the cached jsonb column). Runs inside CompaniesService.create's own
   * transaction, so it commits atomically with the company itself.
   */
  async seedForNewCompany(
    client: PoolClient,
    companyId: string,
    packageTier: PackageTier,
    explicitModules?: ModuleKey[]
  ): Promise<ModuleKey[]> {
    let keys: readonly ModuleKey[];
    if (explicitModules) {
      keys = explicitModules;
    } else {
      const defaults = await client.query<{ module_key: ModuleKey }>(
        `SELECT module_key FROM package_tier_modules WHERE package_tier = $1`,
        [packageTier]
      );
      keys = defaults.rows.map((r) => r.module_key);
    }

    if (keys.length > 0) {
      await client.query(
        `INSERT INTO tenant_module_entitlement (company_id, module_key, enabled)
         SELECT $1, key, true FROM unnest($2::text[]) AS key
         ON CONFLICT (company_id, module_key) DO UPDATE SET enabled = true, updated_at = now()`,
        [companyId, keys]
      );
    }
    return this.getEnabledModuleKeys(client, companyId);
  }

  /**
   * Platform-Admin-driven replace: enable exactly `moduleKeys`, disable
   * every other catalog module for this tenant. Called from
   * CompaniesService.updateConfig's own transaction — the only write path
   * to entitlement after company creation (Section 3: only Platform Admin
   * decides "which modules each tenant is entitled to," no tenant-side
   * self-service upgrade flow exists). Writes a row for every catalog
   * module rather than deleting the ones being turned off, so
   * `updated_at`/history survives a module being disabled and re-enabled.
   */
  async setEnabledModules(client: PoolClient, companyId: string, moduleKeys: ModuleKey[]): Promise<ModuleKey[]> {
    await client.query(
      `INSERT INTO tenant_module_entitlement (company_id, module_key, enabled)
       SELECT $1, key, (key = ANY($2::text[])) FROM unnest($3::text[]) AS key
       ON CONFLICT (company_id, module_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
      [companyId, moduleKeys, MODULE_KEYS]
    );
    return this.getEnabledModuleKeys(client, companyId);
  }
}
