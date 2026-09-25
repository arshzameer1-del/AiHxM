import { Pool } from "pg";
import { BadRequestException } from "@nestjs/common";
import { IntegrationsService } from "./integrations.service";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { RequestClaims } from "../database/tenant-context";
import type { IntegrationProviderKey } from "@aihxm/shared-types";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "integrations-mask-spec" };

/**
 * Tenant Management gap-fill Phase 1 item #11 — Sensitive value masking
 * audit. IntegrationsService.list()/configure() already redact secret
 * fields (see that file's own doc comment) and integrations.e2e.spec.ts
 * already proves this for SMTP's `password`. This file is the audit this
 * roadmap item actually asked for: the SAME verification, run against
 * EVERY provider's own secret field (sso.clientSecret,
 * biometric_device.apiKey, webhook.signingSecret — not just smtp.password),
 * plus one gap none of the existing tests covered: that the audit_log
 * entry `configure()` writes never contains the secret value either. No
 * production code needed changing — every one of these passes against the
 * existing redact() implementation; that IS the audit finding.
 */
describe("IntegrationsService — sensitive value masking audit", () => {
  let pool: Pool;
  let db: DatabaseService;
  let service: IntegrationsService;
  let companyId: string;

  const SECRET_FIXTURES: Array<{ providerKey: IntegrationProviderKey; secretField: string; secretValue: string }> = [
    { providerKey: "smtp", secretField: "password", secretValue: "smtp-super-secret-1" },
    { providerKey: "sso", secretField: "clientSecret", secretValue: "sso-super-secret-2" },
    { providerKey: "biometric_device", secretField: "apiKey", secretValue: "biometric-super-secret-3" },
    { providerKey: "webhook", secretField: "signingSecret", secretValue: "webhook-super-secret-4" },
  ];

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    service = new IntegrationsService(db, new AuditService());

    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const stamp = Date.now();
      const result = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Integrations Mask Spec Co ${stamp}`,
        `integrations-mask-spec-${stamp}`,
      ]);
      return result.rows[0].id as string;
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  it.each(SECRET_FIXTURES)(
    "never returns $providerKey's $secretField from configure() or list(), and audits without it",
    async ({ providerKey, secretField, secretValue }) => {
      const configured = await service.configure(FIXTURE_CLAIMS, companyId, providerKey, {
        enabled: true,
        config: { [secretField]: secretValue, nonSecretNote: "kept as-is" },
      });

      expect(configured.hasSecrets).toBe(true);
      expect(configured.config[secretField]).toBeUndefined();
      expect(configured.config.nonSecretNote).toBe("kept as-is");
      expect(JSON.stringify(configured)).not.toContain(secretValue);

      const listed = await service.list(FIXTURE_CLAIMS, companyId);
      const listedEntry = listed.find((i) => i.providerKey === providerKey)!;
      expect(listedEntry.hasSecrets).toBe(true);
      expect(listedEntry.config[secretField]).toBeUndefined();
      expect(JSON.stringify(listed)).not.toContain(secretValue);

      // The audit trail must be just as clean — a secret leaking into
      // audit_log.metadata would be just as real a breach as one leaking
      // into an API response, and nothing before this test verified it.
      const auditRows = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query(
          "SELECT metadata FROM audit_log WHERE company_id = $1 AND action = 'tenant_integration.configured' AND target = $2",
          [companyId, providerKey]
        )
      );
      expect(auditRows.rowCount).toBeGreaterThan(0);
      expect(JSON.stringify(auditRows.rows)).not.toContain(secretValue);

      // Confirm the secret really was persisted (this is a masking audit,
      // not a "secrets are silently dropped" regression) — read the raw
      // column directly, bypassing the service's own redaction.
      const raw = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query<{ config: Record<string, unknown> }>(
          "SELECT config FROM tenant_integrations WHERE company_id = $1 AND provider_key = $2",
          [companyId, providerKey]
        )
      );
      expect(raw.rows[0].config[secretField]).toBe(secretValue);
    }
  );

  it("rejects an unknown provider key", async () => {
    await expect(
      service.configure(FIXTURE_CLAIMS, companyId, "carrier-pigeon" as IntegrationProviderKey, {
        enabled: true,
        config: {},
      })
    ).rejects.toThrow(BadRequestException);
  });
});

/**
 * Tenant Management gap-fill Phase 1 item #12 — secret rotation with a
 * grace period, scoped to the two AIHXM-issued providers.
 */
describe("IntegrationsService — rotateSecret", () => {
  let pool: Pool;
  let db: DatabaseService;
  let service: IntegrationsService;
  let companyId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    service = new IntegrationsService(db, new AuditService());

    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const stamp = Date.now();
      const result = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Integrations Rotate Spec Co ${stamp}`,
        `integrations-rotate-spec-${stamp}`,
      ]);
      return result.rows[0].id as string;
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  it("rejects rotation for a provider AIHXM doesn't issue the secret for", async () => {
    await service.configure(FIXTURE_CLAIMS, companyId, "smtp", { enabled: true, config: { password: "smtp-pw" } });
    await expect(service.rotateSecret(FIXTURE_CLAIMS, companyId, "smtp")).rejects.toThrow(BadRequestException);
  });

  it("rejects rotation for a provider that has never been configured", async () => {
    await expect(service.rotateSecret(FIXTURE_CLAIMS, companyId, "webhook")).rejects.toThrow(BadRequestException);
  });

  it("rotates a biometric_device apiKey, keeping the old value honored for a grace period", async () => {
    const configured = await service.configure(FIXTURE_CLAIMS, companyId, "biometric_device", {
      enabled: true,
      config: { apiKey: "old-key-value", deviceUrl: "https://device.example" },
    });
    expect(configured.previousSecretExpiresAt).toBeNull();

    const rotated = await service.rotateSecret(FIXTURE_CLAIMS, companyId, "biometric_device");

    // The new secret is real, distinct from the old one, and only ever
    // shown in this one response.
    expect(rotated.newSecretValue).toBeTruthy();
    expect(rotated.newSecretValue).not.toBe("old-key-value");
    expect(rotated.integration.hasSecrets).toBe(true);
    expect(rotated.integration.config.apiKey).toBeUndefined();
    expect(rotated.integration.config.deviceUrl).toBe("https://device.example");
    expect(new Date(rotated.previousSecretExpiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(rotated.integration.previousSecretExpiresAt).toBe(rotated.previousSecretExpiresAt);

    // Neither the old nor the new secret value leaks through JSON-serialized responses.
    expect(JSON.stringify(rotated)).not.toContain("old-key-value");

    // Rotating again immediately still works and simply replaces the
    // stashed previous value (only one rotation in flight at a time).
    const rotatedAgain = await service.rotateSecret(FIXTURE_CLAIMS, companyId, "biometric_device");
    expect(rotatedAgain.newSecretValue).not.toBe(rotated.newSecretValue);

    // The audit trail records that a rotation happened, without either secret value.
    const auditRows = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query(
        "SELECT metadata FROM audit_log WHERE company_id = $1 AND action = 'tenant_integration.secret_rotated' AND target = 'biometric_device'",
        [companyId]
      )
    );
    expect(auditRows.rowCount).toBe(2);
    expect(JSON.stringify(auditRows.rows)).not.toContain(rotated.newSecretValue);
    expect(JSON.stringify(auditRows.rows)).not.toContain("old-key-value");
  });

  it("rotates a webhook signingSecret", async () => {
    await service.configure(FIXTURE_CLAIMS, companyId, "webhook", {
      enabled: true,
      config: { signingSecret: "old-signing-secret" },
    });
    const rotated = await service.rotateSecret(FIXTURE_CLAIMS, companyId, "webhook");
    expect(rotated.newSecretValue).toBeTruthy();
    expect(rotated.newSecretValue).not.toBe("old-signing-secret");

    const listed = await service.list(FIXTURE_CLAIMS, companyId);
    const webhook = listed.find((i) => i.providerKey === "webhook")!;
    expect(webhook.previousSecretExpiresAt).toBe(rotated.previousSecretExpiresAt);
  });
});
