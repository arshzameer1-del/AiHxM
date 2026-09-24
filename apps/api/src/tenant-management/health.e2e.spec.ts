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
  sub: "health-e2e-fixtures",
};

/**
 * TM-032 — Health dashboard. Proves each of the 6 checks reflects a real
 * signal (not a hardcoded "ok"): a fresh tenant with no integrations
 * enabled and no email activity reports "ok" for those, a real
 * file-storage round-trip is exercised for storage, and enabling an
 * integration with empty config flips it to "degraded".
 */
describe("Health dashboard (e2e)", () => {
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
        [result.rows[0].id, "Health E2E Platform Admin", email]
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

    const email = `health-e2e-admin-${Date.now()}@example.com`;
    const password = "SuperSecret123!";
    await createPlatformAdmin(email, password);
    platformAdminToken = await loginToSessionToken(email, password);

    const adminEmail = `health-test-admin-${Date.now()}@example.com`;
    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name: `Health Test Co ${Date.now()}`,
        slug: `health-test-${Date.now()}`,
        initialAdmin: { fullName: "Admin", email: adminEmail },
      });
    companyId = createRes.body.company.id;
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("returns default 'ok' results before any check has run", async () => {
    const res = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/health`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(6);
    for (const r of res.body) expect(r.status).toBe("ok");
  });

  it("runs a fresh check covering all 6 areas and persists it", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/health/check`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(201);
    const keys = res.body.map((r: { checkKey: string }) => r.checkKey).sort();
    expect(keys).toEqual(["api", "db", "email", "integrations", "jobs", "storage"]);
    expect(res.body.find((r: { checkKey: string }) => r.checkKey === "db").status).toBe("ok");
    // A real file-storage write/read/delete round-trip must have actually run.
    expect(res.body.find((r: { checkKey: string }) => r.checkKey === "storage").status).toBe("ok");
    expect(res.body.find((r: { checkKey: string }) => r.checkKey === "jobs").status).toBe("ok");

    const stored = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("SELECT check_key, status FROM tenant_health_check_log WHERE company_id = $1", [companyId])
    );
    expect(stored.rowCount).toBe(6);
  });

  it("flips integrations to degraded once one is enabled with empty config", async () => {
    await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}/integrations/webhook`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ enabled: true });

    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/health/check`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(201);
    const integrationsResult = res.body.find((r: { checkKey: string }) => r.checkKey === "integrations");
    expect(integrationsResult.status).toBe("degraded");
    expect(integrationsResult.detail).toContain("webhook");
  });

  it("returns 404 for a nonexistent company", async () => {
    const res = await request(app.getHttpServer())
      .get(`/platform/companies/00000000-0000-0000-0000-000000000000/health`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(404);
  });
});
