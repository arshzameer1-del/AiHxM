import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { generate as generateTotp } from "otplib";
import * as bcrypt from "bcryptjs";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "health-platform-summary-e2e-fixtures",
};

/**
 * Phase 3 item #9 — Monitoring. GET /platform/health/summary end to end
 * through the real Nest pipeline (PlatformAdminGuard, real Postgres RLS),
 * mirroring health.e2e.spec.ts's own setup idiom.
 */
describe("Platform health summary (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let platformAdminToken: string;
  let companyId: string;

  async function createPlatformAdmin(email: string, password: string): Promise<void> {
    const passwordHash = await bcrypt.hash(password, 10);
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, $2) RETURNING id",
        [email, passwordHash]
      );
      await client.query(
        "INSERT INTO platform_admins (user_account_id, full_name, email, status) VALUES ($1, $2, $3, 'active')",
        [result.rows[0].id, "Platform Health Summary E2E Admin", email]
      );
    });
  }

  async function loginToSessionToken(email: string, password: string): Promise<string> {
    const loginRes = await request(app.getHttpServer()).post("/auth/login").send({ email, password });
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

    const email = `health-platform-summary-e2e-admin-${Date.now()}@example.com`;
    const password = "SuperSecret123!";
    await createPlatformAdmin(email, password);
    platformAdminToken = await loginToSessionToken(email, password);

    const adminEmail = `health-platform-summary-e2e-tenant-admin-${Date.now()}@example.com`;
    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name: `Health Platform Summary E2E Co ${Date.now()}`,
        slug: `health-platform-summary-e2e-${Date.now()}`,
        initialAdmin: { fullName: "Admin", email: adminEmail },
      });
    companyId = createRes.body.company.id;
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("rejects a non-platform-admin token", async () => {
    const employeeToken = jwt.sign(
      { sub: "00000000-0000-0000-0000-000000000001", company_id: companyId, is_platform_admin: false },
      process.env.JWT_SECRET as string,
      { expiresIn: "24h" }
    );
    const res = await request(app.getHttpServer())
      .get("/platform/health/summary")
      .set("Authorization", `Bearer ${employeeToken}`);
    expect(res.status).toBe(401);
  });

  it("rejects requests with no token at all", async () => {
    const res = await request(app.getHttpServer()).get("/platform/health/summary");
    expect(res.status).toBe(401);
  });

  it("returns a correctly-shaped summary that counts a freshly-created tenant as never checked", async () => {
    const res = await request(app.getHttpServer())
      .get("/platform/health/summary")
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.generatedAt).toBe("string");
    expect(typeof res.body.totalCompanies).toBe("number");
    expect(typeof res.body.companiesNeverChecked).toBe("number");
    expect(res.body.companiesNeverChecked).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body.failingCompanies)).toBe(true);
    expect(res.body.failingCompanies.find((c: { companyId: string }) => c.companyId === companyId)).toBeUndefined();
  });

  it("surfaces the tenant in failingCompanies, worst check first, once a real check comes back down", async () => {
    // Force a real down signal the same way health.e2e.spec.ts does not
    // need to (that file only ever gets to "degraded") — directly break
    // the scheduler registry isn't possible from here, so we drive it via
    // the storage round-trip instead: run the check once to seed rows,
    // then hand-edit the persisted result to 'down' exactly as
    // data-residency.service.spec.ts and webhooks-admin.e2e.spec.ts do
    // when they need a specific persisted state to assert against, rather
    // than fabricating a HealthCheckResult that never really happened.
    await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/health/check`)
      .set("Authorization", `Bearer ${platformAdminToken}`);

    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query(
        `UPDATE tenant_health_check_log SET status = 'down', detail = 'forced down for e2e'
         WHERE company_id = $1 AND check_key = 'storage'`,
        [companyId]
      )
    );

    const res = await request(app.getHttpServer())
      .get("/platform/health/summary")
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(200);

    const entry = res.body.failingCompanies.find((c: { companyId: string }) => c.companyId === companyId);
    expect(entry).toBeDefined();
    expect(entry.failingChecks.length).toBeGreaterThanOrEqual(1);
    expect(entry.failingChecks[0].checkKey).toBe("storage");
    expect(entry.failingChecks[0].status).toBe("down");

    expect(res.body.companiesNeverChecked).not.toEqual(res.body.totalCompanies);
  });
});
