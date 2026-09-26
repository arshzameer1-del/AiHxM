import { Pool } from "pg";
import * as bcrypt from "bcryptjs";
import { SecurityPostureService } from "./security-posture.service";
import { DatabaseService } from "../database/database.service";
import { SessionSecurityService } from "../auth/session-security.service";
import { CacheService } from "../cache/cache.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "posture-spec-admin" };

/**
 * Phase 3 item #8 — security posture scoring. Entirely computed, no new
 * table; real Postgres, same idiom as data-residency.service.spec.ts,
 * since correctness here is really about the SQL joins (company_admins
 * -> user_accounts.mfa_enabled, tenant_integrations, tenant_configuration
 * via SessionSecurityService), not pure logic a mock could stand in for.
 */
describe("SecurityPostureService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let service: SecurityPostureService;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    service = new SecurityPostureService(db, new SessionSecurityService(db, new CacheService()));
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createCompany(): Promise<string> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        "INSERT INTO companies (name, slug, status, package_tier) VALUES ($1, $2, 'active', 'starter') RETURNING id",
        [`Posture Spec Co ${stamp}`, `posture-spec-${stamp}`]
      );
      return result.rows[0].id as string;
    });
  }

  async function addAdmin(companyId: string, opts?: { mfaEnabled?: boolean; locked?: boolean }): Promise<string> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const passwordHash = await bcrypt.hash("SecurePassword123!", 10);
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const account = await client.query(
        `INSERT INTO user_accounts (email, password_hash, mfa_enabled, locked_until)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [
          `posture-admin-${stamp}@example.com`,
          passwordHash,
          opts?.mfaEnabled ?? false,
          opts?.locked ? new Date(Date.now() + 60 * 60 * 1000).toISOString() : null,
        ]
      );
      const userAccountId = account.rows[0].id as string;
      await client.query(
        `INSERT INTO company_admins (company_id, full_name, email, user_account_id)
         VALUES ($1, 'Posture Admin', $2, $3)`,
        [companyId, `posture-admin-${stamp}@example.com`, userAccountId]
      );
      return userAccountId;
    });
  }

  async function setSecurityOverride(companyId: string, settingKey: string, value: unknown): Promise<void> {
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query(
        `INSERT INTO tenant_configuration (company_id, category, setting_key, value, updated_by)
         VALUES ($1, 'security', $2, $3::jsonb, 'test-fixture')
         ON CONFLICT (company_id, category, setting_key) DO UPDATE SET value = EXCLUDED.value`,
        [companyId, settingKey, JSON.stringify(value)]
      )
    );
  }

  function signal(score: Awaited<ReturnType<SecurityPostureService["getScore"]>>, key: string) {
    const found = score.signals.find((s) => s.key === key);
    if (!found) throw new Error(`No signal for key ${key}`);
    return found;
  }

  it("404s for an unknown company", async () => {
    await expect(
      service.getScore(FIXTURE_CLAIMS, "00000000-0000-0000-0000-000000000000")
    ).rejects.toThrow();
  });

  it("scores a freshly-created tenant with nothing configured: no admins yet, and every configurable signal failing", async () => {
    const companyId = await createCompany();

    const score = await service.getScore(FIXTURE_CLAIMS, companyId);

    // No admins at all: MFA coverage has nothing to be behind on, so it
    // scores full marks rather than penalizing an incomplete setup step.
    expect(signal(score, "admin_mfa_coverage").passed).toBe(true);
    expect(signal(score, "admin_mfa_coverage").pointsEarned).toBe(25);
    // Nothing else has been configured for a brand-new tenant.
    expect(signal(score, "sso_configured").passed).toBe(false);
    expect(signal(score, "ip_allow_or_denylist").passed).toBe(false);
    expect(signal(score, "concurrent_session_limit").passed).toBe(false);
    expect(signal(score, "no_active_admin_lockouts").passed).toBe(true);
    // The lockout policy default (5 attempts / 15 min) is reasonable, so
    // this passes even with zero explicit configuration.
    expect(signal(score, "lockout_policy_not_permissive").passed).toBe(true);
  });

  it("gives full MFA-coverage points when every admin has MFA enabled", async () => {
    const companyId = await createCompany();
    await addAdmin(companyId, { mfaEnabled: true });
    await addAdmin(companyId, { mfaEnabled: true });

    const score = await service.getScore(FIXTURE_CLAIMS, companyId);

    expect(signal(score, "admin_mfa_coverage").pointsEarned).toBe(25);
    expect(signal(score, "admin_mfa_coverage").passed).toBe(true);
  });

  it("awards partial MFA-coverage points proportional to the fraction of admins with MFA enabled", async () => {
    const companyId = await createCompany();
    await addAdmin(companyId, { mfaEnabled: true });
    await addAdmin(companyId, { mfaEnabled: false });

    const score = await service.getScore(FIXTURE_CLAIMS, companyId);

    expect(signal(score, "admin_mfa_coverage").pointsEarned).toBe(13); // round(25 * 0.5)
    expect(signal(score, "admin_mfa_coverage").passed).toBe(false);
  });

  it("scores zero MFA-coverage points when no admin has MFA enabled", async () => {
    const companyId = await createCompany();
    await addAdmin(companyId, { mfaEnabled: false });

    const score = await service.getScore(FIXTURE_CLAIMS, companyId);

    expect(signal(score, "admin_mfa_coverage").pointsEarned).toBe(0);
  });

  it("passes the SSO signal only when the sso integration row is both present and enabled", async () => {
    const companyId = await createCompany();
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query(
        `INSERT INTO tenant_integrations (company_id, provider_key, enabled, config, updated_by)
         VALUES ($1, 'sso', true, '{}'::jsonb, 'test-fixture')`,
        [companyId]
      )
    );

    const score = await service.getScore(FIXTURE_CLAIMS, companyId);

    expect(signal(score, "sso_configured").passed).toBe(true);
    expect(signal(score, "sso_configured").pointsEarned).toBe(15);
  });

  it("fails the SSO signal when the integration row exists but is disabled", async () => {
    const companyId = await createCompany();
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query(
        `INSERT INTO tenant_integrations (company_id, provider_key, enabled, config, updated_by)
         VALUES ($1, 'sso', false, '{}'::jsonb, 'test-fixture')`,
        [companyId]
      )
    );

    const score = await service.getScore(FIXTURE_CLAIMS, companyId);

    expect(signal(score, "sso_configured").passed).toBe(false);
  });

  it("passes the IP-list signal once either an allowlist or a denylist is configured", async () => {
    const companyId = await createCompany();
    await setSecurityOverride(companyId, "ip_denylist", "198.51.100.0/24");

    const score = await service.getScore(FIXTURE_CLAIMS, companyId);

    expect(signal(score, "ip_allow_or_denylist").passed).toBe(true);
  });

  it("passes the concurrent-session signal once it's capped away from unlimited", async () => {
    const companyId = await createCompany();
    await setSecurityOverride(companyId, "max_concurrent_sessions", 3);

    const score = await service.getScore(FIXTURE_CLAIMS, companyId);

    expect(signal(score, "concurrent_session_limit").passed).toBe(true);
  });

  it("fails the lockout-active signal when an admin is currently locked out", async () => {
    const companyId = await createCompany();
    await addAdmin(companyId, { mfaEnabled: true, locked: true });

    const score = await service.getScore(FIXTURE_CLAIMS, companyId);

    expect(signal(score, "no_active_admin_lockouts").passed).toBe(false);
    expect(signal(score, "no_active_admin_lockouts").pointsEarned).toBe(0);
  });

  it("fails the lockout-policy signal once the override effectively disables lockout", async () => {
    const companyId = await createCompany();
    await setSecurityOverride(companyId, "max_login_attempts", 999);

    const score = await service.getScore(FIXTURE_CLAIMS, companyId);

    expect(signal(score, "lockout_policy_not_permissive").passed).toBe(false);
  });

  it("produces a high score when every signal passes, and the breakdown sums exactly to the total", async () => {
    const companyId = await createCompany();
    await addAdmin(companyId, { mfaEnabled: true });
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query(
        `INSERT INTO tenant_integrations (company_id, provider_key, enabled, config, updated_by)
         VALUES ($1, 'sso', true, '{}'::jsonb, 'test-fixture')`,
        [companyId]
      )
    );
    await setSecurityOverride(companyId, "ip_allowlist", "203.0.113.0/24");
    await setSecurityOverride(companyId, "max_concurrent_sessions", 3);

    const score = await service.getScore(FIXTURE_CLAIMS, companyId);

    expect(score.maxScore).toBe(100);
    expect(score.score).toBe(100);
    expect(score.signals.every((s) => s.passed)).toBe(true);
    const summed = score.signals.reduce((sum, s) => sum + s.pointsEarned, 0);
    expect(summed).toBe(score.score);
    const possibleSummed = score.signals.reduce((sum, s) => sum + s.pointsPossible, 0);
    expect(possibleSummed).toBe(score.maxScore);
  });

  it("produces a low score when several signals fail (nothing configured, an unenforced lockout policy, an active lockout)", async () => {
    const companyId = await createCompany();
    await addAdmin(companyId, { mfaEnabled: false, locked: true });
    await setSecurityOverride(companyId, "max_login_attempts", 999);
    await setSecurityOverride(companyId, "lockout_duration_minutes", 1);

    const score = await service.getScore(FIXTURE_CLAIMS, companyId);

    expect(score.score).toBeLessThan(50);
    expect(signal(score, "admin_mfa_coverage").pointsEarned).toBe(0);
    expect(signal(score, "no_active_admin_lockouts").pointsEarned).toBe(0);
    expect(signal(score, "lockout_policy_not_permissive").pointsEarned).toBe(0);
  });
});
