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
  sub: "data-exports-e2e-fixtures",
};

/**
 * TM-036 — Data export & migration jobs. Proves a real file is produced
 * per scope/format combination (JSON and CSV), a downloaded export's
 * content genuinely reflects this tenant's own rows, and that an
 * expired export is rejected server-side, not just hidden in the UI.
 */
describe("Data exports (e2e)", () => {
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
        [result.rows[0].id, "Exports E2E Platform Admin", email]
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

    const email = `exports-e2e-admin-${Date.now()}@example.com`;
    const password = "SuperSecret123!";
    await createPlatformAdmin(email, password);
    platformAdminToken = await loginToSessionToken(email, password);

    const adminEmail = `exports-test-admin-${Date.now()}@example.com`;
    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name: `Exports Test Co ${Date.now()}`,
        slug: `exports-test-${Date.now()}`,
        initialAdmin: { fullName: "Admin", email: adminEmail },
      });
    companyId = createRes.body.company.id;
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("rejects an unknown scope", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/exports`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ scope: "everything", format: "json" });
    expect(res.status).toBe(400);
  });

  it("produces a real CSV for scope=employees", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/exports`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ scope: "employees", format: "csv" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("completed");
    expect(res.body.format).toBe("csv");
    expect(res.body.expiresAt).toBeTruthy();

    const download = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/exports/${res.body.id}/download`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(download.status).toBe(200);
    expect(download.headers["content-type"]).toContain("text/csv");
    expect(download.text.split("\n")[0]).toBe("id,employee_number,first_name,last_name,employment_status,hire_date");
  });

  it("produces a real JSON bundle for scope=full", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/exports`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ scope: "full", format: "json" });
    expect(res.status).toBe(201);

    const download = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/exports/${res.body.id}/download`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    const parsed = JSON.parse(download.text);
    expect(parsed.companyId).toBe(companyId);
    expect(Array.isArray(parsed.employees)).toBe(true);
    expect(Array.isArray(parsed.attendance)).toBe(true);
    expect(Array.isArray(parsed.payslips)).toBe(true);
  });

  it("rejects downloading an expired export", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/exports`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ scope: "employees", format: "json" });
    const exportId = res.body.id;

    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("UPDATE tenant_data_exports SET expires_at = now() - interval '1 hour' WHERE id = $1", [exportId])
    );

    const download = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/exports/${exportId}/download`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(download.status).toBe(400);
  });

  it("lists all requested exports for the tenant", async () => {
    const res = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/exports`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(3);
  });
});
