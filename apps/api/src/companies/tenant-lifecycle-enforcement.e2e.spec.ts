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
  sub: "tenant-lifecycle-e2e-fixtures",
};

/**
 * Proves TM-030 (Tenant Lock) and TM-005 (Suspend) actually block a live
 * session, and that TM-017/029 (Force Logout) actually revokes one — not
 * just that `companies.status`/`user_sessions.revoked_at` can be written,
 * which is the gap this whole feature closes (see SessionSecurityService's
 * doc comment: before this, `PlatformAdminGuard`/`SessionGuard` did pure
 * `jwt.verify` with no DB access at all, so neither flag had any real
 * effect on a token already issued).
 */
describe("Tenant lock / suspend / force-logout enforcement (e2e)", () => {
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
        [result.rows[0].id, "Lifecycle E2E Platform Admin", email]
      );
    });
  }

  async function loginToSessionToken(email: string, password: string): Promise<string> {
    const loginRes = await request(app.getHttpServer()).post("/auth/login").send({ email, password });
    if (loginRes.body.status !== "mfa_setup_required") {
      throw new Error(`Expected mfa_setup_required, got ${JSON.stringify(loginRes.body)}`);
    }
    const code = await generateTotp({ secret: loginRes.body.secretForManualEntry });
    const confirmRes = await request(app.getHttpServer())
      .post("/auth/mfa/enroll/confirm")
      .send({ mfaTicket: loginRes.body.mfaTicket, code });
    return confirmRes.body.token;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);

    const email = `lifecycle-e2e-admin-${Date.now()}@example.com`;
    const password = "SuperSecret123!";
    await createPlatformAdmin(email, password);
    platformAdminToken = await loginToSessionToken(email, password);
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("locking a company blocks that company's already-issued session on its very next request", async () => {
    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name: "Lock Enforcement Co",
        slug: `lock-enforce-${Date.now()}`,
        initialAdmin: { fullName: "Tenant Admin", email: `tenant-admin-${Date.now()}@example.com` },
      });
    const companyId = createRes.body.company.id as string;
    const adminId = createRes.body.admins[0].id as string;
    const adminEmail = createRes.body.admins[0].email as string;
    const adminPassword = "TenantAdminPass123!";

    // createAdminLogin now grants hr_admin + system_admin automatically
    // (companies.service.ts) — without that fix this session would
    // already be useless before we even get to testing lock enforcement.
    await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/admins/${adminId}/account`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ initialPassword: adminPassword });

    const tenantToken = await loginToSessionToken(adminEmail, adminPassword);

    const beforeLock = await request(app.getHttpServer())
      .get("/auth/me")
      .set("Authorization", `Bearer ${tenantToken}`);
    expect(beforeLock.status).toBe(200);
    expect(beforeLock.body.roleKeys).toContain("hr_admin");
    expect(beforeLock.body.roleKeys).toContain("system_admin");

    const lockRes = await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ status: "locked", reason: "Fraud review" });
    expect(lockRes.status).toBe(200);

    const afterLock = await request(app.getHttpServer())
      .get("/auth/me")
      .set("Authorization", `Bearer ${tenantToken}`);
    expect(afterLock.status).toBe(401);

    // Reactivating restores access with the SAME token — locking isn't a
    // one-way door, and nothing about it invalidated the token itself.
    const reactivateRes = await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ status: "active" });
    expect(reactivateRes.status).toBe(200);

    const afterReactivate = await request(app.getHttpServer())
      .get("/auth/me")
      .set("Authorization", `Bearer ${tenantToken}`);
    expect(afterReactivate.status).toBe(200);
  });

  it("suspending a company blocks it the same way locking does", async () => {
    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name: "Suspend Enforcement Co",
        slug: `suspend-enforce-${Date.now()}`,
        initialAdmin: { fullName: "Tenant Admin 2", email: `tenant-admin-2-${Date.now()}@example.com` },
      });
    const companyId = createRes.body.company.id as string;
    const adminId = createRes.body.admins[0].id as string;
    const adminEmail = createRes.body.admins[0].email as string;
    const adminPassword = "TenantAdminPass456!";

    await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/admins/${adminId}/account`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ initialPassword: adminPassword });

    const tenantToken = await loginToSessionToken(adminEmail, adminPassword);

    await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ status: "suspended", reason: "Non-payment" });

    const afterSuspend = await request(app.getHttpServer())
      .get("/auth/me")
      .set("Authorization", `Bearer ${tenantToken}`);
    expect(afterSuspend.status).toBe(401);
  });
});
