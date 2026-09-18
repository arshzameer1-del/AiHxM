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
  sub: "notifications-e2e-fixtures",
};

/**
 * Real routes only (notifications.controller.ts):
 *   POST /notifications  — dispatch(): logs one row, requires a session
 *     with a company_id (throws ForbiddenException otherwise).
 *   GET  /notifications  — list(): reads rows back scoped to the
 *     caller's company_id (returns [] rather than throwing when there
 *     isn't one).
 * Both are behind SessionGuard only — any valid session JWT, not just a
 * Company Super Admin. There is no register/login flow in this suite;
 * the codebase has no /auth/register endpoint, so sessions are minted
 * directly with jsonwebtoken, same as companies.e2e.spec.ts.
 */
describe("Notifications HTTP surface (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let employeeToken: string;
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

    const stamp = Date.now();
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        "INSERT INTO companies (name, slug, status) VALUES ($1, $2, 'active') RETURNING id",
        [`Notifications E2E Co ${stamp}`, `notifications-e2e-${stamp}`]
      );
      return result.rows[0].id as string;
    });

    const employeeId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, $2) RETURNING id",
        [`notifications-e2e-employee-${stamp}@example.com`, "hashed-password"]
      );
      return result.rows[0].id as string;
    });

    employeeToken = jwt.sign(
      { sub: employeeId, company_id: companyId, is_platform_admin: false },
      process.env.JWT_SECRET as string,
      { expiresIn: "10m" }
    );

    platformAdminToken = jwt.sign(
      { sub: "notifications-e2e-platform-admin", company_id: null, is_platform_admin: true },
      process.env.JWT_SECRET as string,
      { expiresIn: "10m" }
    );
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
    await app.close();
  });

  describe("POST /notifications", () => {
    it("dispatches (logs) a notification for a tenant session", async () => {
      const res = await request(app.getHttpServer())
        .post("/notifications")
        .set("Authorization", `Bearer ${employeeToken}`)
        .send({
          channel: "email",
          recipient: "employee@example.com",
          templateKey: "leave_request.submitted",
          payload: { leaveRequestId: "abc-123" },
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.companyId).toBe(companyId);
      expect(res.body.channel).toBe("email");
      expect(res.body.recipient).toBe("employee@example.com");
      expect(res.body.templateKey).toBe("leave_request.submitted");
      expect(res.body.payload).toEqual({ leaveRequestId: "abc-123" });
      expect(res.body.status).toBe("logged");
    });

    it("rejects an invalid channel", async () => {
      const res = await request(app.getHttpServer())
        .post("/notifications")
        .set("Authorization", `Bearer ${employeeToken}`)
        .send({
          channel: "sms",
          recipient: "employee@example.com",
          templateKey: "leave_request.submitted",
        });

      expect(res.status).toBe(400);
    });

    it("rejects a missing templateKey", async () => {
      const res = await request(app.getHttpServer())
        .post("/notifications")
        .set("Authorization", `Bearer ${employeeToken}`)
        .send({
          channel: "email",
          recipient: "employee@example.com",
        });

      expect(res.status).toBe(400);
    });

    it("rejects a platform-admin session with no company_id", async () => {
      const res = await request(app.getHttpServer())
        .post("/notifications")
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({
          channel: "email",
          recipient: "employee@example.com",
          templateKey: "leave_request.submitted",
        });

      expect(res.status).toBe(403);
    });

    it("rejects without authorization", async () => {
      const res = await request(app.getHttpServer()).post("/notifications").send({
        channel: "email",
        recipient: "employee@example.com",
        templateKey: "leave_request.submitted",
      });

      expect(res.status).toBe(401);
    });
  });

  describe("GET /notifications", () => {
    it("lists notifications logged for the caller's company", async () => {
      await request(app.getHttpServer())
        .post("/notifications")
        .set("Authorization", `Bearer ${employeeToken}`)
        .send({
          channel: "in_app",
          recipient: "employee@example.com",
          templateKey: "list.visible",
        });

      const res = await request(app.getHttpServer())
        .get("/notifications")
        .set("Authorization", `Bearer ${employeeToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.some((entry: { templateKey: string }) => entry.templateKey === "list.visible")).toBe(true);
      expect(res.body.every((entry: { companyId: string }) => entry.companyId === companyId)).toBe(true);
    });

    it("respects the limit query param", async () => {
      const res = await request(app.getHttpServer())
        .get("/notifications")
        .query({ limit: 1 })
        .set("Authorization", `Bearer ${employeeToken}`);

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
    });

    it("returns an empty list for a platform-admin session with no company_id", async () => {
      const res = await request(app.getHttpServer())
        .get("/notifications")
        .set("Authorization", `Bearer ${platformAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("rejects without authorization", async () => {
      const res = await request(app.getHttpServer()).get("/notifications");

      expect(res.status).toBe(401);
    });
  });
});
