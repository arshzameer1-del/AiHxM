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
  sub: "webhooks-admin-e2e-fixtures",
};

/**
 * Phase 3 item #4 — Webhooks & Eventing. Proves the two admin-facing
 * routes end to end through the real Nest pipeline (PlatformAdminGuard +
 * ScopedCompanyParam, exactly like every other Tenant Management
 * controller): the delivery log lists what's actually in `webhook_events`,
 * and replay only works from `failed`/`dead_letter`, resetting the row for
 * the next sweep tick.
 */
describe("Webhook events admin routes (e2e)", () => {
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
        [result.rows[0].id, "Webhooks Admin E2E Platform Admin", email]
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

    const email = `webhooks-admin-e2e-admin-${Date.now()}@example.com`;
    const password = "SuperSecret123!";
    await createPlatformAdmin(email, password);
    platformAdminToken = await loginToSessionToken(email, password);

    const adminEmail = `webhooks-admin-e2e-tenant-admin-${Date.now()}@example.com`;
    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name: `Webhooks Admin E2E Co ${Date.now()}`,
        slug: `webhooks-admin-e2e-${Date.now()}`,
        initialAdmin: { fullName: "Admin", email: adminEmail },
      });
    companyId = createRes.body.company.id;
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("lists no events before anything is queued", async () => {
    const res = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/webhook-events`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("rejects a test event before the webhook integration is configured", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/webhook-events/test`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(400);
  });

  it("configures the webhook integration, then queues and lists a test event", async () => {
    const configureRes = await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}/integrations/webhook`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ enabled: true, config: { url: "http://127.0.0.1:1/hook", signingSecret: "webhooks-admin-e2e-secret" } });
    expect(configureRes.status).toBe(200);

    const testRes = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/webhook-events/test`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(testRes.status).toBe(201);
    expect(testRes.body.eventType).toBe("test");
    expect(testRes.body.status).toBe("pending");

    const listRes = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/webhook-events`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].id).toBe(testRes.body.id);
  });

  it("rejects replaying an event that is still pending", async () => {
    const listRes = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/webhook-events`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    const eventId = listRes.body[0].id;

    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/webhook-events/${eventId}/replay`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(400);
  });

  it("replays a dead-lettered event, resetting it back to pending", async () => {
    const listRes = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/webhook-events`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    const eventId = listRes.body[0].id;

    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query(
        "UPDATE webhook_events SET status = 'dead_letter', attempt_count = 5, last_error = 'boom', last_response_status = 500 WHERE id = $1",
        [eventId]
      )
    );

    const replayRes = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/webhook-events/${eventId}/replay`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(replayRes.status).toBe(201);
    expect(replayRes.body.status).toBe("pending");
    expect(replayRes.body.attemptCount).toBe(0);
    expect(replayRes.body.lastError).toBeNull();

    const auditRows = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("SELECT * FROM audit_log WHERE company_id = $1 AND action = 'webhook_event.replayed'", [companyId])
    );
    expect(auditRows.rowCount).toBeGreaterThan(0);
  });

  it("returns 404 for a nonexistent company", async () => {
    const res = await request(app.getHttpServer())
      .get(`/platform/companies/00000000-0000-0000-0000-000000000000/webhook-events`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(404);
  });
});
