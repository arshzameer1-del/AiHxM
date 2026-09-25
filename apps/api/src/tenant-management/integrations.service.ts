import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "crypto";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { RequestClaims } from "../database/tenant-context";
import type { IntegrationProviderKey, RotateIntegrationSecretResponse, TenantIntegration } from "@aihxm/shared-types";

const PROVIDER_KEYS: IntegrationProviderKey[] = ["smtp", "sso", "biometric_device", "webhook"];

// Fields inside `config` treated as secrets — never sent back on a GET,
// only accepted on write. Keeping this as an explicit allow-list (rather
// than "anything with 'secret' in the name") means a new secret field
// added later must be deliberately added here too — fail-closed, not
// fail-open, the same posture as RbacService's field masking.
const SECRET_FIELDS: Record<IntegrationProviderKey, string[]> = {
  smtp: ["password"],
  sso: ["clientSecret"],
  biometric_device: ["apiKey"],
  webhook: ["signingSecret"],
};

// Tenant Management gap-fill Phase 1 item #12 — only these two providers'
// secrets are ISSUED BY AIHXM (a biometric device's apiKey, a webhook's
// signingSecret — values we hand to something else and can freely
// regenerate). smtp's password and sso's clientSecret are issued by the
// external system instead; "rotating" those isn't something this side can
// do at all, so Rotate is deliberately not offered for them.
const ROTATABLE_PROVIDER_KEYS: IntegrationProviderKey[] = ["biometric_device", "webhook"];
const ROTATION_GRACE_DAYS = 7;

function redact(providerKey: IntegrationProviderKey, config: Record<string, unknown>) {
  const secretFields = SECRET_FIELDS[providerKey];
  const redacted: Record<string, unknown> = {};
  let hasSecrets = false;
  for (const [key, value] of Object.entries(config)) {
    if (secretFields.includes(key)) {
      if (value !== undefined && value !== null && value !== "") hasSecrets = true;
      continue; // never included in the redacted copy
    }
    redacted[key] = value;
  }
  return { redacted, hasSecrets };
}

// A grace period that has already lapsed is reported as none at all — an
// expired "previous secret" is not meaningfully different from having
// none, and surfacing it as still-active would be misleading to whoever
// reads this from the Integrations tab.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function activePreviousSecretExpiry(row: any): string | null {
  if (!row.previous_secret_expires_at) return null;
  const expiresAt: Date = row.previous_secret_expires_at;
  return expiresAt.getTime() > Date.now() ? expiresAt.toISOString() : null;
}

/**
 * TM-031 — Integration catalog: SMTP, SSO, biometric device, webhook.
 * `tenant_integrations.config` may hold secrets (SMTP password, SSO
 * client secret, ...); this service is the one place that redacts them
 * before returning anything to the client, mirroring RbacService's field-
 * level masking discipline for the same reason (spec: "Secrets encrypted"
 * — this schema doesn't yet have field-level encryption-at-rest, so the
 * concrete guarantee this service makes today is "never leaves the
 * server once written," which is what actually matters to the caller).
 */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService
  ) {}

  async list(claims: RequestClaims, companyId: string): Promise<TenantIntegration[]> {
    return this.db.withClaims(claims, async (client) => {
      const companyCheck = await client.query("SELECT id FROM companies WHERE id = $1", [companyId]);
      if (companyCheck.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }

      const existingRows = await client.query(
        "SELECT * FROM tenant_integrations WHERE company_id = $1",
        [companyId]
      );
      const byProvider = new Map(existingRows.rows.map((r) => [r.provider_key, r]));

      return PROVIDER_KEYS.map((providerKey) => {
        const row = byProvider.get(providerKey);
        if (!row) {
          return {
            companyId,
            providerKey,
            enabled: false,
            config: {},
            hasSecrets: false,
            updatedAt: new Date(0).toISOString(),
            updatedBy: "",
            previousSecretExpiresAt: null,
          };
        }
        const { redacted, hasSecrets } = redact(providerKey, row.config ?? {});
        return {
          companyId,
          providerKey,
          enabled: row.enabled,
          config: redacted,
          hasSecrets,
          updatedAt: row.updated_at.toISOString(),
          updatedBy: row.updated_by,
          previousSecretExpiresAt: activePreviousSecretExpiry(row),
        };
      });
    });
  }

  /**
   * Merges `patch.config` into the existing stored config (so updating
   * one non-secret field doesn't blank out an already-saved secret the
   * caller can't see to resend) rather than replacing it outright.
   */
  async configure(
    claims: RequestClaims,
    companyId: string,
    providerKey: IntegrationProviderKey,
    patch: { enabled?: boolean; config?: Record<string, unknown> }
  ): Promise<TenantIntegration> {
    if (!PROVIDER_KEYS.includes(providerKey)) {
      throw new BadRequestException(`Unknown integration provider "${providerKey}"`);
    }
    return this.db.withClaims(claims, async (client) => {
      const companyCheck = await client.query("SELECT id FROM companies WHERE id = $1", [companyId]);
      if (companyCheck.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }

      const existing = await client.query(
        "SELECT * FROM tenant_integrations WHERE company_id = $1 AND provider_key = $2",
        [companyId, providerKey]
      );
      const currentConfig = existing.rowCount ? existing.rows[0].config ?? {} : {};
      const nextConfig = { ...currentConfig, ...(patch.config ?? {}) };
      const nextEnabled = patch.enabled ?? (existing.rowCount ? existing.rows[0].enabled : false);

      const result = await client.query(
        `INSERT INTO tenant_integrations (company_id, provider_key, enabled, config, updated_by)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (company_id, provider_key)
         DO UPDATE SET enabled = EXCLUDED.enabled, config = EXCLUDED.config, updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING *`,
        [companyId, providerKey, nextEnabled, JSON.stringify(nextConfig), claims.sub]
      );

      await this.audit.record(client, claims, {
        companyId,
        action: "tenant_integration.configured",
        target: providerKey,
        // Never audit the actual config values — they may contain the
        // very secrets this service exists to protect. Only which
        // non-secret keys changed and the enabled flag.
        metadata: { enabled: nextEnabled, configuredFields: Object.keys(patch.config ?? {}) },
      });

      const { redacted, hasSecrets } = redact(providerKey, result.rows[0].config ?? {});
      return {
        companyId,
        providerKey,
        enabled: result.rows[0].enabled,
        config: redacted,
        hasSecrets,
        updatedAt: result.rows[0].updated_at.toISOString(),
        updatedBy: result.rows[0].updated_by,
        previousSecretExpiresAt: activePreviousSecretExpiry(result.rows[0]),
      };
    });
  }

  /**
   * Tenant Management gap-fill Phase 1 item #12 — regenerates the one
   * secret field this provider holds, keeping the OLD value honored for
   * `ROTATION_GRACE_DAYS` (stored in `previous_secret_value` /
   * `previous_secret_expires_at`) so a device or endpoint that hasn't yet
   * picked up the new value doesn't immediately break. Only offered for
   * providers AIHXM itself issues the secret for — see
   * `ROTATABLE_PROVIDER_KEYS`'s doc comment. The new value is returned
   * exactly once, the same "show plaintext once" pattern used elsewhere
   * (impersonation tokens, initial admin passwords, recovery codes) — it
   * is never retrievable again after this response.
   */
  async rotateSecret(
    claims: RequestClaims,
    companyId: string,
    providerKey: IntegrationProviderKey
  ): Promise<RotateIntegrationSecretResponse> {
    if (!ROTATABLE_PROVIDER_KEYS.includes(providerKey)) {
      throw new BadRequestException(`Secret rotation is not available for "${providerKey}"`);
    }
    return this.db.withClaims(claims, async (client) => {
      const companyCheck = await client.query("SELECT id FROM companies WHERE id = $1", [companyId]);
      if (companyCheck.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }

      const existing = await client.query(
        "SELECT * FROM tenant_integrations WHERE company_id = $1 AND provider_key = $2",
        [companyId, providerKey]
      );
      if (existing.rowCount === 0) {
        throw new BadRequestException(`"${providerKey}" has not been configured yet — nothing to rotate`);
      }

      const [secretField] = SECRET_FIELDS[providerKey];
      const currentConfig = existing.rows[0].config ?? {};
      const currentSecretValue: string | undefined = currentConfig[secretField];
      const newSecretValue = randomBytes(24).toString("hex");
      const nextConfig = { ...currentConfig, [secretField]: newSecretValue };

      const result = await client.query(
        `UPDATE tenant_integrations
         SET config = $3::jsonb,
             previous_secret_value = $4,
             previous_secret_expires_at = now() + make_interval(days => $5::int),
             updated_by = $6,
             updated_at = now()
         WHERE company_id = $1 AND provider_key = $2
         RETURNING *`,
        [companyId, providerKey, JSON.stringify(nextConfig), currentSecretValue ?? null, ROTATION_GRACE_DAYS, claims.sub]
      );

      await this.audit.record(client, claims, {
        companyId,
        action: "tenant_integration.secret_rotated",
        target: providerKey,
        // Never audit secret values — old or new. Only that a rotation
        // happened and the grace window it opened.
        metadata: { graceDays: ROTATION_GRACE_DAYS },
      });

      const row = result.rows[0];
      const { redacted, hasSecrets } = redact(providerKey, row.config ?? {});
      return {
        integration: {
          companyId,
          providerKey,
          enabled: row.enabled,
          config: redacted,
          hasSecrets,
          updatedAt: row.updated_at.toISOString(),
          updatedBy: row.updated_by,
          previousSecretExpiresAt: activePreviousSecretExpiry(row),
        },
        newSecretValue,
        previousSecretExpiresAt: row.previous_secret_expires_at.toISOString(),
      };
    });
  }
}
