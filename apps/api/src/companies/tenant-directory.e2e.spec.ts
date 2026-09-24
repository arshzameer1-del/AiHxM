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
  sub: "tenant-directory-e2e-fixtures",
};

/**
 * TM-002/TM-003 (Tenant Directory search + filters) and TM-003's "Save as
 * reusable view". Proves the query params actually narrow the result set
 * against real rows, not just that they're accepted, and that saved views
 * round-trip through the real `platform_saved_views` table.
 */
describe("Tenant Directory: search, filters, saved views (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let platformAdminToken: string;
  let karachiAdminEmail: string;
  const suffix = `${Date.now()}`;

  async function createPlatformAdmin(email: string, password: string): Promise<void> {
    const passwordHash = await bcrypt.hash(password, 10);
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, $2) RETURNING id",
        [email, passwordHash]
      );
      await client.query(
        "INSERT INTO platform_admins (user_account_id, full_name, email, status) VALUES ($1, $2, $3, 'active')",
        [result.rows[0].id, "Directory E2E Platform Admin", email]
      );
    });
  }

  async function loginToSessionToken(email: string, password: string): Promise<string> {
    const loginRes = await request(app.getHttpServer()).post("/auth/login").send({ email, password });
    if (loginRes.body.status !== "mfa_setup_required") {
      throw new Error(`Expected mfa_setup_required, got ${JSON.stringify(loginRes.body)}`);
    }
    const code = await generateTotp({ secret: loginRes.body.secretForManualEntry });
    const confirmRes = await request(app.getHttpServer())
      .post("/auth/mfa/enroll/confirm")
      .send({ mfaTicket: loginRes.body.mfaTicket, code });
    return confirmRes.body.token;
  }

  async function createCompany(name: string, packageTier?: string) {
    const slugSafe = name.toLowerCase().replace(/\s+/g, "-");
    const adminEmail = `${slugSafe}-admin@example.com`;
    const res = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name,
        slug: slugSafe,
        packageTier,
        initialAdmin: { fullName: "Admin", email: adminEmail },
      });
    if (res.status !== 201) {
      throw new Error(`Create company failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return { companyId: res.body.company.id as string, adminEmail };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);

    const email = `directory-e2e-admin-${suffix}@example.com`;
    const password = "SuperSecret123!";
    await createPlatformAdmin(email, password);
    platformAdminToken = await loginToSessionToken(email, password);

    await createCompany(`Zaman Textiles ${suffix}`, "growth");
    const karachi = await createCompany(`Karachi Foods ${suffix}`, "enterprise");
    karachiAdminEmail = karachi.adminEmail;
    await createCompany(`Lahore Logistics ${suffix}`, "starter");
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("search narrows by company name", async () => {
    const res = await request(app.getHttpServer())
      .get(`/platform/companies?search=${encodeURIComponent(`Zaman Textiles ${suffix}`)}`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe(`Zaman Textiles ${suffix}`);
  });

  it("search matches by admin email too", async () => {
    const res = await request(app.getHttpServer())
      .get(`/platform/companies?search=${encodeURIComponent(karachiAdminEmail)}`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe(`Karachi Foods ${suffix}`);
  });

  it("filters by packageTier (comma-separated) and status", async () => {
    const res = await request(app.getHttpServer())
      .get(`/platform/companies?packageTier=growth,enterprise&search=${encodeURIComponent(suffix)}`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(200);
    const names = res.body.map((c: { name: string }) => c.name).sort();
    expect(names).toEqual([`Karachi Foods ${suffix}`, `Zaman Textiles ${suffix}`].sort());

    const activeOnly = await request(app.getHttpServer())
      .get(`/platform/companies?status=suspended&search=${encodeURIComponent(suffix)}`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(activeOnly.status).toBe(200);
    expect(activeOnly.body.length).toBe(0);
  });

  it("saves, lists, and deletes a reusable view", async () => {
    const createRes = await request(app.getHttpServer())
      .post("/platform/saved-views")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ name: `Enterprise tenants ${suffix}`, filters: { packageTier: ["enterprise"] } });
    expect(createRes.status).toBe(201);
    expect(createRes.body.filters).toEqual({ packageTier: ["enterprise"] });
    expect(typeof createRes.body.createdBy).toBe("string");
    expect(createRes.body.createdBy.length).toBeGreaterThan(0);

    const listRes = await request(app.getHttpServer())
      .get("/platform/saved-views")
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.some((v: { id: string }) => v.id === createRes.body.id)).toBe(true);

    const deleteRes = await request(app.getHttpServer())
      .delete(`/platform/saved-views/${createRes.body.id}`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(deleteRes.status).toBe(200);

    const afterDelete = await request(app.getHttpServer())
      .get("/platform/saved-views")
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(afterDelete.body.some((v: { id: string }) => v.id === createRes.body.id)).toBe(false);
  });
});
