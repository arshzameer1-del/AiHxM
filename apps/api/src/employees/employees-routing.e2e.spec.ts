import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "employees-routing-e2e-fixtures" };

/**
 * Route order in the employees module. `GET /employees/:id` takes any single path segment, so a sub-resource such as
 * `GET /employees/contacts?employeeId=...` was answered by it (as if "contacts" were an employee id) and every employee
 * screen that lists contacts, addresses, education, family, assets, payment accounts... got 400 "malformed id" on the
 * live site. Each of these literal paths must reach its own controller.
 */
describe("Employees module routing (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let token: string;
  let employeeId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug, status) VALUES ($1, $2, 'active') RETURNING id", [
        `Routing E2E Co ${stamp}`,
        `routing-e2e-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [id]);
      return id;
    });
    const userId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const u = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`routing-hr-${stamp}@example.com`]);
      const role = await client.query("SELECT id FROM roles WHERE key = 'hr_admin'");
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [
        u.rows[0].id,
        companyId,
        role.rows[0].id,
      ]);
      return u.rows[0].id as string;
    });
    token = jwt.sign({ sub: userId, is_platform_admin: false, company_id: companyId }, process.env.JWT_SECRET as string, { expiresIn: "10m" });

    const created = await request(app.getHttpServer())
      .post("/employees")
      .set("Authorization", `Bearer ${token}`)
      .send({ firstName: "Route", lastName: "Check", email: `route-${stamp}@example.com`, employmentType: "permanent" });
    employeeId = created.body.id;
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  const SUB_RESOURCES = [
    "contacts",
    "addresses",
    "education",
    "family-members",
    "qualifications",
    "assets",
    "important-dates",
    "payment-accounts",
    "cost-allocations",
  ];

  it.each(SUB_RESOURCES)("GET /employees/%s?employeeId=... reaches its own list, not GET /employees/:id", async (name) => {
    const res = await request(app.getHttpServer()).get(`/employees/${name}`).query({ employeeId }).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it.each(["analytics/summary", "loans", "additional-payments", "offcycle-payments", `compensation/${"EMPLOYEE"}`])(
    "GET /employees/%s is not mistaken for an employee id",
    async (path) => {
      const url = `/employees/${path.replace("EMPLOYEE", employeeId)}`;
      const res = await request(app.getHttpServer()).get(url).query({ employeeId }).set("Authorization", `Bearer ${token}`);
      // These may need other modules or filters; what must never happen is the employee-id route answering for them.
      expect(JSON.stringify(res.body ?? {})).not.toMatch(/malformed id/);
    }
  );

  it("still serves a real employee id", async () => {
    const res = await request(app.getHttpServer()).get(`/employees/${employeeId}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(employeeId);
  });

  it("a made-up id is not found or rejected, never a server error", async () => {
    const res = await request(app.getHttpServer()).get("/employees/not-a-real-id").set("Authorization", `Bearer ${token}`);
    expect([400, 404]).toContain(res.status);
  });
});
