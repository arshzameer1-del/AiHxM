import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "dsr-e2e-fixtures" };

/**
 * Real routes only (data-subject-requests.controller.ts): POST
 * /data-subject-requests, GET /data-subject-requests, GET
 * /data-subject-requests/mine, GET /data-subject-requests/:id, POST
 * /data-subject-requests/:id/decide, POST
 * /data-subject-requests/:id/fulfill — proven over the real HTTP surface,
 * same as attendance-corrections.e2e.spec.ts does for its module. The
 * service-level spec already covers the finer-grained two-step workflow
 * routing and permission edge cases; this proves the routes themselves,
 * DTO validation, and the "mine" route isn't shadowed by ":id".
 */
describe("Data subject requests HTTP surface (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let hrAdminToken: string;
  let staffToken: string;
  let outsiderToken: string;
  let staffEmployeeId: string;

  function signSession(payload: { sub: string; is_platform_admin: boolean; company_id: string | null }): string {
    return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: "10m" });
  }

  async function createUser(email: string): Promise<string> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        email,
      ]);
      return result.rows[0].id as string;
    });
  }

  async function assignRole(userAccountId: string, roleKey: string): Promise<void> {
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [
        userAccountId,
        companyId,
        role.rows[0].id,
      ]);
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug, status) VALUES ($1, $2, 'active') RETURNING id", [
        `DSR E2E Co ${stamp}`,
        `dsr-e2e-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [
        id,
      ]);
      return id;
    });

    const hrAdminUserId = await createUser(`dsr-e2e-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    await assignRole(hrAdminUserId, "rbac_demo_full_access"); // workflow_template.manage.all, to create the template below
    hrAdminToken = signSession({ sub: hrAdminUserId, is_platform_admin: false, company_id: companyId });

    const staffUserId = await createUser(`dsr-e2e-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service");
    staffToken = signSession({ sub: staffUserId, is_platform_admin: false, company_id: companyId });

    const outsiderUserId = await createUser(`dsr-e2e-outsider-${stamp}@example.com`);
    await assignRole(outsiderUserId, "employee_self_service");
    outsiderToken = signSession({ sub: outsiderUserId, is_platform_admin: false, company_id: companyId });

    const staffEmpRes = await request(app.getHttpServer())
      .post("/employees")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ firstName: "Sam", lastName: "Staff", userAccountId: staffUserId });
    staffEmployeeId = staffEmpRes.body.id;

    // A real tenant-configured single-step chain (HR role) — enough to
    // prove the HTTP surface end to end; the unit spec is where the
    // genuine two-step routing gets exercised.
    await request(app.getHttpServer())
      .post("/workflow/templates")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({
        key: "data_subject_request",
        name: "Data Subject Request Review",
        objectKey: "data_subject_request",
        steps: [{ stepOrder: 1, name: "HR reviews", approvers: [{ approverType: "role", roleId: await hrRoleId() }] }],
      });

    async function hrRoleId(): Promise<string> {
      const role = await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("SELECT id FROM roles WHERE key = 'hr_admin'"));
      return role.rows[0].id;
    }
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("rejects a validation-invalid submission (bad requestType)", async () => {
    const res = await request(app.getHttpServer())
      .post("/data-subject-requests")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ employeeId: staffEmployeeId, requestType: "not-a-real-type", description: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects an unauthenticated request", async () => {
    const res = await request(app.getHttpServer())
      .post("/data-subject-requests")
      .send({ employeeId: staffEmployeeId, requestType: "access", description: "x" });
    expect(res.status).toBe(401);
  });

  describe("full submit -> queue -> decide -> fulfill lifecycle", () => {
    let requestId: string;

    it("lets the employee submit a request about their own data over HTTP", async () => {
      const res = await request(app.getHttpServer())
        .post("/data-subject-requests")
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ employeeId: staffEmployeeId, requestType: "access", description: "Send me a copy of my HR file." });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("pending");
      expect(res.body.isOnBehalf).toBe(false);
      requestId = res.body.id;
    });

    it("shows up in the employee's own 'mine' list, not shadowed by the :id route", async () => {
      const res = await request(app.getHttpServer())
        .get("/data-subject-requests/mine")
        .set("Authorization", `Bearer ${staffToken}`);
      expect(res.status).toBe(200);
      expect(res.body.some((r: { id: string }) => r.id === requestId)).toBe(true);
    });

    it("refuses a plain employee from viewing the HR queue", async () => {
      const res = await request(app.getHttpServer())
        .get("/data-subject-requests")
        .set("Authorization", `Bearer ${staffToken}`);
      expect(res.status).toBe(403);
    });

    it("shows up in HR's queue", async () => {
      const res = await request(app.getHttpServer())
        .get("/data-subject-requests")
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.some((r: { id: string }) => r.id === requestId)).toBe(true);
    });

    it("refuses an outsider from viewing it by id", async () => {
      const res = await request(app.getHttpServer())
        .get(`/data-subject-requests/${requestId}`)
        .set("Authorization", `Bearer ${outsiderToken}`);
      expect(res.status).toBe(404);
    });

    it("refuses fulfilling before it's decided", async () => {
      const res = await request(app.getHttpServer())
        .post(`/data-subject-requests/${requestId}/fulfill`)
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ fulfillmentNote: "too early" });
      expect(res.status).toBe(409);
    });

    it("lets HR decide (approve) it — the single configured step closes it out", async () => {
      const res = await request(app.getHttpServer())
        .post(`/data-subject-requests/${requestId}/decide`)
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ decision: "approved", comment: "Legitimate request" });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("approved");
    });

    it("lets HR fulfill it, and it reflects fulfilled everywhere it's visible", async () => {
      const res = await request(app.getHttpServer())
        .post(`/data-subject-requests/${requestId}/fulfill`)
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ fulfillmentNote: "Exported and emailed the employee's HR file securely." });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("fulfilled");
      expect(res.body.fulfillmentNote).toContain("Exported");

      const mine = await request(app.getHttpServer())
        .get("/data-subject-requests/mine")
        .set("Authorization", `Bearer ${staffToken}`);
      expect(mine.body.find((r: { id: string }) => r.id === requestId).status).toBe("fulfilled");
    });
  });
});
