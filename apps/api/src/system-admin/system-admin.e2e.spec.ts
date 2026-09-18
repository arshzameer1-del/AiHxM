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
  sub: "system-admin-e2e-fixtures",
};

function signSession(payload: {
  sub: string;
  is_platform_admin: boolean;
  company_id: string | null;
}): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, {
    expiresIn: "10m",
  });
}

/**
 * HTTP surface for the real System Admin module
 * (system-admin.controller.ts): a tenant-scoped Roles & Access panel gated
 * by `role_assignment.manage.all`, not a Platform Admin console. Every
 * route sits behind plain `SessionGuard` — any authenticated session can
 * reach the controller method, and `SystemAdminService` itself checks the
 * permission and scopes every query to the caller's own `company_id`.
 * There is no `/system-admin/settings`, `/system-admin/audit-logs`,
 * `/system-admin/notification-templates`, `/system-admin/companies`,
 * `/system-admin/statistics`, or `/auth/register` — those never existed;
 * this suite only exercises the five real routes.
 */
describe("System Admin HTTP surface (e2e) — Roles & Access panel", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;

  let companyId: string;
  let otherCompanyId: string;
  let ayeshaId: string; // hr_admin only — no role_assignment.manage.all
  let bilalId: string; // system_admin
  let sanaId: string; // no login at all
  let otherCoEmployeeId: string;

  let ayeshaToken: string;
  let bilalToken: string;

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

    const stamp = Date.now();

    async function makeCompany(name: string): Promise<string> {
      return db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const company = await client.query(
          "INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id",
          [name, `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${stamp}`]
        );
        const id = company.rows[0].id as string;
        await client.query(
          `INSERT INTO company_config (company_id, employee_number_format)
           VALUES ($1, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
          [id]
        );
        await client.query(
          "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)",
          [id]
        );
        return id;
      });
    }

    async function makeEmployee(
      cId: string,
      num: string,
      first: string,
      last: string,
      email: string
    ): Promise<string> {
      return db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query(
          `INSERT INTO employees (company_id, employee_number, first_name, last_name, email, employment_type, employment_status, date_of_joining)
           VALUES ($1,$2,$3,$4,$5,'permanent','active', now()) RETURNING id`,
          [cId, num, first, last, email]
        );
        return result.rows[0].id as string;
      });
    }

    async function makeLogin(email: string): Promise<string> {
      return db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const acct = await client.query(
          "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
          [email]
        );
        return acct.rows[0].id as string;
      });
    }

    // Same direct-SQL role grant recruitment.service.spec.ts's own
    // `assignRole` fixture helper uses — a real `user_role_assignments`
    // row referencing the real `system_admin`/`hr_admin` role ids, not a
    // mocked permission.
    async function assignRoleSql(
      userAccountId: string,
      cId: string,
      roleKey: string
    ): Promise<void> {
      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
        await client.query(
          "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
          [userAccountId, cId, role.rows[0].id]
        );
      });
    }

    companyId = await makeCompany(`SysAdmin E2E Co ${stamp}`);
    otherCompanyId = await makeCompany(`SysAdmin E2E Other Co ${stamp}`);

    ayeshaId = await makeEmployee(companyId, "EMP-0001", "Ayesha", "Khan", `sysadmin-e2e-ayesha-${stamp}@example.com`);
    bilalId = await makeEmployee(companyId, "EMP-0002", "Bilal", "Ahmed", `sysadmin-e2e-bilal-${stamp}@example.com`);
    sanaId = await makeEmployee(companyId, "EMP-0003", "Sana", "Riaz", `sysadmin-e2e-sana-${stamp}@example.com`);
    otherCoEmployeeId = await makeEmployee(
      otherCompanyId,
      "OTH-0001",
      "Other",
      "Tenant",
      `sysadmin-e2e-other-${stamp}@example.com`
    );

    const ayeshaUserAccountId = await makeLogin(`sysadmin-e2e-ayesha-${stamp}@example.com`);
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("UPDATE employees SET user_account_id = $1 WHERE id = $2", [ayeshaUserAccountId, ayeshaId])
    );
    await assignRoleSql(ayeshaUserAccountId, companyId, "hr_admin");
    ayeshaToken = signSession({ sub: ayeshaUserAccountId, is_platform_admin: false, company_id: companyId });

    const bilalUserAccountId = await makeLogin(`sysadmin-e2e-bilal-${stamp}@example.com`);
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("UPDATE employees SET user_account_id = $1 WHERE id = $2", [bilalUserAccountId, bilalId])
    );
    await assignRoleSql(bilalUserAccountId, companyId, "system_admin");
    bilalToken = signSession({ sub: bilalUserAccountId, is_platform_admin: false, company_id: companyId });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("DELETE FROM companies WHERE id = ANY($1::uuid[])", [[companyId, otherCompanyId]])
    );
    await pool.end();
    await app.close();
  });

  describe("GET /system-admin/roles", () => {
    it("returns the four real tenant roles, never the Phase 4 rbac_demo_* roles", async () => {
      const res = await request(app.getHttpServer())
        .get("/system-admin/roles")
        .set("Authorization", `Bearer ${bilalToken}`);

      expect(res.status).toBe(200);
      const keys = (res.body as Array<{ key: string }>).map((r) => r.key).sort();
      expect(keys).toEqual(["employee_self_service", "hr_admin", "line_manager", "system_admin"]);
    });

    it("rejects an unauthenticated request", async () => {
      const res = await request(app.getHttpServer()).get("/system-admin/roles");
      expect(res.status).toBe(401);
    });

    it("403s a real session that lacks role_assignment.manage.all", async () => {
      const res = await request(app.getHttpServer())
        .get("/system-admin/roles")
        .set("Authorization", `Bearer ${ayeshaToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe("GET /system-admin/assignable-users", () => {
    it("lists every employee in the caller's company with login/role status, without leaking EmployeeView fields", async () => {
      const res = await request(app.getHttpServer())
        .get("/system-admin/assignable-users")
        .set("Authorization", `Bearer ${bilalToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(3);
      const ayesha = res.body.find((u: { employeeId: string }) => u.employeeId === ayeshaId);
      const bilal = res.body.find((u: { employeeId: string }) => u.employeeId === bilalId);
      const sana = res.body.find((u: { employeeId: string }) => u.employeeId === sanaId);
      expect(ayesha.roleKeys).toEqual(["hr_admin"]);
      expect(ayesha.hasLogin).toBe(true);
      expect(bilal.roleKeys).toEqual(["system_admin"]);
      expect(sana.hasLogin).toBe(false);
      expect(sana.roleKeys).toEqual([]);
      expect(Object.keys(ayesha).sort()).toEqual(
        ["email", "employeeId", "employeeNumber", "fullName", "hasLogin", "roleKeys", "userAccountId"].sort()
      );
    });
  });

  describe("POST /system-admin/role-assignments and GET /system-admin/role-assignments", () => {
    it("grants an additional role to an existing login, then lists it", async () => {
      const assignRes = await request(app.getHttpServer())
        .post("/system-admin/role-assignments")
        .set("Authorization", `Bearer ${bilalToken}`)
        .send({ employeeId: ayeshaId, roleKey: "line_manager" });

      expect(assignRes.status).toBe(201);
      expect(assignRes.body.roleKey).toBe("line_manager");
      expect(assignRes.body.employeeName).toBe("Ayesha Khan");
      const assignmentId = assignRes.body.id as string;

      const listRes = await request(app.getHttpServer())
        .get("/system-admin/role-assignments")
        .set("Authorization", `Bearer ${bilalToken}`);
      expect(listRes.status).toBe(200);
      expect(listRes.body.some((a: { id: string }) => a.id === assignmentId)).toBe(true);

      const cleanup = await request(app.getHttpServer())
        .delete(`/system-admin/role-assignments/${assignmentId}`)
        .set("Authorization", `Bearer ${bilalToken}`);
      expect(cleanup.status).toBe(200);
      expect(cleanup.body.message).toBe("Role assignment revoked.");
    });

    it("400s granting a role to an employee with no login yet", async () => {
      const res = await request(app.getHttpServer())
        .post("/system-admin/role-assignments")
        .set("Authorization", `Bearer ${bilalToken}`)
        .send({ employeeId: sanaId, roleKey: "employee_self_service" });
      expect(res.status).toBe(400);
    });

    it("409s a duplicate grant (Bilal already holds system_admin)", async () => {
      const res = await request(app.getHttpServer())
        .post("/system-admin/role-assignments")
        .set("Authorization", `Bearer ${bilalToken}`)
        .send({ employeeId: bilalId, roleKey: "system_admin" });
      expect(res.status).toBe(409);
    });

    it("404s granting a role to a cross-tenant employeeId, never a silent success", async () => {
      const res = await request(app.getHttpServer())
        .post("/system-admin/role-assignments")
        .set("Authorization", `Bearer ${bilalToken}`)
        .send({ employeeId: otherCoEmployeeId, roleKey: "employee_self_service" });
      expect(res.status).toBe(404);
    });

    it("400s an unassignable roleKey (DTO validation rejects it before the service ever runs)", async () => {
      const res = await request(app.getHttpServer())
        .post("/system-admin/role-assignments")
        .set("Authorization", `Bearer ${bilalToken}`)
        .send({ employeeId: ayeshaId, roleKey: "rbac_demo_full_access" });
      expect(res.status).toBe(400);
    });

    it("403s a caller with no role_assignment.manage.all", async () => {
      const res = await request(app.getHttpServer())
        .post("/system-admin/role-assignments")
        .set("Authorization", `Bearer ${ayeshaToken}`)
        .send({ employeeId: bilalId, roleKey: "hr_admin" });
      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /system-admin/role-assignments/:id", () => {
    it("404s revoking an assignment id from another company", async () => {
      const otherCoAssignmentId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const acct = await client.query(
          "INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id",
          [`sysadmin-e2e-other-role-${Date.now()}@example.com`]
        );
        const role = await client.query("SELECT id FROM roles WHERE key = 'employee_self_service'");
        const assignment = await client.query(
          "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,$3) RETURNING id",
          [acct.rows[0].id, otherCompanyId, role.rows[0].id]
        );
        return assignment.rows[0].id as string;
      });

      const res = await request(app.getHttpServer())
        .delete(`/system-admin/role-assignments/${otherCoAssignmentId}`)
        .set("Authorization", `Bearer ${bilalToken}`);
      expect(res.status).toBe(404);
    });
  });
});
