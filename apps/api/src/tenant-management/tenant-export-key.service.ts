import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { RequestClaims } from "../database/tenant-context";
import type { TenantExportKeyStatus } from "@aihxm/shared-types";
import { generateTenantKey, unwrapTenantKey, wrapTenantKey } from "./export-crypto";

const ROTATION_GRACE_DAYS = 7;

/**
 * Phase 3 item #5 — "Encryption & Secrets (advanced)". See
 * `export-crypto.ts`'s `wrapTenantKey`/`unwrapTenantKey` doc comment for
 * the full envelope-encryption design and its honest scope: this is a
 * tenant-DEDICATED key, independently rotatable and revocable, wrapped
 * server-side under the platform's own EXPORT_ENCRYPTION_KEY — NOT a
 * true customer-held or HSM-backed key. That remains a real, larger,
 * deliberately out-of-scope follow-on (no external KMS/HSM integration
 * exists in this codebase, and there is no current customer demand
 * signal to justify building one from scratch).
 *
 * Nothing in this service ever returns unwrapped key material (or even
 * the wrapped bytes) to a caller — unlike `IntegrationsService.rotateSecret()`
 * or `ScimService.generateToken()`'s deliberate "show plaintext exactly
 * once" pattern, this key never needs to leave the server: it exists only
 * to be handed straight back into `export-crypto.ts` by
 * `DataExportsService`. A webhook signing secret has to be copy-pasted
 * into an external system; this key never does, so nobody — not even a
 * Platform Admin viewing this tab — ever needs or gets to see it.
 *
 * `enable()` only ever applies to a tenant with no key row yet (or one
 * that was disabled without ever having been enabled — a fresh key still
 * gets minted). Once a key exists, generating a NEW one is only ever done
 * through `rotate()`, which additionally preserves the outgoing key for a
 * grace period so exports encrypted moments before a rotation are not
 * abruptly unreadable. This split keeps the API unambiguous: "enable" is
 * "turn this on for the first time," "rotate" is the only way to ever get
 * a new key value. Calling `enable()` again while already enabled is
 * rejected rather than silently rotating out from under the caller
 * (rotation is a deliberate, audited, step-up-gated action of its own).
 */
@Injectable()
export class TenantExportKeyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService
  ) {}

  async getStatus(claims: RequestClaims, companyId: string): Promise<TenantExportKeyStatus> {
    return this.db.withClaims(claims, async (client) => {
      await this.assertCompanyExists(client, companyId);
      const row = await this.findRow(client, companyId);
      return this.toStatus(row);
    });
  }

  async enable(claims: RequestClaims, companyId: string): Promise<TenantExportKeyStatus> {
    return this.db.withClaims(claims, async (client) => {
      await this.assertCompanyExists(client, companyId);
      const existing = await this.findRow(client, companyId);
      if (existing?.enabled) {
        throw new BadRequestException(
          "A dedicated export key is already enabled for this tenant — use Rotate to issue a new one."
        );
      }

      const rawKey = generateTenantKey();
      const wrappedKey = wrapTenantKey(rawKey);

      const result = await client.query(
        `INSERT INTO tenant_export_encryption_keys (company_id, enabled, wrapped_key, updated_by)
         VALUES ($1, true, $2, $3)
         ON CONFLICT (company_id)
         DO UPDATE SET enabled = true, wrapped_key = EXCLUDED.wrapped_key,
                       previous_wrapped_key = NULL, previous_key_expires_at = NULL,
                       updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING *`,
        [companyId, wrappedKey, claims.sub]
      );

      await this.audit.record(client, claims, {
        companyId,
        action: "tenant_export_key.enabled",
        target: companyId,
        metadata: {},
      });

      return this.toStatus(result.rows[0]);
    });
  }

  /**
   * Generates a fresh key, keeping the outgoing one usable for
   * `ROTATION_GRACE_DAYS` (see class doc comment) — same idiom as
   * `IntegrationsService.rotateSecret()`, except nothing is ever returned
   * to the caller: this key is never shown, only used internally.
   */
  async rotate(claims: RequestClaims, companyId: string): Promise<TenantExportKeyStatus> {
    return this.db.withClaims(claims, async (client) => {
      await this.assertCompanyExists(client, companyId);
      const existing = await this.findRow(client, companyId);
      if (!existing) {
        throw new BadRequestException("No dedicated export key exists for this tenant yet — use Enable first.");
      }

      const rawKey = generateTenantKey();
      const wrappedKey = wrapTenantKey(rawKey);

      const result = await client.query(
        `UPDATE tenant_export_encryption_keys
         SET enabled = true,
             wrapped_key = $2,
             previous_wrapped_key = $3,
             previous_key_expires_at = now() + make_interval(days => $4::int),
             updated_by = $5,
             updated_at = now()
         WHERE company_id = $1
         RETURNING *`,
        [companyId, wrappedKey, existing.wrapped_key, ROTATION_GRACE_DAYS, claims.sub]
      );

      await this.audit.record(client, claims, {
        companyId,
        action: "tenant_export_key.rotated",
        target: companyId,
        metadata: { graceDays: ROTATION_GRACE_DAYS },
      });

      return this.toStatus(result.rows[0]);
    });
  }

  /**
   * Disabling keeps the key row (and both wrapped key generations)
   * around — exports already encrypted under this tenant's key must
   * remain decryptable forever, same as an expired-but-not-deleted
   * `previous_secret_value`. Only FUTURE exports are affected: with
   * `enabled = false`, `resolveActiveKey()` returns null and
   * `DataExportsService.request()` falls back to the platform's shared
   * server key.
   */
  async disable(claims: RequestClaims, companyId: string): Promise<TenantExportKeyStatus> {
    return this.db.withClaims(claims, async (client) => {
      await this.assertCompanyExists(client, companyId);
      const result = await client.query(
        `UPDATE tenant_export_encryption_keys
         SET enabled = false, updated_by = $2, updated_at = now()
         WHERE company_id = $1
         RETURNING *`,
        [companyId, claims.sub]
      );
      if (result.rowCount === 0) {
        throw new NotFoundException("No dedicated export key exists for this tenant.");
      }

      await this.audit.record(client, claims, {
        companyId,
        action: "tenant_export_key.disabled",
        target: companyId,
        metadata: {},
      });

      return this.toStatus(result.rows[0]);
    });
  }

  /**
   * Internal-only (not exposed via any controller) — called by
   * `DataExportsService.request()` to decide whether a NEW export should
   * be encrypted under this tenant's own key. Returns null whenever there
   * is no key, or the key exists but is disabled, so the caller's own
   * fallback to the shared server key stays a single, simple check.
   */
  async resolveActiveKey(client: PoolClient, companyId: string): Promise<Buffer | null> {
    const row = await this.findRow(client, companyId);
    if (!row || !row.enabled) return null;
    return unwrapTenantKey(row.wrapped_key);
  }

  /**
   * Internal-only — called by `DataExportsService.download()` for an
   * envelope whose mode byte is 2 (tenant-key). There is no way to tell
   * from the envelope alone which key GENERATION (current, or the
   * previous one — still valid, briefly, after a rotation) it was
   * encrypted under, so the caller must be handed both and try current
   * first, then previous, mirroring exactly how
   * `integrations.service.ts`'s `activePreviousSecretExpiry()` already
   * treats a lapsed grace period as equivalent to no previous value at
   * all. `current` is returned regardless of `enabled` — an export made
   * while the key was enabled must remain downloadable even after the
   * tenant later disables it (disabling only stops NEW exports from using
   * it; see `disable()`'s own doc comment).
   */
  async resolveKeyForDecryption(
    client: PoolClient,
    companyId: string
  ): Promise<{ current: Buffer | null; previous: Buffer | null }> {
    const row = await this.findRow(client, companyId);
    if (!row) return { current: null, previous: null };
    const current = unwrapTenantKey(row.wrapped_key);
    const previousStillInGrace =
      row.previous_wrapped_key && row.previous_key_expires_at && row.previous_key_expires_at.getTime() > Date.now();
    const previous = previousStillInGrace ? unwrapTenantKey(row.previous_wrapped_key) : null;
    return { current, previous };
  }

  private async assertCompanyExists(client: PoolClient, companyId: string): Promise<void> {
    const companyCheck = await client.query("SELECT id FROM companies WHERE id = $1", [companyId]);
    if (companyCheck.rowCount === 0) throw new NotFoundException("Company not found");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async findRow(client: PoolClient, companyId: string): Promise<any | null> {
    const result = await client.query("SELECT * FROM tenant_export_encryption_keys WHERE company_id = $1", [
      companyId,
    ]);
    return result.rowCount === 0 ? null : result.rows[0];
  }

  // A lapsed grace period is reported as none at all — same reasoning as
  // integrations.service.ts's activePreviousSecretExpiry().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toStatus(row: any | null): TenantExportKeyStatus {
    if (!row) {
      return { enabled: false, hasKey: false, createdAt: null, previousKeyExpiresAt: null };
    }
    const previousKeyExpiresAt =
      row.previous_key_expires_at && row.previous_key_expires_at.getTime() > Date.now()
        ? row.previous_key_expires_at.toISOString()
        : null;
    return {
      enabled: row.enabled,
      hasKey: true,
      createdAt: row.created_at.toISOString(),
      previousKeyExpiresAt,
    };
  }
}
