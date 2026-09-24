import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { generate as generateTotp } from "otplib";
import * as bcrypt from "bcryptjs";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "sessions-e2e-fixtures",
};

/**
 * TM-017 (Tenant Users → Force Logout) and TM-029 (Tenant Security →
 * active sessions + Revoke). Proves the full stack end to end: listing
 * sessions returns a real row for a real login, per-session Revoke blocks
 * only that session's token, and Force Logout blocks every active session
 * for a user in one call — mirroring the same "prove it actually blocks a
 * live request" discipline as tenant-lifecycle-enforcement.e2e.spec.ts.
 */
describe("Sessions / Force Logout (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let platformAdminToken: string;

  async function createPlatformAdmin(email: string, password: string): Promise<void> {
    const passwordHash = await bcrypt.hash(password, 10);
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, $2) RETURNING id",
        [email, passwordHash]
      );
      await client.query(
        "INSERT INTO platform_admins (user_account_id, full_name, email, status) VALUES ($1, $2, $3, 'active')",
        [result.rows[0].id, "Sessions E2E Platform Admin", email]
      );
    });
  }

  const enrolledSecrets = new Map<string, string>();

  /**
   * Logs in and returns a fresh session token. The first login for a given
   * email goes through MFA enrollment (mfa_setup_required); every login
   * after that for the SAME email already has a TOTP secret on file and
   * goes through ordinary mfa_required verification instead — a real user
   * logging in on a second device doesn't re-enroll MFA.
   */
  async function loginToSessionToken(email: string, password: string): Promise<string> {
    const loginRes = await request(app.getHttpServer()).post("/auth/login").send({ email, password });

    if (loginRes.body.status === "mfa_setup_required") {
      const code = await generateTotp({ secret: loginRes.body.secretForManualEntry });
      enrolledSecrets.set(email, loginRes.body.secretForManualEntry);
      const confirmRes = await request(app.getHttpServer())
        .post("/auth/mfa/enroll/confirm")
        .send({ mfaTicket: loginRes.body.mfaTicket, code });
      return confirmRes.body.token;
    }

    if (loginRes.body.status === "mfa_required") {
      const secret = enrolledSecrets.get(email);
      if (!secret) {
        throw new Error(`No known MFA secret for ${email} to satisfy mfa_required`);
      }
      const code = await generateTotp({ secret });
      const verifyRes = await request(app.getHttpServer())
        .post("/auth/mfa/verify")
        .send({ mfaTicket: loginRes.body.mfaTicket, code });
      return verifyRes.body.token;
    }

    throw new Error(`Unexpected login response: ${JSON.stringify(loginRes.body)}`);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);

    const email = `sessions-e2e-admin-${Date.now()}@example.com`;
    const password = "SuperSecret123!";
    await createPlatformAdmin(email, password);
    platformAdminToken = await loginToSessionToken(email, password);
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  async function createTenantAdmin(labelPrefix: string, password: string) {
    const slugSafe = labelPrefix.toLowerCase().replace(/\s+/g, "-");
    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name: `${labelPrefix} Co`,
        slug: `${slugSafe}-${Date.now()}`,
        initialAdmin: { fullName: "Tenant Admin", email: `${slugSafe}-${Date.now()}@example.com` },
      });
    if (createRes.status !== 201) {
      throw new Error(`Create company failed: ${createRes.status} ${JSON.stringify(createRes.body)}`);
    }
    const companyId = createRes.body.company.id as string;
    const adminId = createRes.body.admins[0].id as string;
    const adminEmail = createRes.body.admins[0].email as string;

    await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/admins/${adminId}/account`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ initialPassword: password });

    // The API surface deliberately never exposes user_account_id (only a
    // `hasLogin` boolean) — look it up directly for the test's own use in
    // targeting Force Logout at the right user.
    const userAccountId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query<{ user_account_id: string }>(
        "SELECT user_account_id FROM company_admins WHERE id = $1",
        [adminId]
      );
      return result.rows[0].user_account_id;
    });

    return { companyId, adminEmail, userAccountId };
  }

  it("lists an active session for a real login and lets a Platform Admin revoke it by id", async () => {
    const { companyId, adminEmail } = await createTenantAdmin("Sessions List", "TenantPass123!");
    const tenantToken = await loginToSessionToken(adminEmail, "TenantPass123!");

    const beforeRevoke = await request(app.getHttpServer())
      .get("/auth/me")
      .set("Authorization", `Bearer ${tenantToken}`);
    expect(beforeRevoke.status).toBe(200);

    const listRes = await request(app.getHttpServer())
      .get(`/platform/sessions?companyId=${companyId}`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(listRes.status).toBe(200);
    const session = listRes.body.find((s: { email: string }) => s.email === adminEmail);
    expect(session).toBeDefined();
    expect(session.revokedAt).toBeNull();

    const revokeRes = await request(app.getHttpServer())
      .post(`/platform/sessions/${session.id}/revoke`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(revokeRes.status).toBe(201);

    const afterRevoke = await request(app.getHttpServer())
      .get("/auth/me")
      .set("Authorization", `Bearer ${tenantToken}`);
    expect(afterRevoke.status).toBe(401);
    expect(afterRevoke.body.message).toMatch(/signed out remotely/i);

    // Revoking an already-revoked session is a clean 404, not a silent no-op.
    const doubleRevoke = await request(app.getHttpServer())
      .post(`/platform/sessions/${session.id}/revoke`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(doubleRevoke.status).toBe(404);
  });

  it("Force Logout revokes every active session for a user, leaving other users untouched", async () => {
    const { adminEmail, userAccountId } = await createTenantAdmin("Force Logout", "TenantPass456!");

    // Two independent logins for the same tenant admin — two devices.
    const tokenA = await loginToSessionToken(adminEmail, "TenantPass456!");
    const tokenB = await loginToSessionToken(adminEmail, "TenantPass456!");

    // A second, unrelated tenant admin whose session must survive.
    const other = await createTenantAdmin("Force Logout Bystander", "TenantPass789!");
    const bystanderToken = await loginToSessionToken(other.adminEmail, "TenantPass789!");

    expect((await request(app.getHttpServer()).get("/auth/me").set("Authorization", `Bearer ${tokenA}`)).status).toBe(
      200
    );
    expect((await request(app.getHttpServer()).get("/auth/me").set("Authorization", `Bearer ${tokenB}`)).status).toBe(
      200
    );

    expect(userAccountId).toBeDefined();
    const forceLogoutRes = await request(app.getHttpServer())
      .post(`/platform/users/${userAccountId}/sessions/revoke`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(forceLogoutRes.status).toBe(201);
    expect(forceLogoutRes.body.revokedCount).toBeGreaterThanOrEqual(2);

    const afterA = await request(app.getHttpServer()).get("/auth/me").set("Authorization", `Bearer ${tokenA}`);
    const afterB = await request(app.getHttpServer()).get("/auth/me").set("Authorization", `Bearer ${tokenB}`);
    expect(afterA.status).toBe(401);
    expect(afterB.status).toBe(401);

    // The bystander's own session was never touched.
    const bystanderStill = await request(app.getHttpServer())
      .get("/auth/me")
      .set("Authorization", `Bearer ${bystanderToken}`);
    expect(bystanderStill.status).toBe(200);
  });
});
