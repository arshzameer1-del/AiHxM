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
  sub: "tenant-configuration-e2e-fixtures",
};

/**
 * TM-018/019/020 (Tenant Configuration override/inheritance/history/
 * rollback) and TM-021–024 (Module dependency enforcement + Feature
 * entitlements). Proves the effective-value fallback, the version trail,
 * and rollback restoring a genuinely earlier value — not just that the
 * endpoints accept requests.
 */
describe("Tenant Configuration + Module/Feature entitlements (e2e)", () => {
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
        [result.rows[0].id, "Config E2E Platform Admin", email]
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

    const email = `config-e2e-admin-${Date.now()}@example.com`;
    const password = "SuperSecret123!";
    await createPlatformAdmin(email, password);
    platformAdminToken = await loginToSessionToken(email, password);

    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name: `Config Test Co ${Date.now()}`,
        slug: `config-test-${Date.now()}`,
        enabledModules: ["employee", "leave"],
        initialAdmin: { fullName: "Admin", email: `config-test-admin-${Date.now()}@example.com` },
      });
    companyId = createRes.body.company.id;
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("effective value falls back to the product default until overridden", async () => {
    const res = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/configuration`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(200);
    const graceMinutes = res.body.find(
      (s: { category: string; settingKey: string }) => s.category === "attendance" && s.settingKey === "late_grace_minutes"
    );
    expect(graceMinutes).toBeDefined();
    expect(graceMinutes.isOverridden).toBe(false);
    expect(graceMinutes.effectiveValue).toBe(graceMinutes.defaultValue);
  });

  it("rejects an override of the wrong type", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/configuration/attendance/late_grace_minutes`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ value: "not a number" });
    expect(res.status).toBe(400);
  });

  it("overrides, versions, and rolls back correctly", async () => {
    const setRes = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/configuration/attendance/late_grace_minutes`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ value: 20 });
    expect(setRes.status).toBe(201);
    expect(setRes.body.effectiveValue).toBe(20);
    expect(setRes.body.isOverridden).toBe(true);

    const secondSet = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/configuration/attendance/late_grace_minutes`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ value: 30 });
    expect(secondSet.body.effectiveValue).toBe(30);

    const historyRes = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/configuration/attendance/late_grace_minutes/history`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(historyRes.status).toBe(200);
    expect(historyRes.body.length).toBeGreaterThanOrEqual(2);
    expect(historyRes.body[0].newValue).toBe(30);

    // Roll back to the FIRST override (value 20), not the original default.
    const firstVersionId = historyRes.body[historyRes.body.length - 1].id;
    const rollbackRes = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/configuration/rollback`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ versionId: firstVersionId });
    expect(rollbackRes.status).toBe(201);
    expect(rollbackRes.body.effectiveValue).toBe(20);

    const afterRollback = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/configuration`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    const setting = afterRollback.body.find(
      (s: { category: string; settingKey: string }) => s.category === "attendance" && s.settingKey === "late_grace_minutes"
    );
    expect(setting.effectiveValue).toBe(20);
  });

  it("module catalog exposes dependency, and disabling a depended-upon module is rejected", async () => {
    const catalogRes = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/modules`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(catalogRes.status).toBe(200);
    const leave = catalogRes.body.find((m: { key: string }) => m.key === "leave");
    expect(leave.dependsOn).toBe("employee");
    expect(leave.enabled).toBe(true);

    // employee is enabled and leave (which depends on it) is also enabled
    // — trying to disable employee while keeping leave enabled must fail.
    const disableRes = await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}/config`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ enabledModules: ["leave"] });
    expect(disableRes.status).toBe(400);

    // Disabling both together is fine.
    const disableBoth = await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}/config`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ enabledModules: [] });
    expect(disableBoth.status).toBe(200);

    // Restore for any later tests that might reuse this company.
    await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}/config`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ enabledModules: ["employee", "leave"] });
  });

  it("feature entitlements require the owning module to be enabled to turn ON", async () => {
    const listRes = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/features`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(listRes.status).toBe(200);
    const onDuty = listRes.body.find((f: { featureKey: string }) => f.featureKey === "leave.on_duty");
    expect(onDuty).toBeDefined();
    expect(onDuty.enabled).toBe(true); // defaults to enabled once its module is licensed

    const setLimitRes = await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}/features/leave.on_duty`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ usageLimit: 5 });
    expect(setLimitRes.status).toBe(200);
    expect(setLimitRes.body.effectiveLimit).toBe(5);

    // Disable the owning module, then try to turn the feature back ON.
    await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}/config`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ enabledModules: ["employee"] });

    const rejectRes = await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}/features/leave.on_duty`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ enabled: true });
    expect(rejectRes.status).toBe(400);

    // Restore.
    await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}/config`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ enabledModules: ["employee", "leave"] });
  });
});
