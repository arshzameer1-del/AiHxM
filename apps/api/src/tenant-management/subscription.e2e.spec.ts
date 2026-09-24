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
  sub: "subscription-e2e-fixtures",
};

/** TM-025/026 — Subscription: plan summary, Change Plan, seat management. */
describe("Subscription: plan + seats (e2e)", () => {
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
        [result.rows[0].id, "Subscription E2E Platform Admin", email]
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

    const email = `subscription-e2e-admin-${Date.now()}@example.com`;
    const password = "SuperSecret123!";
    await createPlatformAdmin(email, password);
    platformAdminToken = await loginToSessionToken(email, password);

    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name: `Subscription Test Co ${Date.now()}`,
        slug: `subscription-test-${Date.now()}`,
        packageTier: "starter",
        initialAdmin: { fullName: "Admin", email: `subscription-test-admin-${Date.now()}@example.com` },
      });
    companyId = createRes.body.company.id;
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("returns a summary with zero seats used for a brand-new tenant", async () => {
    const res = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/subscription`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.packageTier).toBe("starter");
    expect(res.body.seatsUsed).toBe(0);
    expect(res.body.history).toEqual([]);
  });

  it("changes plan and records history", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/subscription/change-plan`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ toTier: "growth" });
    expect(res.status).toBe(201);
    expect(res.body.packageTier).toBe("growth");
    expect(res.body.history.length).toBe(1);
    expect(res.body.history[0]).toMatchObject({ fromTier: "starter", toTier: "growth" });
  });

  it("rejects an unknown plan", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/subscription/change-plan`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ toTier: "not-a-real-plan" });
    expect(res.status).toBe(400);
  });

  it("sets seats and reflects availability", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/subscription/seats`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ seatsPurchased: 25 });
    expect(res.status).toBe(201);
    expect(res.body.seatsPurchased).toBe(25);
    expect(res.body.seatsAvailable).toBe(25);
    expect(res.body.history.length).toBe(2); // plan change + seats change
  });

  it("rejects a negative seat count", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/subscription/seats`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ seatsPurchased: -1 });
    expect(res.status).toBe(400);
  });
});
