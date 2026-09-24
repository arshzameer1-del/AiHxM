import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

/**
 * HTTP-level coverage for the platform's own logo (migration
 * 0046_platform_branding.sql). Two things make this worth an e2e spec
 * rather than a unit test against the service alone: (1) the public GET
 * routes have NO guard at all — see public-platform-branding.controller.ts's
 * doc comment — so a unit test wouldn't catch a guard accidentally left on
 * or a route wired wrong; (2) the write routes are guarded by
 * PlatformAdminGuard, which is only exercised at the HTTP layer (JWT ->
 * guard -> claims), matching platform-admins.e2e.spec.ts's pattern for
 * minting a session.
 *
 * platform_branding is a singleton row (CHECK (id) — see the migration), so
 * every test in this file shares the SAME row. No other spec file touches
 * this table, so there's no cross-file race, but tests here must run in
 * the sequence written (jest runs tests within one file sequentially) and
 * must leave the row in a known state (`removeLogo` in the last test)
 * rather than assuming a specific starting state.
 */
const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "platform-branding-e2e-fixtures",
};

function signSession(payload: { sub: string; is_platform_admin: boolean; company_id: string | null }): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: "10m" });
}

describe("Platform Branding HTTP surface (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let platformAdminToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);

    const platformAdminId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const account = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
        [`platform-branding-e2e-caller-${Date.now()}@example.com`]
      );
      return account.rows[0].id as string;
    });

    platformAdminToken = signSession({ sub: platformAdminId, is_platform_admin: true, company_id: null });

    // Make sure we start from a known "no logo" state regardless of
    // whatever earlier local/dev usage left in this singleton row.
    await request(app.getHttpServer())
      .delete("/platform/branding/logo")
      .set("Authorization", `Bearer ${platformAdminToken}`);
  });

  afterAll(async () => {
    // Leave the row clean for the next full test run.
    await request(app.getHttpServer())
      .delete("/platform/branding/logo")
      .set("Authorization", `Bearer ${platformAdminToken}`);
    await pool.end();
    await app.close();
  });

  it("GET /public/platform-branding reports hasLogo: false before any upload — no session required", async () => {
    const res = await request(app.getHttpServer()).get("/public/platform-branding").expect(200);

    expect(res.body).toEqual({ hasLogo: false, updatedAt: expect.any(String) });
  });

  it("GET /public/platform-branding/logo/asset 404s when nothing has been uploaded", async () => {
    await request(app.getHttpServer()).get("/public/platform-branding/logo/asset").expect(404);
  });

  it("rejects an unauthenticated upload with 401", async () => {
    const res = await request(app.getHttpServer())
      .post("/platform/branding/logo")
      .attach("file", Buffer.from("not a real png"), { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(401);
  });

  it("rejects an upload from a non-Platform-Admin session with 401", async () => {
    const stamp = Date.now();
    const tenantUserId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const account = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
        [`platform-branding-e2e-tenant-${stamp}@example.com`]
      );
      return account.rows[0].id as string;
    });
    const tenantToken = signSession({ sub: tenantUserId, is_platform_admin: false, company_id: null });

    const res = await request(app.getHttpServer())
      .post("/platform/branding/logo")
      .set("Authorization", `Bearer ${tenantToken}`)
      .attach("file", Buffer.from("not a real png"), { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(401);
  });

  it("rejects a non-image upload with 400", async () => {
    const res = await request(app.getHttpServer())
      .post("/platform/branding/logo")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .attach("file", Buffer.from("just some text"), { filename: "logo.txt", contentType: "text/plain" });

    expect(res.status).toBe(400);
  });

  it("uploads a logo as a Platform Admin, then serves it back from the public asset route", async () => {
    // A minimal but valid 1x1 transparent PNG.
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );

    const uploadRes = await request(app.getHttpServer())
      .post("/platform/branding/logo")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .attach("file", pngBytes, { filename: "logo.png", contentType: "image/png" });

    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.hasLogo).toBe(true);

    const publicRes = await request(app.getHttpServer()).get("/public/platform-branding").expect(200);
    expect(publicRes.body.hasLogo).toBe(true);

    const assetRes = await request(app.getHttpServer()).get("/public/platform-branding/logo/asset").expect(200);
    expect(assetRes.headers["content-type"]).toBe("image/png");
    expect(assetRes.headers["cache-control"]).toBe("public, max-age=3600");
    expect(Buffer.compare(assetRes.body, pngBytes)).toBe(0);
  });

  it("removes the logo via DELETE, resetting hasLogo to false", async () => {
    const removeRes = await request(app.getHttpServer())
      .delete("/platform/branding/logo")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .expect(200);

    expect(removeRes.body.hasLogo).toBe(false);

    await request(app.getHttpServer()).get("/public/platform-branding/logo/asset").expect(404);
  });

  it("rejects an unauthenticated remove with 401", async () => {
    const res = await request(app.getHttpServer()).delete("/platform/branding/logo");
    expect(res.status).toBe(401);
  });
});
