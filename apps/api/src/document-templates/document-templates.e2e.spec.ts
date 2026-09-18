import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

/**
 * Document Templates sits behind SessionGuard only (any real session, same
 * as DummyController) — DocumentTemplatesService itself decides what a
 * caller may do: `createTemplate` requires `document_template.manage.all`
 * (granted to the `rbac_demo_full_access` seed role by migration 0009),
 * while `list`/`render` require only a `company_id` claim, with no further
 * RBAC check. There is no self-registration endpoint in this codebase, so
 * every fixture user/role assignment below is inserted directly via SQL,
 * the same way dummy.e2e.spec.ts and employees.service.spec.ts do it.
 */
const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "document-templates-e2e-fixtures",
};

function signSession(payload: { sub: string; is_platform_admin: boolean; company_id: string | null }): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: "10m" });
}

describe("Document Templates HTTP surface (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;

  let companyId: string;
  let adminUserId: string;
  let outsiderUserId: string;
  let adminToken: string;
  let outsiderToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Document Templates E2E Co ${stamp}`,
        `doc-templates-e2e-${stamp}`,
      ]);
      companyId = company.rows[0].id;

      async function makeUser(email: string): Promise<string> {
        const account = await client.query(
          "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
          [email]
        );
        return account.rows[0].id;
      }
      adminUserId = await makeUser(`dt-e2e-admin-${stamp}@example.com`);
      outsiderUserId = await makeUser(`dt-e2e-outsider-${stamp}@example.com`);

      const role = await client.query("SELECT id FROM roles WHERE key = 'rbac_demo_full_access'");
      await client.query(
        "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
        [adminUserId, companyId, role.rows[0].id]
      );
      // outsiderUserId deliberately gets no role assignment at all.
    });

    adminToken = signSession({ sub: adminUserId, is_platform_admin: false, company_id: companyId });
    outsiderToken = signSession({ sub: outsiderUserId, is_platform_admin: false, company_id: companyId });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      await client.query("DELETE FROM companies WHERE id = $1", [companyId]);
      await client.query("DELETE FROM user_accounts WHERE id = ANY($1::uuid[])", [[adminUserId, outsiderUserId]]);
    });
    await pool.end();
    await app.close();
  });

  it("rejects a request with no bearer token", async () => {
    await request(app.getHttpServer()).get("/document-templates").expect(401);
  });

  it("create document template via POST /document-templates", async () => {
    const res = await request(app.getHttpServer())
      .post("/document-templates")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        key: "offer-letter",
        name: "Offer Letter",
        objectKey: "employee",
        templateBody: "Dear {{firstName}}, welcome to {{companyName}}.",
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.companyId).toBe(companyId);
    expect(res.body.key).toBe("offer-letter");
    expect(res.body.name).toBe("Offer Letter");
    expect(res.body.objectKey).toBe("employee");
    expect(res.body.templateBody).toBe("Dear {{firstName}}, welcome to {{companyName}}.");
  });

  it("rejects create for a caller without document_template.manage.all", async () => {
    const res = await request(app.getHttpServer())
      .post("/document-templates")
      .set("Authorization", `Bearer ${outsiderToken}`)
      .send({
        key: "payslip",
        name: "Payslip",
        objectKey: "payroll_run",
        templateBody: "Net pay: {{netPay}}",
      });

    expect(res.status).toBe(403);
  });

  it("rejects create with missing required fields", async () => {
    const res = await request(app.getHttpServer())
      .post("/document-templates")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ key: "incomplete" });

    expect(res.status).toBe(400);
  });

  it("lists document templates via GET /document-templates", async () => {
    const res = await request(app.getHttpServer())
      .get("/document-templates")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const found = res.body.find((t: { key: string }) => t.key === "offer-letter");
    expect(found).toBeDefined();
    expect(found.companyId).toBe(companyId);
  });

  it("GET /document-templates returns an empty list for a Platform Admin session (no company_id)", async () => {
    const platformAdminToken = signSession({ sub: "platform-admin-probe", is_platform_admin: true, company_id: null });
    const res = await request(app.getHttpServer())
      .get("/document-templates")
      .set("Authorization", `Bearer ${platformAdminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("renders a template via POST /document-templates/render, substituting {{field}} placeholders", async () => {
    const res = await request(app.getHttpServer())
      .post("/document-templates/render")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        templateKey: "offer-letter",
        record: { firstName: "Ayesha", companyName: "Acme Pakistan" },
      });

    expect(res.status).toBe(201);
    expect(res.body.templateKey).toBe("offer-letter");
    expect(res.body.content).toBe("Dear Ayesha, welcome to Acme Pakistan.");
  });

  it("blanks out a missing field instead of leaving the placeholder in place", async () => {
    const res = await request(app.getHttpServer())
      .post("/document-templates/render")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        templateKey: "offer-letter",
        record: { firstName: "Bilal" },
      });

    expect(res.status).toBe(201);
    expect(res.body.content).toBe("Dear Bilal, welcome to .");
  });

  it("404s render for a template key that doesn't exist in this tenant", async () => {
    const res = await request(app.getHttpServer())
      .post("/document-templates/render")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ templateKey: "does-not-exist", record: {} });

    expect(res.status).toBe(404);
  });

  it("rejects render without authorization", async () => {
    const res = await request(app.getHttpServer())
      .post("/document-templates/render")
      .send({ templateKey: "offer-letter", record: {} });

    expect(res.status).toBe(401);
  });
});
