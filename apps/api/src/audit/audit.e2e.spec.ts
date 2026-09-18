import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "./audit.service";
import type { RequestClaims } from "../database/tenant-context";

/**
 * The real, only HTTP surface for audit is `GET /platform/audit-log`
 * (audit.controller.ts), guarded by `PlatformAdminGuard` — there is no
 * tenant-facing `/audit-logs` route, no `:id` detail route, and no
 * action/date-range/user query params; only `companyId` and `limit`.
 * Matches companies.e2e.spec.ts's pattern for minting a session: this
 * app has no public self-registration endpoint (companies and platform
 * admins are provisioned, not signed up), so tests insert a
 * `user_accounts` row directly and sign its JWT with the same
 * `JWT_SECRET` the running app validates against.
 */
const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "audit-e2e-fixtures" };

function signSession(payload: { sub: string; is_platform_admin: boolean; company_id: string | null }): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: "10m" });
}

describe("Audit Log HTTP surface (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let audit: AuditService;
  let platformAdminToken: string;
  let companyId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    audit = new AuditService();

    const stamp = Date.now();
    const platformAdminId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const account = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
        [`audit-e2e-admin-${stamp}@example.com`]
      );
      return account.rows[0].id as string;
    });
    platformAdminToken = signSession({ sub: platformAdminId, is_platform_admin: true, company_id: null });

    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Audit E2E Co ${stamp}`,
        `audit-e2e-co-${stamp}`,
      ]);
      return result.rows[0].id as string;
    });

    // Seed a couple of real entries the way any other module actually
    // writes them — inside its own transaction via `audit.record`.
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      audit.record(client, FIXTURE_CLAIMS, { companyId, action: "company.create", target: `company:${companyId}` })
    );
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      audit.record(client, FIXTURE_CLAIMS, { companyId, action: "company.config.update" })
    );
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
    await app.close();
  });

  describe("GET /platform/audit-log", () => {
    it("returns entries for a Platform Admin", async () => {
      const response = await request(app.getHttpServer())
        .get("/platform/audit-log")
        .set("Authorization", `Bearer ${platformAdminToken}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    it("rejects an unauthenticated request", async () => {
      const response = await request(app.getHttpServer()).get("/platform/audit-log");
      expect(response.status).toBe(401);
    });

    it("filters by companyId", async () => {
      const response = await request(app.getHttpServer())
        .get("/platform/audit-log")
        .query({ companyId })
        .set("Authorization", `Bearer ${platformAdminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.length).toBeGreaterThanOrEqual(2);
      expect(response.body.every((e: { companyId: string }) => e.companyId === companyId)).toBe(true);
      expect(response.body.some((e: { action: string }) => e.action === "company.create")).toBe(true);
    });

    it("respects a limit query param", async () => {
      const response = await request(app.getHttpServer())
        .get("/platform/audit-log")
        .query({ companyId, limit: "1" })
        .set("Authorization", `Bearer ${platformAdminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.length).toBeLessThanOrEqual(1);
    });

    it("rejects a non-Platform-Admin session", async () => {
      const stamp = Date.now();
      const tenantUserId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const account = await client.query(
          "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
          [`audit-e2e-tenant-${stamp}@example.com`]
        );
        return account.rows[0].id as string;
      });
      const tenantToken = signSession({ sub: tenantUserId, is_platform_admin: false, company_id: companyId });

      const response = await request(app.getHttpServer())
        .get("/platform/audit-log")
        .set("Authorization", `Bearer ${tenantToken}`);

      // PlatformAdminGuard throws UnauthorizedException (401), not 403,
      // for a valid-but-non-admin token — see platform-admin.guard.ts.
      expect(response.status).toBe(401);
    });

    it("each entry carries the fields the frontend audit log page reads", async () => {
      const response = await request(app.getHttpServer())
        .get("/platform/audit-log")
        .query({ companyId })
        .set("Authorization", `Bearer ${platformAdminToken}`);

      const entry = response.body[0];
      expect(entry).toHaveProperty("id");
      expect(entry).toHaveProperty("companyId");
      expect(entry).toHaveProperty("companyName");
      expect(entry).toHaveProperty("actor");
      expect(entry).toHaveProperty("action");
      expect(entry).toHaveProperty("target");
      expect(entry).toHaveProperty("metadata");
      expect(entry).toHaveProperty("createdAt");
    });
  });
});
