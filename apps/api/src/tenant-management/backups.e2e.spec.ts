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
  sub: "backups-e2e-fixtures",
};

/**
 * TM-035 — Backups. Proves a backup produces a REAL JSON snapshot file
 * (not just a DB row claiming success) — it can be downloaded back and
 * its contents genuinely describe this tenant — and that an ineligible
 * (archived) tenant is rejected.
 */
describe("Backups (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let platformAdminToken: string;
  let companyId: string;
  let companyName: string;

  async function createPlatformAdmin(email: string, password: string): Promise<void> {
    const passwordHash = await bcrypt.hash(password, 10);
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, $2) RETURNING id",
        [email, passwordHash]
      );
      await client.query(
        "INSERT INTO platform_admins (user_account_id, full_name, email, status) VALUES ($1, $2, $3, 'active')",
        [result.rows[0].id, "Backups E2E Platform Admin", email]
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

    const email = `backups-e2e-admin-${Date.now()}@example.com`;
    const password = "SuperSecret123!";
    await createPlatformAdmin(email, password);
    platformAdminToken = await loginToSessionToken(email, password);

    companyName = `Backups Test Co ${Date.now()}`;
    const adminEmail = `backups-test-admin-${Date.now()}@example.com`;
    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ name: companyName, slug: `backups-test-${Date.now()}`, initialAdmin: { fullName: "Admin", email: adminEmail } });
    companyId = createRes.body.company.id;
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  let backupId: string;

  it("creates a real backup with a nonzero file size", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/backups`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("completed");
    expect(res.body.sizeBytes).toBeGreaterThan(0);
    backupId = res.body.id;
  });

  it("lists the backup", async () => {
    const res = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/backups`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(backupId);
  });

  it("downloads the backup and its content genuinely describes this tenant", async () => {
    const res = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/backups/${backupId}/download`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(200);
    const snapshot = JSON.parse(res.text);
    expect(snapshot.companyId).toBe(companyId);
    expect(snapshot.companyName).toBe(companyName);
    expect(Array.isArray(snapshot.employees)).toBe(true);
    expect(Array.isArray(snapshot.admins)).toBe(true);
  });

  it("rejects a backup for an archived tenant", async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("UPDATE companies SET status = 'archived' WHERE id = $1", [companyId])
    );
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/backups`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(400);
  });

  // Phase 3 item #7 — manual DR test evidence log.
  describe("DR test evidence log", () => {
    it("starts empty", async () => {
      const res = await request(app.getHttpServer())
        .get(`/platform/companies/${companyId}/backups/dr-tests`)
        .set("Authorization", `Bearer ${platformAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("rejects an unknown outcome value", async () => {
      const res = await request(app.getHttpServer())
        .post(`/platform/companies/${companyId}/backups/dr-tests`)
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({ testedAt: "2026-06-01T10:00:00.000Z", outcome: "bogus" });
      expect(res.status).toBe(400);
    });

    it("records a real DR test result", async () => {
      const res = await request(app.getHttpServer())
        .post(`/platform/companies/${companyId}/backups/dr-tests`)
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({
          testedAt: "2026-06-01T10:00:00.000Z",
          outcome: "pass",
          notes: "Restored the latest backup into a scratch environment and verified employee records.",
        });
      expect(res.status).toBe(201);
      expect(res.body.outcome).toBe("pass");
      expect(res.body.companyId).toBe(companyId);
      expect(res.body.recordedBy).toBeTruthy();
    });

    it("lists the recorded DR test back", async () => {
      const res = await request(app.getHttpServer())
        .get(`/platform/companies/${companyId}/backups/dr-tests`)
        .set("Authorization", `Bearer ${platformAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].outcome).toBe("pass");
    });
  });
});
