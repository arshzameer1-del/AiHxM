import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { enableMfaForTestAccount, performStepUpForTest, testSessionId } from "../auth/step-up-test-support";

/**
 * The real HTTP surface for platform admins (platform-admins.controller.ts)
 * is GET/POST /platform/admins and PATCH /platform/admins/:id, all guarded
 * by PlatformAdminGuard — there is no /auth/register endpoint anywhere in
 * this app. Matches companies.e2e.spec.ts's pattern for minting a session:
 * insert a user_accounts row directly and sign its JWT with the same
 * JWT_SECRET the running app validates against.
 */
const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "platform-admins-e2e-fixtures",
};

function signSession(payload: {
  sub: string;
  is_platform_admin: boolean;
  company_id: string | null;
  jti?: string;
}): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, {
    expiresIn: "10m",
  });
}

describe("Platform Admins HTTP surface (e2e)", () => {
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

    const platformAdminId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const account = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
        [`platform-admins-e2e-caller-${Date.now()}@example.com`]
      );
      return account.rows[0].id as string;
    });

    // Phase 2 gap-fill item #2 — every route this file exercises (POST
    // /platform/admins, PATCH /platform/admins/:id/access is covered by
    // platform-admin-delegation.e2e.spec.ts instead) now requires a recent
    // step-up grant. See step-up-test-support.ts's doc comment.
    const mfaSecret = await enableMfaForTestAccount(db, platformAdminId);
    platformAdminToken = signSession({
      sub: platformAdminId,
      is_platform_admin: true,
      company_id: null,
      jti: testSessionId(),
    });
    await performStepUpForTest(app, platformAdminToken, mfaSecret);
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("create a platform admin via POST /platform/admins", async () => {
    const email = `http-create-${Date.now()}@example.com`;
    const res = await request(app.getHttpServer())
      .post("/platform/admins")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        fullName: "HTTP Create Test Admin",
        email,
        initialPassword: "SecurePassword123!",
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.fullName).toBe("HTTP Create Test Admin");
    expect(res.body.email).toBe(email);
    expect(res.body.status).toBe("active");
  });

  it("rejects a duplicate email with 409", async () => {
    const email = `http-dup-${Date.now()}@example.com`;
    await request(app.getHttpServer())
      .post("/platform/admins")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        fullName: "First Admin",
        email,
        initialPassword: "SecurePassword123!",
      });

    const res = await request(app.getHttpServer())
      .post("/platform/admins")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        fullName: "Second Admin",
        email,
        initialPassword: "AnotherPassword123!",
      });

    expect(res.status).toBe(409);
  });

  it("rejects a too-short initialPassword with 400", async () => {
    const res = await request(app.getHttpServer())
      .post("/platform/admins")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        fullName: "Short Password Admin",
        email: `http-short-pw-${Date.now()}@example.com`,
        initialPassword: "short",
      });

    expect(res.status).toBe(400);
  });

  it("list platform admins via GET /platform/admins", async () => {
    const email = `http-list-${Date.now()}@example.com`;
    await request(app.getHttpServer())
      .post("/platform/admins")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        fullName: "List Test Admin",
        email,
        initialPassword: "SecurePassword123!",
      });

    const res = await request(app.getHttpServer())
      .get("/platform/admins")
      .set("Authorization", `Bearer ${platformAdminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((a: { email: string }) => a.email === email)).toBe(true);
  });

  it("lock/unlock a platform admin via PATCH /platform/admins/:id", async () => {
    const createRes = await request(app.getHttpServer())
      .post("/platform/admins")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        fullName: "Status Test Admin",
        email: `http-status-${Date.now()}@example.com`,
        initialPassword: "SecurePassword123!",
      });

    const adminId = createRes.body.id;

    const lockedRes = await request(app.getHttpServer())
      .patch(`/platform/admins/${adminId}`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ status: "locked" });

    expect(lockedRes.status).toBe(200);
    expect(lockedRes.body.status).toBe("locked");

    const unlockedRes = await request(app.getHttpServer())
      .patch(`/platform/admins/${adminId}`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ status: "active" });

    expect(unlockedRes.status).toBe(200);
    expect(unlockedRes.body.status).toBe("active");
  });

  it("returns 404 when patching a non-existent admin id", async () => {
    const res = await request(app.getHttpServer())
      .patch("/platform/admins/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ status: "locked" });

    expect(res.status).toBe(404);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await request(app.getHttpServer()).get("/platform/admins");
    expect(res.status).toBe(401);
  });

  it("rejects a non-Platform-Admin session with 401", async () => {
    const stamp = Date.now();
    const tenantUserId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const account = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
        [`platform-admins-e2e-tenant-${stamp}@example.com`]
      );
      return account.rows[0].id as string;
    });
    const tenantToken = signSession({
      sub: tenantUserId,
      is_platform_admin: false,
      company_id: null,
    });

    // PlatformAdminGuard throws UnauthorizedException (401), not 403,
    // for a valid-but-non-admin token — see platform-admin.guard.ts.
    const res = await request(app.getHttpServer())
      .get("/platform/admins")
      .set("Authorization", `Bearer ${tenantToken}`);

    expect(res.status).toBe(401);
  });
});
