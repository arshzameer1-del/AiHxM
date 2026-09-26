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
  sub: "residency-e2e-fixtures",
};

/**
 * Phase 3 item #6 — Data Residency & Sovereignty (declaration + disclosure
 * only). Proves the real HTTP surface: declaring a requirement, the
 * computed compliance status flipping between no_requirement/matches/
 * mismatch, and that Acknowledge is only ever accepted for a genuine
 * mismatch.
 */
describe("Data Residency (e2e)", () => {
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
        [result.rows[0].id, "Residency E2E Platform Admin", email]
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

    const email = `residency-e2e-admin-${Date.now()}@example.com`;
    const password = "SuperSecret123!";
    await createPlatformAdmin(email, password);
    platformAdminToken = await loginToSessionToken(email, password);

    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name: `Residency Test Co ${Date.now()}`,
        slug: `residency-test-${Date.now()}`,
        initialAdmin: { fullName: "Admin", email: `residency-test-admin-${Date.now()}@example.com` },
      });
    companyId = createRes.body.company.id;
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("starts with no requirement declared", async () => {
    const res = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/residency`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.requiredRegion).toBeNull();
    expect(res.body.complianceStatus).toBe("no_requirement");
    expect(res.body.platformActualRegion).toEqual(expect.any(String));
    expect(res.body.platformActualRegion.length).toBeGreaterThan(0);
  });

  it("rejects Acknowledge before any mismatch exists", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/residency/acknowledge`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(400);
  });

  it("declaring a requirement that clearly does not match the platform's region surfaces a mismatch", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/residency`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ requiredRegion: "Pakistan only, strictly on-prem" });
    expect(res.status).toBe(201);
    expect(res.body.requiredRegion).toBe("Pakistan only, strictly on-prem");
    expect(res.body.complianceStatus).toBe("mismatch");
    expect(res.body.acknowledgedBy).toBeNull();
  });

  it("Acknowledge now succeeds and records the admin who acknowledged it", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/residency/acknowledge`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(201);
    expect(res.body.complianceStatus).toBe("mismatch");
    expect(res.body.acknowledgedBy).toBeTruthy();
    expect(res.body.acknowledgedAt).toBeTruthy();
  });

  it("changing the declared requirement clears the prior acknowledgment", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/residency`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ requiredRegion: "European Union only" });
    expect(res.status).toBe(201);
    expect(res.body.acknowledgedBy).toBeNull();
    expect(res.body.acknowledgedAt).toBeNull();
  });

  it("clearing the requirement returns to no_requirement", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/residency`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ requiredRegion: null });
    expect(res.status).toBe(201);
    expect(res.body.requiredRegion).toBeNull();
    expect(res.body.complianceStatus).toBe("no_requirement");
  });
});
