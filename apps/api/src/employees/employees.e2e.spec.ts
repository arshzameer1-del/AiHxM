import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

/**
 * Employee Core's first real HTTP-level e2e test — `employees.service.spec.ts`
 * covers the service directly, but nothing before this drove the actual
 * controller/guards/ValidationPipe stack the way a real client (Task #48's
 * new tenant-portal UI, `apps/web/src/portal/employees/`) does. This is
 * exactly the sequence that UI performs: HR Admin creates an employee,
 * lists/reads it back, edits it, grants it a login (Decision #12/#13's
 * `LoginSection`), and reads its job history — asserting the response
 * shapes those components actually destructure, not just that each call
 * individually 2xxs.
 */
const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "employees-e2e-fixtures" };

function signSession(payload: { sub: string; is_platform_admin: boolean; company_id: string | null }): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: "10m" });
}

describe("Employees HTTP surface (e2e) — the tenant-portal UI's own contract (Task #48)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;

  let companyId: string;
  let hrAdminToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);

    const stamp = Date.now();
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Employees E2E Co ${stamp}`,
        `employees-e2e-${stamp}`,
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

    const hrAdminUserId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const account = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        `employees-e2e-hr-${stamp}@example.com`,
      ]);
      const role = await client.query("SELECT id FROM roles WHERE key = 'hr_admin'");
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [
        account.rows[0].id,
        companyId,
        role.rows[0].id,
      ]);
      return account.rows[0].id as string;
    });
    hrAdminToken = signSession({ sub: hrAdminUserId, is_platform_admin: false, company_id: companyId });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
    await app.close();
  });

  it("create -> list -> get -> update -> create login -> job history, exactly as the portal UI calls them", async () => {
    const email = `employees-e2e-hamid-${Date.now()}@example.com`;

    // EmployeeCreatePage's submit
    const created = await request(app.getHttpServer())
      .post("/employees")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ firstName: "Hamid", lastName: "Raza", email, department: "Engineering", employmentType: "permanent" });
    expect(created.status).toBe(201);
    expect(created.body.employeeNumber).toMatch(/^EMP-/);
    expect(created.body.employmentStatus).toBe("active");
    const employeeId = created.body.id as string;

    // EmployeeListPage's load
    const list = await request(app.getHttpServer()).get("/employees").set("Authorization", `Bearer ${hrAdminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.some((e: { id: string }) => e.id === employeeId)).toBe(true);

    // EmployeeDetailPage's load
    const got = await request(app.getHttpServer())
      .get(`/employees/${employeeId}`)
      .set("Authorization", `Bearer ${hrAdminToken}`);
    expect(got.status).toBe(200);
    expect(got.body.firstName).toBe("Hamid");
    // hr_admin holds employee.view.all's field rules — sensitive fields
    // are present (even if null), not omitted, for this caller.
    expect(got.body).toHaveProperty("cnic");

    // EditForm's submit
    const updated = await request(app.getHttpServer())
      .patch(`/employees/${employeeId}`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ designation: "Senior Engineer" });
    expect(updated.status).toBe(200);
    expect(updated.body.designation).toBe("Senior Engineer");

    // LoginSection's submit
    const login = await request(app.getHttpServer())
      .post(`/employees/${employeeId}/account`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ initialPassword: "correct horse battery staple", roleKeys: ["employee_self_service"] });
    expect(login.status).toBe(201);
    expect(login.body.rolesGranted).toEqual(["employee_self_service"]);
    expect(login.body.employee.userAccountId).toBeTruthy();

    // A second attempt must 409 — LoginSection reads this to keep
    // showing "already has a login" rather than the create form.
    const secondLogin = await request(app.getHttpServer())
      .post(`/employees/${employeeId}/account`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ initialPassword: "another password entirely", roleKeys: ["employee_self_service"] });
    expect(secondLogin.status).toBe(409);

    // EmployeeDetailPage's job-history panel — the auto-logged 'hire'
    // event from create(), unprompted.
    const jobHistory = await request(app.getHttpServer())
      .get(`/employees/${employeeId}/job-history`)
      .set("Authorization", `Bearer ${hrAdminToken}`);
    expect(jobHistory.status).toBe(200);
    expect(jobHistory.body.some((e: { eventType: string }) => e.eventType === "hire")).toBe(true);
  });

  it("a manager without employee.view.all is refused GET on someone outside their team (404, not a raw 500)", async () => {
    const managerUserId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const account = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        `employees-e2e-mgr-${Date.now()}@example.com`,
      ]);
      const role = await client.query("SELECT id FROM roles WHERE key = 'line_manager'");
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [
        account.rows[0].id,
        companyId,
        role.rows[0].id,
      ]);
      return account.rows[0].id as string;
    });
    const managerToken = signSession({ sub: managerUserId, is_platform_admin: false, company_id: companyId });

    const anyEmployee = await request(app.getHttpServer())
      .get("/employees")
      .set("Authorization", `Bearer ${hrAdminToken}`);
    const someoneNotOnThisManagersTeam = anyEmployee.body[0].id as string;

    const res = await request(app.getHttpServer())
      .get(`/employees/${someoneNotOnThisManagersTeam}`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(404);

    // And EmployeeListPage's own load for this same manager: an empty
    // list (no direct reports yet), not an error.
    const managerList = await request(app.getHttpServer()).get("/employees").set("Authorization", `Bearer ${managerToken}`);
    expect(managerList.status).toBe(200);
    expect(managerList.body).toEqual([]);
  });
});
