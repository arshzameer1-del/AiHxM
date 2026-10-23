import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { generate as generateTotp } from "otplib";
import * as bcrypt from "bcryptjs";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { DemoRequestsService } from "./demo-requests.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "demo-requests-e2e-fixtures" };
const TAG = `demo-e2e-${Date.now()}`;

/**
 * The marketing website's "Book a demo" form: public submit (validation, honeypot, duplicate handling, per-address
 * cap, RLS) and the Platform Admin list/update that follow it.
 */
describe("Demo requests (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let service: DemoRequestsService;
  let adminToken: string;

  const valid = (n: string) => ({
    fullName: "Ayesha Khan",
    workEmail: `${TAG}-${n}@example.com`,
    companyName: "Test Textiles",
    employeeCount: "51-200",
    interests: ["payroll", "attendance"],
    message: "Please show payroll for Pakistan.",
    sourcePage: "/book-a-demo/",
    consentPrivacy: true,
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    service = moduleRef.get(DemoRequestsService);

    const email = `${TAG}-admin@example.com`;
    const password = "SuperSecret123!";
    const hash = await bcrypt.hash(password, 10);
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const r = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,$2) RETURNING id", [email, hash]);
      await client.query(
        "INSERT INTO platform_admins (user_account_id, full_name, email, status) VALUES ($1,$2,$3,'active')",
        [r.rows[0].id, "Demo E2E Admin", email]
      );
    });
    const login = await request(app.getHttpServer()).post("/auth/login").send({ email, password });
    const code = await generateTotp({ secret: login.body.secretForManualEntry });
    const confirm = await request(app.getHttpServer())
      .post("/auth/mfa/enroll/confirm")
      .send({ mfaTicket: login.body.mfaTicket, code });
    adminToken = confirm.body.token;
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      await client.query("DELETE FROM demo_requests WHERE work_email LIKE $1", [`${TAG}%`]);
    });
    await pool.end();
    await app.close();
  });

  it("saves a valid public request and returns a reference, with no login", async () => {
    const res = await request(app.getHttpServer()).post("/public/demo-requests").send(valid("a"));
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.reference).toMatch(/^AIHXM-[0-9A-F]{8}$/);
    const rows = await db.withClaims(FIXTURE_CLAIMS, (c) =>
      c.query("SELECT * FROM demo_requests WHERE work_email = $1", [`${TAG}-a@example.com`])
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].consent_privacy).toBe(true);
    expect(rows.rows[0].status).toBe("new");
    expect(rows.rows[0].ip_hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("rejects a missing privacy consent and a bad email", async () => {
    const noConsent = await request(app.getHttpServer())
      .post("/public/demo-requests")
      .send({ ...valid("b"), consentPrivacy: false });
    expect(noConsent.status).toBe(400);
    const badEmail = await request(app.getHttpServer())
      .post("/public/demo-requests")
      .send({ ...valid("c"), workEmail: "not-an-email" });
    expect(badEmail.status).toBe(400);
    const rows = await db.withClaims(FIXTURE_CLAIMS, (c) =>
      c.query("SELECT 1 FROM demo_requests WHERE work_email LIKE $1", [`${TAG}-b%`])
    );
    expect(rows.rowCount).toBe(0);
  });

  it("silently drops honeypot submissions without storing anything", async () => {
    const r = await service.submit({ ...valid("bot"), website: "http://spam.example" } as never, "203.0.113.9");
    expect(r.ok).toBe(true);
    const rows = await db.withClaims(FIXTURE_CLAIMS, (c) =>
      c.query("SELECT 1 FROM demo_requests WHERE work_email = $1", [`${TAG}-bot@example.com`])
    );
    expect(rows.rowCount).toBe(0);
  });

  it("counts a repeat from the same email within a day instead of creating a second lead", async () => {
    await service.submit(valid("dup") as never, "203.0.113.10");
    await service.submit({ ...valid("dup"), workEmail: valid("dup").workEmail.toUpperCase() } as never, "203.0.113.10");
    const rows = await db.withClaims(FIXTURE_CLAIMS, (c) =>
      c.query("SELECT duplicate_count FROM demo_requests WHERE lower(work_email) = $1", [`${TAG}-dup@example.com`])
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].duplicate_count).toBe(1);
  });

  it("caps new requests per network address per hour", async () => {
    const ip = "198.51.100.77";
    for (let i = 0; i < 5; i++) await service.submit(valid(`ip${i}`) as never, ip);
    const err = await service.submit(valid("ip5") as never, ip).then(
      () => null,
      (e) => e
    );
    expect(err?.getStatus?.()).toBe(429);
  });

  it("is unreadable without Platform Admin: the list needs a token and RLS blocks tenant-style claims", async () => {
    const anon = await request(app.getHttpServer()).get("/platform/demo-requests");
    expect(anon.status).toBe(401);
    const tenantClaims: RequestClaims = { is_platform_admin: false, company_id: null, sub: "someone" };
    const rows = await db.withClaims(tenantClaims, (c) => c.query("SELECT 1 FROM demo_requests"));
    expect(rows.rowCount).toBe(0);
  });

  it("lets a Platform Admin list, filter and update a request", async () => {
    const list = await request(app.getHttpServer())
      .get("/platform/demo-requests?status=new")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    const mine = list.body.find((r: { workEmail: string }) => r.workEmail === `${TAG}-a@example.com`);
    expect(mine).toBeTruthy();
    expect(mine.interests).toEqual(["payroll", "attendance"]);

    const upd = await request(app.getHttpServer())
      .patch(`/platform/demo-requests/${mine.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "contacted", internalNotes: "Called on Monday" });
    expect(upd.status).toBe(200);
    expect(upd.body.status).toBe("contacted");
    expect(upd.body.internalNotes).toBe("Called on Monday");

    const bad = await request(app.getHttpServer())
      .patch(`/platform/demo-requests/${mine.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "won" });
    expect(bad.status).toBe(400);
  });
});
