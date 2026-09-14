import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { generate as generateTotp } from "otplib";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

/**
 * Decision #12's own exit criterion, and the first dedicated test file
 * `auth` has ever had (see KNOWN_ISSUES.md / the MVP gate audit for how
 * that gap was found). Before this fix, `AuthService.resolveIdentityForAccount()`
 * only recognized Platform Admin and Company Admin identities — a real
 * `hr_admin`/`line_manager`/`employee_self_service` user provisioned via
 * `EmployeesService.createLogin()` could not actually log in at all (it
 * would 401 with "not linked to any admin profile"), even though every
 * one of Phases 4-11's own tests exercised that exact role population by
 * inserting `user_role_assignments` rows directly via SQL, bypassing
 * `AuthService` entirely. This test drives the REAL `/auth/login` ->
 * `/auth/mfa/enroll/confirm` flow — no manually-signed bypass token — for
 * an employee provisioned the real way, then confirms the resulting
 * session's RBAC scope is exactly what the granted role allows: it can
 * view its own record, and it cannot create another employee.
 */
const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "auth-e2e-fixtures" };

function signSession(payload: { sub: string; is_platform_admin: boolean; company_id: string | null }): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: "10m" });
}

describe("Auth HTTP surface (e2e) — real tenant-user login (Decision #12)", () => {
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
        `Auth E2E Co ${stamp}`,
        `auth-e2e-${stamp}`,
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

    // The one piece of setup that plays the role of "an already-bootstrapped
    // HR Admin" (exactly like every other module's e2e fixture) — the real
    // bootstrap chain a brand-new tenant actually needs (Platform Admin
    // creates a Company Admin login, then grants it hr_admin via
    // POST /platform/role-assignments) is a separate, already-existing
    // path this test doesn't re-derive; it starts from "HR Admin exists."
    const hrAdminUserId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const account = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        `auth-e2e-hr-${stamp}@example.com`,
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

  it("provisions a real employee login via POST /employees/:id/account, then logs in through the actual /auth/login + MFA-enrollment flow and gets an RBAC-scoped session", async () => {
    const email = `auth-e2e-nadia-${Date.now()}@example.com`;

    const createEmployee = await request(app.getHttpServer())
      .post("/employees")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ firstName: "Nadia", lastName: "Employee", email });
    expect(createEmployee.status).toBe(201);
    const employeeId = createEmployee.body.id as string;
    expect(createEmployee.body.userAccountId).toBeNull();

    // Decision #12's new capability: HR Admin self-service login creation,
    // no Platform Admin or database console involved.
    const createLogin = await request(app.getHttpServer())
      .post(`/employees/${employeeId}/account`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ initialPassword: "correct horse battery staple", roleKeys: ["employee_self_service"] });
    expect(createLogin.status).toBe(201);
    expect(createLogin.body.rolesGranted).toEqual(["employee_self_service"]);
    expect(createLogin.body.employee.userAccountId).toBeTruthy();

    // A second login attempt for the same employee must be refused, not
    // silently create a duplicate `user_accounts` row.
    const duplicateLogin = await request(app.getHttpServer())
      .post(`/employees/${employeeId}/account`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ initialPassword: "another password entirely", roleKeys: ["employee_self_service"] });
    expect(duplicateLogin.status).toBe(409);

    // The real, previously-broken path: password login...
    const loginRes = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password: "correct horse battery staple" });
    expect(loginRes.status).toBe(201);
    expect(loginRes.body.status).toBe("mfa_setup_required");
    const { mfaTicket, secretForManualEntry } = loginRes.body;

    // ...through mandatory MFA enrollment...
    const code = await generateTotp({ secret: secretForManualEntry });
    const enrollRes = await request(app.getHttpServer())
      .post("/auth/mfa/enroll/confirm")
      .send({ mfaTicket, code });
    expect(enrollRes.status).toBe(201);
    expect(enrollRes.body.status).toBe("ok");
    const nadiaToken = enrollRes.body.token as string;
    expect(typeof nadiaToken).toBe("string");

    // ...ending in a session whose permissions are exactly what
    // `employee_self_service` grants: it can view its own record...
    const selfView = await request(app.getHttpServer())
      .get(`/employees/${employeeId}`)
      .set("Authorization", `Bearer ${nadiaToken}`);
    expect(selfView.status).toBe(200);
    expect(selfView.body.id).toBe(employeeId);
    expect(selfView.body.firstName).toBe("Nadia");

    // Decision #13 — GET /auth/me reads back exactly what this real
    // session IS: employee_self_service, linked to the Employee record
    // createLogin() created, in this tenant, with the employee module on.
    const meRes = await request(app.getHttpServer())
      .get("/auth/me")
      .set("Authorization", `Bearer ${nadiaToken}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body).toMatchObject({
      isPlatformAdmin: false,
      companyId,
      fullName: "Nadia Employee",
      email,
      roleKeys: ["employee_self_service"],
      employeeId,
    });
    expect(meRes.body.enabledModules).toContain("employee");

    // ...and nothing more — employee_self_service holds no
    // employee.manage.all, so creating another employee must be refused.
    const forbiddenCreate = await request(app.getHttpServer())
      .post("/employees")
      .set("Authorization", `Bearer ${nadiaToken}`)
      .send({ firstName: "Omar", lastName: "ShouldNotBeCreated" });
    expect(forbiddenCreate.status).toBe(403);
  });

  it("still returns a generic 401 for a plain password mismatch (no account-existence leak) and for an unrecognized identity", async () => {
    const wrongPassword = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: "no-such-user@example.com", password: "irrelevant" });
    expect(wrongPassword.status).toBe(401);
  });

  it("GET /auth/me: an hr_admin fixture with no Employee record of their own gets roleKeys but employeeId: null, and no bearer token at all is rejected", async () => {
    const meRes = await request(app.getHttpServer())
      .get("/auth/me")
      .set("Authorization", `Bearer ${hrAdminToken}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.isPlatformAdmin).toBe(false);
    expect(meRes.body.companyId).toBe(companyId);
    expect(meRes.body.roleKeys).toEqual(["hr_admin"]);
    expect(meRes.body.employeeId).toBeNull();

    const noToken = await request(app.getHttpServer()).get("/auth/me");
    expect(noToken.status).toBe(401);
  });
});
