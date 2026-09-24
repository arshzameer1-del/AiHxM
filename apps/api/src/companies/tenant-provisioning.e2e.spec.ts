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
  sub: "tenant-provisioning-e2e-fixtures",
};

function signSession(payload: { sub: string; is_platform_admin: boolean; company_id: string | null }): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: "10m" });
}

// A 1x1 transparent PNG, just enough bytes to be a real "image/png" upload.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

/**
 * TM-006/007/008/009/010/014/015 — Create Tenant wizard support
 * endpoints, Tenant Profile edit, and Branding uploads. Proves: real
 * uniqueness checks (not a stub returning `true` always), full wizard
 * fields actually persist to `companies`, a profile edit's audit entry
 * carries a genuine before/after diff, and — the specific regression
 * this feature's own doc comment warns about — uploading a logo and then
 * separately patching a brand color does NOT wipe the logo (proves the
 * raw-vs-derived branding jsonb merge bug is actually fixed).
 */
describe("Tenant provisioning: wizard support, profile, branding (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let platformAdminToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);

    const platformAdminId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const account = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
        [`tenant-provisioning-e2e-admin-${Date.now()}@example.com`]
      );
      return account.rows[0].id as string;
    });
    platformAdminToken = signSession({ sub: platformAdminId, is_platform_admin: true, company_id: null });
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("lists package tiers with their real included modules, no fabricated pricing", async () => {
    const res = await request(app.getHttpServer())
      .get("/platform/package-tiers")
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(4);
    const starter = res.body.find((t: { key: string }) => t.key === "starter");
    expect(starter).toBeDefined();
    expect(Array.isArray(starter.includedModuleKeys)).toBe(true);
    expect(starter).not.toHaveProperty("price");
  });

  it("lists the module catalog with real dependency links, no per-tenant enabled flag", async () => {
    const res = await request(app.getHttpServer())
      .get("/platform/module-catalog")
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const entry of res.body) {
      expect(entry).not.toHaveProperty("enabled");
      expect(entry).toHaveProperty("key");
      expect(entry).toHaveProperty("dependsOn");
    }
  });

  it("checks slug/domain availability for real, both ways", async () => {
    const uniqueSlug = `avail-check-${Date.now()}`;
    const available = await request(app.getHttpServer())
      .post("/platform/tenant-availability")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ slug: uniqueSlug });
    expect(available.body.slugAvailable).toBe(true);

    await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ name: "Availability Co", slug: uniqueSlug });

    const nowTaken = await request(app.getHttpServer())
      .post("/platform/tenant-availability")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ slug: uniqueSlug });
    expect(nowTaken.body.slugAvailable).toBe(false);
  });

  /**
   * A company's slug is now also a path segment in the frontend's own
   * router (aihxm.com/<slug>/login) — CompaniesService's RESERVED_SLUGS
   * blocklist is what stops a company from ever claiming a slug that
   * collides with a real top-level route like /login or /app. Checked at
   * both the availability-check endpoint (fast UI feedback) and creation
   * itself (the real enforcement).
   */
  it("reports a reserved slug as unavailable and refuses to create it, even though it's not taken by another company", async () => {
    const availability = await request(app.getHttpServer())
      .post("/platform/tenant-availability")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ slug: "login" });
    expect(availability.body.slugAvailable).toBe(false);

    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ name: "Reserved Slug Co", slug: "login" });
    expect(createRes.status).toBe(409);
  });

  it("reports a test invitation as not sent when SMTP isn't configured, never fakes success", async () => {
    const res = await request(app.getHttpServer())
      .post("/platform/test-invitations")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ fullName: "Test Admin", email: "test-admin@example.com", companyName: "Preview Co" });
    expect(res.status).toBe(201);
    expect(res.body.sent).toBe(false);
    expect(res.body.reason).toBeTruthy();
  });

  let companyId: string;

  it("creates a company with full wizard fields persisted", async () => {
    const slug = `full-wizard-${Date.now()}`;
    const res = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name: "Zaman Textiles Ltd.",
        slug,
        legalName: "Zaman Textiles (Private) Limited",
        registrationNumber: "REG-00123",
        industry: "Manufacturing",
        country: "PK",
        timezone: "Asia/Karachi",
        currency: "PKR",
        fiscalYearStartMonth: 7,
        customDomain: `${slug}.example.com`,
        seatsPurchased: 25,
      });
    expect(res.status).toBe(201);
    const company = res.body.company;
    expect(company.legalName).toBe("Zaman Textiles (Private) Limited");
    expect(company.registrationNumber).toBe("REG-00123");
    expect(company.industry).toBe("Manufacturing");
    expect(company.customDomain).toBe(`${slug}.example.com`);
    expect(company.seatsPurchased).toBe(25);
    companyId = company.id;
  });

  it("rejects creation with a duplicate custom domain", async () => {
    const existing = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("SELECT custom_domain FROM companies WHERE id = $1", [companyId])
    );
    const res = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ name: "Domain Clash Co", slug: `domain-clash-${Date.now()}`, customDomain: existing.rows[0].custom_domain });
    expect(res.status).toBe(409);
  });

  it("updates the tenant profile and records a real before/after audit diff", async () => {
    const res = await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}/profile`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ industry: "Textiles & Apparel", registrationNumber: "REG-00999" });
    expect(res.status).toBe(200);
    expect(res.body.industry).toBe("Textiles & Apparel");
    expect(res.body.registrationNumber).toBe("REG-00999");

    const auditRow = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query(
        "SELECT metadata FROM audit_log WHERE company_id = $1 AND action = 'company.profile.updated' ORDER BY created_at DESC LIMIT 1",
        [companyId]
      )
    );
    expect(auditRow.rowCount).toBe(1);
    expect(auditRow.rows[0].metadata.before.industry).toBe("Manufacturing");
    expect(auditRow.rows[0].metadata.after.industry).toBe("Textiles & Apparel");
  });

  it("uploads a real logo, exposes only a hasLogo flag, and serves the bytes back unchanged", async () => {
    const uploadRes = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/branding/logo`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .attach("file", TINY_PNG, { filename: "logo.png", contentType: "image/png" });
    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.branding.hasLogo).toBe(true);
    expect(uploadRes.body.branding.hasFavicon).toBe(false);
    expect(uploadRes.body.branding).not.toHaveProperty("logoStoragePath");

    const downloadRes = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/branding/logo`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .responseType("blob");
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers["content-type"]).toBe("image/png");
    expect(Buffer.compare(Buffer.from(downloadRes.body), TINY_PNG)).toBe(0);
  });

  it("rejects a non-image upload", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/branding/favicon`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .attach("file", Buffer.from("not an image"), { filename: "notes.txt", contentType: "text/plain" });
    expect(res.status).toBe(400);
  });

  it("setting a brand color does NOT wipe the previously uploaded logo", async () => {
    const res = await request(app.getHttpServer())
      .patch(`/platform/companies/${companyId}/config`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ branding: { primaryColor: "#1E40AF" } });
    expect(res.status).toBe(200);
    expect(res.body.branding.primaryColor).toBe("#1E40AF");
    expect(res.body.branding.hasLogo).toBe(true);

    const stillDownloads = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/branding/logo`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .responseType("blob");
    expect(stillDownloads.status).toBe(200);
  });
});
