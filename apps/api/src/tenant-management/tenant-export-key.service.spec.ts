import { Pool } from "pg";
import { BadRequestException } from "@nestjs/common";
import { TenantExportKeyService } from "./tenant-export-key.service";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "export-key-spec" };

/**
 * Phase 3 item #5 — Encryption & Secrets (advanced): tenant-dedicated
 * export encryption key with independent rotation. Real Postgres, same
 * bootstrap idiom as integrations.service.spec.ts (RLS is the point —
 * mocking `pg` would test nothing about it).
 */
describe("TenantExportKeyService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let service: TenantExportKeyService;
  let companyId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    service = new TenantExportKeyService(db, new AuditService());

    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const stamp = Date.now();
      const result = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Export Key Spec Co ${stamp}`,
        `export-key-spec-${stamp}`,
      ]);
      return result.rows[0].id as string;
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  it("reports no key at all before anything is enabled", async () => {
    const status = await service.getStatus(FIXTURE_CLAIMS, companyId);
    expect(status).toEqual({ enabled: false, hasKey: false, createdAt: null, previousKeyExpiresAt: null });
  });

  it("404s for an unknown company", async () => {
    await expect(service.getStatus(FIXTURE_CLAIMS, "00000000-0000-0000-0000-000000000000")).rejects.toThrow();
  });

  it("enable() creates a real wrapped key, never the raw key bytes", async () => {
    const status = await service.enable(FIXTURE_CLAIMS, companyId);
    expect(status.enabled).toBe(true);
    expect(status.hasKey).toBe(true);
    expect(status.createdAt).toBeTruthy();
    expect(status.previousKeyExpiresAt).toBeNull();

    const raw = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query<{ wrapped_key: string; previous_wrapped_key: string | null }>(
        "SELECT wrapped_key, previous_wrapped_key FROM tenant_export_encryption_keys WHERE company_id = $1",
        [companyId]
      )
    );
    expect(raw.rows[0].wrapped_key).toBeTruthy();
    expect(raw.rows[0].previous_wrapped_key).toBeNull();

    // Genuinely encrypted, not just base64'd/hex'd raw bytes: the stored
    // wrapped value must not literally contain the unwrapped key's own
    // hex representation as a substring.
    const rawKey = await db.withClaims(FIXTURE_CLAIMS, (client) => service.resolveActiveKey(client, companyId));
    expect(rawKey).not.toBeNull();
    expect(rawKey!.byteLength).toBe(32);
    expect(raw.rows[0].wrapped_key).not.toContain(rawKey!.toString("hex"));
    expect(raw.rows[0].wrapped_key).not.toContain(rawKey!.toString("base64"));
    // The wrapped form is also simply a different length/shape from the
    // raw key — never equal to it under any encoding.
    expect(raw.rows[0].wrapped_key).not.toBe(rawKey!.toString("hex"));
  });

  it("rejects a second enable() while already enabled — Rotate is the only way to get a new key", async () => {
    await expect(service.enable(FIXTURE_CLAIMS, companyId)).rejects.toThrow(BadRequestException);
  });

  it("rotate() moves the current key to previous_wrapped_key with a future expiry, and issues a genuinely different new key", async () => {
    const before = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query<{ wrapped_key: string }>("SELECT wrapped_key FROM tenant_export_encryption_keys WHERE company_id = $1", [
        companyId,
      ])
    );
    const oldWrappedKey = before.rows[0].wrapped_key;
    const oldRawKey = await db.withClaims(FIXTURE_CLAIMS, (client) => service.resolveActiveKey(client, companyId));

    const status = await service.rotate(FIXTURE_CLAIMS, companyId);
    expect(status.enabled).toBe(true);
    expect(status.previousKeyExpiresAt).toBeTruthy();
    expect(new Date(status.previousKeyExpiresAt!).getTime()).toBeGreaterThan(Date.now());

    const after = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query<{ wrapped_key: string; previous_wrapped_key: string }>(
        "SELECT wrapped_key, previous_wrapped_key FROM tenant_export_encryption_keys WHERE company_id = $1",
        [companyId]
      )
    );
    expect(after.rows[0].previous_wrapped_key).toBe(oldWrappedKey);
    expect(after.rows[0].wrapped_key).not.toBe(oldWrappedKey);

    const newRawKey = await db.withClaims(FIXTURE_CLAIMS, (client) => service.resolveActiveKey(client, companyId));
    expect(newRawKey!.equals(oldRawKey!)).toBe(false);
  });

  it("resolveKeyForDecryption returns both current and previous keys while within the grace period", async () => {
    const { current, previous } = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      service.resolveKeyForDecryption(client, companyId)
    );
    expect(current).not.toBeNull();
    expect(previous).not.toBeNull();
    expect(current!.equals(previous!)).toBe(false);
  });

  it("resolveKeyForDecryption returns previous: null once the grace period has lapsed", async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query(
        "UPDATE tenant_export_encryption_keys SET previous_key_expires_at = now() - interval '1 hour' WHERE company_id = $1",
        [companyId]
      )
    );
    const { current, previous } = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      service.resolveKeyForDecryption(client, companyId)
    );
    expect(current).not.toBeNull();
    expect(previous).toBeNull();
  });

  it("disable() keeps the key material but flips enabled to false, so resolveActiveKey stops returning it", async () => {
    const status = await service.disable(FIXTURE_CLAIMS, companyId);
    expect(status.enabled).toBe(false);
    expect(status.hasKey).toBe(true);

    const activeKey = await db.withClaims(FIXTURE_CLAIMS, (client) => service.resolveActiveKey(client, companyId));
    expect(activeKey).toBeNull();

    // But the key material itself is still there and still resolvable via
    // resolveKeyForDecryption — an export encrypted while it was enabled
    // must remain decryptable after disabling.
    const raw = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query<{ wrapped_key: string }>("SELECT wrapped_key FROM tenant_export_encryption_keys WHERE company_id = $1", [
        companyId,
      ])
    );
    expect(raw.rows[0].wrapped_key).toBeTruthy();
    const { current } = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      service.resolveKeyForDecryption(client, companyId)
    );
    expect(current).not.toBeNull();
  });

  it("rejects rotate() for a tenant with no key row at all", async () => {
    const otherCompanyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const stamp = Date.now();
      const result = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Export Key Spec Co No-Key ${stamp}`,
        `export-key-spec-no-key-${stamp}`,
      ]);
      return result.rows[0].id as string;
    });
    await expect(service.rotate(FIXTURE_CLAIMS, otherCompanyId)).rejects.toThrow(BadRequestException);
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [otherCompanyId]));
  });

  it("enable() is allowed again after a disable — re-enabling from scratch mints a fresh key", async () => {
    const disabledRaw = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query<{ wrapped_key: string }>("SELECT wrapped_key FROM tenant_export_encryption_keys WHERE company_id = $1", [
        companyId,
      ])
    );
    const status = await service.enable(FIXTURE_CLAIMS, companyId);
    expect(status.enabled).toBe(true);
    const raw = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query<{ wrapped_key: string; previous_wrapped_key: string | null }>(
        "SELECT wrapped_key, previous_wrapped_key FROM tenant_export_encryption_keys WHERE company_id = $1",
        [companyId]
      )
    );
    expect(raw.rows[0].wrapped_key).not.toBe(disabledRaw.rows[0].wrapped_key);
    expect(raw.rows[0].previous_wrapped_key).toBeNull();
  });

  it("audits enable/rotate/disable without ever including key material", async () => {
    const auditRows = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query(
        "SELECT action, metadata FROM audit_log WHERE company_id = $1 AND action LIKE 'tenant_export_key.%'",
        [companyId]
      )
    );
    expect(auditRows.rowCount).toBeGreaterThanOrEqual(3);
    const actions = auditRows.rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["tenant_export_key.enabled", "tenant_export_key.rotated", "tenant_export_key.disabled"]));
    // No metadata field on any of these rows should ever carry key bytes —
    // the only metadata this service ever writes is graceDays (a number).
    for (const row of auditRows.rows) {
      expect(Object.keys(row.metadata)).not.toContain("wrappedKey");
      expect(Object.keys(row.metadata)).not.toContain("rawKey");
    }
  });
});
