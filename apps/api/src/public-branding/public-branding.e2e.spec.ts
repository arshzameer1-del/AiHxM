import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "public-branding-e2e-fixtures",
};

/**
 * HTTP-level coverage for the one part of this feature that's easy to get
 * wrong silently: this controller has NO guard (see its own doc comment),
 * so the only thing standing between "logged-out visitor" and "reads
 * another tenant's data" is migration 0045's RLS policy change and this
 * service's own status filter. A unit test against the service alone
 * wouldn't catch a guard accidentally left on, or a route wired wrong.
 */
describe("Public tenant branding HTTP surface (e2e) — no auth, per-company login pages", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;

  async function createCompany(overrides?: { status?: string; branding?: Record<string, unknown> }) {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const slug = `pub-branding-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const companyResult = await client.query(
        "INSERT INTO companies (name, slug, status, package_tier) VALUES ($1, $2, $3, 'starter') RETURNING id",
        [`Public Branding E2E Co ${Date.now()}`, slug, overrides?.status ?? "active"]
      );
      const companyId = companyResult.rows[0].id as string;
      await client.query("INSERT INTO company_config (company_id, branding) VALUES ($1, $2::jsonb)", [
        companyId,
        JSON.stringify(overrides?.branding ?? {}),
      ]);
      return slug;
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("returns 404 for a slug that doesn't exist — no session, no leak", async () => {
    await request(app.getHttpServer()).get("/public/tenants/no-such-tenant-at-all/branding").expect(404);
  });

  it("returns branding for a real, active company with no session at all", async () => {
    const slug = await createCompany({ branding: { primaryColor: "#112233" } });

    const res = await request(app.getHttpServer()).get(`/public/tenants/${slug}/branding`).expect(200);

    expect(res.body).toEqual({
      slug,
      companyName: expect.any(String),
      primaryColor: "#112233",
      hasLogo: false,
      hasLoginBackground: false,
      logoAlignment: "left",
      logoHeightPx: 32,
      loginBackgroundPositionX: "center",
      loginBackgroundPositionY: "center",
      loginCardWidthPx: 384,
      loginCardPosition: "center",
      loginCardBackgroundColor: "#FFFFFF",
      loginCardOpacity: 100,
    });
  });

  it("matches the slug case-insensitively", async () => {
    const slug = await createCompany();

    await request(app.getHttpServer())
      .get(`/public/tenants/${slug.toUpperCase()}/branding`)
      .expect(200);
  });

  it("hides branding for an archived company", async () => {
    const slug = await createCompany({ status: "archived" });

    await request(app.getHttpServer()).get(`/public/tenants/${slug}/branding`).expect(404);
  });

  it("404s the asset route for a slot nobody uploaded, rather than serving an empty file", async () => {
    const slug = await createCompany();

    await request(app.getHttpServer()).get(`/public/tenants/${slug}/branding/logo/asset`).expect(404);
  });

  it("rejects an unknown asset slot as a bad request, not a 500", async () => {
    const slug = await createCompany();

    await request(app.getHttpServer()).get(`/public/tenants/${slug}/branding/favicon/asset`).expect(400);
  });
});
