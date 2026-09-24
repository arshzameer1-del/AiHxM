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
  sub: "integrations-e2e-fixtures",
};

/**
 * TM-031 — Integration catalog (SMTP/SSO/biometric device/webhook).
 * Proves: all 4 providers list with sane unconfigured defaults, a secret
 * field written on configure is never echoed back (only `hasSecrets`
 * flips true), and a later partial update that doesn't touch `config`
 * preserves the previously-set secret rather than wiping it.
 */
describe("Integrations catalog (e2e)", () => {
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
        [result.rows[0].id, "Integrations E2E Platform Admin", email]
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

    const email = `integrations-e2e-admin-${Date.now()}@example.com`;
    const password = "SuperSecret123!";
    await createPlatformAdmin(email, password);
    platformAdminToken = await loginToSessionToken(email, password);

    const adminEmail = `integrations-test-admin-${Date.now()}@example.com`;
    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name: `Integrations Test Co ${Date.now()}`,
        slug: `integrations-test-${Date.now()}`,
        initialAdmin: { fullName: "Admin", email: adminEmail },
      });
    companyId = createRes.body.company.id;
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("lists all 4 providers unconfigured by default", async () => {
    const res = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/integrations`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);
    const keys = res.body.map((i: { providerKey: string }) => i.providerKey).sort();
    expect(keys).toEqual(["biometric_device", "smtp", "sso", "webhook"]);
    for (const integration of res.body) {
      expect(integration.enabled).toBe(false);
      expect(integration.hasSecrets).toBe(false);
    }
  });

  it("rejects an unknown provider key", async () => {
    const res = await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}/integrations/carrier-pigeon`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ enabled: true, config: {} });
    expect(res.status).toBe(400);
  });

  it("configures SMTP with a secret and never echoes the secret back", async () => {
    const res = await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}/integrations/smtp`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        enabled: true,
        config: { host: "smtp.example.com", port: 587, username: "notifier", password: "hunter2secret" },
      });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.hasSecrets).toBe(true);
    expect(res.body.config.host).toBe("smtp.example.com");
    expect(res.body.config.username).toBe("notifier");
    expect(res.body.config.password).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("hunter2secret");

    const stored = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query<{ config: { password?: string } }>(
        "SELECT config FROM tenant_integrations WHERE company_id = $1 AND provider_key = 'smtp'",
        [companyId]
      )
    );
    expect(stored.rows[0].config.password).toBe("hunter2secret");
  });

  it("preserves a previously-set secret across a partial update", async () => {
    const res = await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}/integrations/smtp`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ config: { host: "smtp2.example.com" } });
    expect(res.status).toBe(200);
    expect(res.body.config.host).toBe("smtp2.example.com");
    expect(res.body.hasSecrets).toBe(true);

    const stored = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query<{ config: { password?: string; username?: string } }>(
        "SELECT config FROM tenant_integrations WHERE company_id = $1 AND provider_key = 'smtp'",
        [companyId]
      )
    );
    expect(stored.rows[0].config.password).toBe("hunter2secret");
    expect(stored.rows[0].config.username).toBe("notifier");
  });

  it("returns 404 for a nonexistent company", async () => {
    const res = await request(app.getHttpServer())
      .get(`/platform/companies/00000000-0000-0000-0000-000000000000/integrations`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(404);
  });
});
