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
  sub: "support-tickets-e2e-fixtures",
};

/**
 * TM-033 — Support tickets. Proves creation requires subject+description,
 * a ticket confirmation notification is actually logged, status/priority
 * filtering works, and update() only touches the fields supplied.
 */
describe("Support tickets (e2e)", () => {
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
        [result.rows[0].id, "Support E2E Platform Admin", email]
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

    const email = `support-e2e-admin-${Date.now()}@example.com`;
    const password = "SuperSecret123!";
    await createPlatformAdmin(email, password);
    platformAdminToken = await loginToSessionToken(email, password);

    const adminEmail = `support-test-admin-${Date.now()}@example.com`;
    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name: `Support Test Co ${Date.now()}`,
        slug: `support-test-${Date.now()}`,
        initialAdmin: { fullName: "Admin", email: adminEmail },
      });
    companyId = createRes.body.company.id;
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("rejects a ticket without a subject", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/support-tickets`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ description: "Something is broken" });
    expect(res.status).toBe(400);
  });

  let ticketId: string;

  it("creates a ticket, defaulting to normal priority and open status", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/support-tickets`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ subject: "Payroll run stuck", description: "The March payroll run has been queued for 2 hours." });
    expect(res.status).toBe(201);
    expect(res.body.priority).toBe("normal");
    expect(res.body.status).toBe("open");
    ticketId = res.body.id;

    // The confirmation notification is dispatched fire-and-forget — give
    // it a moment to land before checking notification_log.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const notif = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("SELECT * FROM notification_log WHERE company_id = $1 AND template_key = 'support_ticket_created'", [
        companyId,
      ])
    );
    expect(notif.rowCount).toBe(1);
  });

  it("filters tickets by status", async () => {
    await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/support-tickets`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ subject: "Urgent: login broken", description: "Nobody can log in.", priority: "urgent" });

    const openRes = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/support-tickets?status=open`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(openRes.status).toBe(200);
    expect(openRes.body.length).toBeGreaterThanOrEqual(2);

    const resolvedRes = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/support-tickets?status=resolved`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(resolvedRes.body).toHaveLength(0);
  });

  it("updates only the fields supplied", async () => {
    const res = await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}/support-tickets/${ticketId}`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ status: "in_progress", assignee: "ops@aihxm.internal" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");
    expect(res.body.assignee).toBe("ops@aihxm.internal");
    expect(res.body.priority).toBe("normal"); // untouched

    const res2 = await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}/support-tickets/${ticketId}`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ priority: "high" });
    expect(res2.body.priority).toBe("high");
    expect(res2.body.status).toBe("in_progress"); // untouched
    expect(res2.body.assignee).toBe("ops@aihxm.internal"); // untouched
  });

  it("returns 404 updating a nonexistent ticket", async () => {
    const res = await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}/support-tickets/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ status: "closed" });
    expect(res.status).toBe(404);
  });
});
