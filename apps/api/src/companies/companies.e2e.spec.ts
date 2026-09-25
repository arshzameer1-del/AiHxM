import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "companies-e2e-fixtures",
};

function signSession(payload: {
  sub: string;
  is_platform_admin: boolean;
  company_id: string | null;
}): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, {
    expiresIn: "10m",
  });
}

describe("Companies HTTP surface (e2e) — Platform Admin company management", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let platformAdminToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      })
    );
    await app.init();

    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);

    // Create a Platform Admin for testing
    const platformAdminId = await db.withClaims(FIXTURE_CLAIMS, async (
      client
    ) => {
      const account = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
        [`companies-e2e-admin-${Date.now()}@example.com`]
      );
      return account.rows[0].id as string;
    });

    platformAdminToken = signSession({
      sub: platformAdminId,
      is_platform_admin: true,
      company_id: null,
    });
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("create company via POST /companies", async () => {
    const slug = `http-create-${Date.now()}`;
    const res = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name: "HTTP Create Test Company",
        slug,
        packageTier: "professional",
        employeeNumberFormat: {
          prefix: "HTTP",
          padding: 5,
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.company).toBeDefined();
    expect(res.body.company.name).toBe("HTTP Create Test Company");
    expect(res.body.company.slug).toBe(slug);
    expect(res.body.config).toBeDefined();
  });

  it("list companies via GET /companies", async () => {
    const res = await request(app.getHttpServer())
      .get("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].id).toBeDefined();
    expect(res.body[0].name).toBeDefined();
    expect(res.body[0].adminCount).toBeDefined();
  });

  it("get company detail via GET /companies/:id", async () => {
    // First create a company
    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name: "Detail Test Company",
        slug: `detail-${Date.now()}`,
      });

    const companyId = createRes.body.company.id;

    // Then get its detail
    const res = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}`)
      .set("Authorization", `Bearer ${platformAdminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.company.id).toBe(companyId);
    expect(res.body.config).toBeDefined();
    expect(res.body.admins).toBeDefined();
    expect(Array.isArray(res.body.admins)).toBe(true);
  });

  it("update company via PATCH /companies/:id", async () => {
    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name: "Update Test Company",
        slug: `update-${Date.now()}`,
      });

    const companyId = createRes.body.company.id;

    const res = await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        status: "suspended",
        packageTier: "enterprise",
        // Suspend/Lock (TM-005/TM-030) require a reason — a real gap this
        // request body used to be missing entirely before that validation
        // existed.
        reason: "Non-payment — 30 days overdue",
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("suspended");
    expect(res.body.packageTier).toBe("enterprise");
    expect(res.body.statusReason).toBe("Non-payment — 30 days overdue");
  });

  it("rejects Suspend/Lock without a reason", async () => {
    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ name: "No Reason Co", slug: `no-reason-${Date.now()}` });

    const res = await request(app.getHttpServer())
      .patch(`/platform/companies/${createRes.body.company.id}`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ status: "locked" });

    expect(res.status).toBe(400);
  });

  it("add company admin via POST /companies/:id/admins", async () => {
    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name: "Admin Test Company",
        slug: `admin-${Date.now()}`,
      });

    const companyId = createRes.body.company.id;
    const adminEmail = `new-admin-${Date.now()}@example.com`;

    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/admins`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        fullName: "New Admin",
        email: adminEmail,
      });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe(adminEmail);
    expect(res.body.hasLogin).toBe(false);
  });

  it("create admin login via POST /companies/:id/admins/:adminId/account", async () => {
    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name: "Login Company",
        slug: `login-${Date.now()}`,
        initialAdmin: {
          fullName: "Test Admin",
          email: `init-admin-${Date.now()}@example.com`,
        },
      });

    const companyId = createRes.body.company.id;
    const adminId = createRes.body.admins[0].id;

    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/admins/${adminId}/account`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        initialPassword: "SecurePassword123!",
      });

    expect(res.status).toBe(201);
    expect(res.body.hasLogin).toBe(true);
  });

  it("impersonate company (Login As) via POST /companies/:id/impersonate", async () => {
    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name: "Impersonate Company",
        slug: `impersonate-${Date.now()}`,
        initialAdmin: {
          fullName: "Impersonate Admin",
          email: `impersonate-admin-${Date.now()}@example.com`,
        },
      });

    const companyId = createRes.body.company.id;
    const adminId = createRes.body.admins[0].id;

    // Tenant Management gap-fill Phase 1 item #4 — impersonation now
    // issues a real, applied-shaped session for an actual admin login, so
    // one has to exist first (just like every other admin-account action
    // in this same spec file).
    await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/admins/${adminId}/account`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ initialPassword: "OriginalPassword123!" });

    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/impersonate`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ reason: "Verifying the Login As flow end to end" });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(res.body.sessionId).toBeDefined();
    expect(res.body.expiresAt).toBeDefined();
    expect(res.body.companyId).toBe(companyId);
    expect(res.body.impersonatedAdminEmail).toBe(createRes.body.admins[0].email);
  });

  it("rejects impersonation without a reason", async () => {
    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name: "Impersonate Company No Reason",
        slug: `impersonate-no-reason-${Date.now()}`,
      });

    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${createRes.body.company.id}/impersonate`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("update company config via PATCH /companies/:id/config", async () => {
    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name: "Config Company",
        slug: `config-${Date.now()}`,
      });

    const companyId = createRes.body.company.id;

    const res = await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}/config`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        employeeNumberFormat: { prefix: "NEWPREFIX" },
        branding: { primaryColor: "#0000FF" },
      });

    expect(res.status).toBe(200);
    expect(res.body.employeeNumberFormat.prefix).toBe("NEWPREFIX");
    expect(res.body.branding.primaryColor).toBe("#0000FF");
  });

  it("lock/unlock company admin via PATCH /companies/:id/admins/:adminId", async () => {
    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name: "Status Company",
        slug: `status-${Date.now()}`,
        initialAdmin: {
          fullName: "Status Test",
          email: `status-${Date.now()}@example.com`,
        },
      });

    const companyId = createRes.body.company.id;
    const adminId = createRes.body.admins[0].id;

    const lockedRes = await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}/admins/${adminId}`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ status: "locked" });

    expect(lockedRes.status).toBe(200);
    expect(lockedRes.body.status).toBe("locked");

    const unlockedRes = await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}/admins/${adminId}`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ status: "active" });

    expect(unlockedRes.status).toBe(200);
    expect(unlockedRes.body.status).toBe("active");
  });
});
