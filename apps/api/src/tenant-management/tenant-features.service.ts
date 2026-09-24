import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import type { RequestClaims } from "../database/tenant-context";
import type { TenantFeatureEntitlement } from "@aihxm/shared-types";

/**
 * TM-023/024 — Feature entitlements: one level more granular than
 * `tenant_module_entitlement` (0006, whole-module on/off). A feature can
 * only be configured while its owning module is enabled for the tenant
 * (spec: "Feature must belong to enabled module") — checked against the
 * real gate (EntitlementsService), not a duplicated query.
 */
@Injectable()
export class TenantFeaturesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService
  ) {}

  async list(claims: RequestClaims, companyId: string): Promise<TenantFeatureEntitlement[]> {
    return this.db.withClaims(claims, async (client) => {
      const companyCheck = await client.query("SELECT id FROM companies WHERE id = $1", [companyId]);
      if (companyCheck.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }

      const result = await client.query(
        `SELECT
           mf.key AS feature_key, mf.module_key, mf.name, mf.description, mf.default_limit,
           tfe.enabled, tfe.usage_limit
         FROM module_features mf
         LEFT JOIN tenant_feature_entitlement tfe
           ON tfe.company_id = $1 AND tfe.feature_key = mf.key
         ORDER BY mf.module_key, mf.key`,
        [companyId]
      );

      return result.rows.map((row) => {
        // No tenant_feature_entitlement row yet = feature defaults to
        // enabled at its module_features.default_limit, same "safe
        // default until touched" posture as tenant_configuration's
        // effective-value fallback.
        const enabled = row.enabled ?? true;
        const usageLimit = row.usage_limit ?? null;
        return {
          featureKey: row.feature_key,
          moduleKey: row.module_key,
          name: row.name,
          description: row.description,
          defaultLimit: row.default_limit,
          enabled,
          usageLimit,
          effectiveLimit: usageLimit ?? row.default_limit,
        };
      });
    });
  }

  /** TM-023 Configure (enable/disable) + TM-024 Set Limit, in one write. */
  async setEntitlement(
    claims: RequestClaims,
    companyId: string,
    featureKey: string,
    patch: { enabled?: boolean; usageLimit?: number | null }
  ): Promise<TenantFeatureEntitlement> {
    return this.db.withClaims(claims, async (client) => {
      const featureRow = await client.query(
        "SELECT * FROM module_features WHERE key = $1",
        [featureKey]
      );
      if (featureRow.rowCount === 0) {
        throw new NotFoundException("Unknown feature");
      }
      const feature = featureRow.rows[0];

      if (patch.enabled !== false) {
        // Spec: "Feature must belong to enabled module" — only enforced
        // when the caller is trying to turn the feature ON; disabling a
        // feature is always safe even if its module got disabled after.
        const moduleEnabled = await this.entitlements.isModuleEnabled(
          { ...claims, company_id: companyId },
          feature.module_key
        );
        if (!moduleEnabled) {
          throw new BadRequestException(
            `Cannot configure "${feature.name}" — its module ("${feature.module_key}") isn't enabled for this tenant.`
          );
        }
      }

      const existing = await client.query(
        "SELECT * FROM tenant_feature_entitlement WHERE company_id = $1 AND feature_key = $2",
        [companyId, featureKey]
      );
      const nextEnabled = patch.enabled ?? (existing.rowCount ? existing.rows[0].enabled : true);
      const nextLimit = patch.usageLimit !== undefined ? patch.usageLimit : existing.rowCount ? existing.rows[0].usage_limit : null;

      const result = await client.query(
        `INSERT INTO tenant_feature_entitlement (company_id, feature_key, enabled, usage_limit)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, feature_key)
         DO UPDATE SET enabled = EXCLUDED.enabled, usage_limit = EXCLUDED.usage_limit, updated_at = now()
         RETURNING *`,
        [companyId, featureKey, nextEnabled, nextLimit]
      );

      await this.audit.record(client, claims, {
        companyId,
        action: "tenant_feature_entitlement.updated",
        target: featureKey,
        metadata: patch,
      });

      const row = result.rows[0];
      return {
        featureKey: feature.key,
        moduleKey: feature.module_key,
        name: feature.name,
        description: feature.description,
        defaultLimit: feature.default_limit,
        enabled: row.enabled,
        usageLimit: row.usage_limit,
        effectiveLimit: row.usage_limit ?? feature.default_limit,
      };
    });
  }
}
