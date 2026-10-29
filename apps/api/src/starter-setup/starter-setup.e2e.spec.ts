import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "starter-setup-e2e-fixtures" };

/**
 * A company on its first day has no approval routes, no leave policy, no shift and no holidays. Leave and
 * expense submissions used to answer 404 and leave a pending row nobody could approve; payroll could never be
 * finalized. The starter setup (HR Admin, Configuration Center) adds what is missing, safely and repeatably.
 */
describe("Starter setup (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let hrToken: string;
  let staffToken: string;
  let staffUserId: string;
  let staffEmployeeId: string;

  const sign = (sub: string) => jwt.sign({ sub, is_platform_admin: false, company_id: companyId }, process.env.JWT_SECRET as string, { expiresIn: "10m" });

  async function createUser(email: string): Promise<string> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => (await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [email])).rows[0].id as string);
  }
  async function assignRole(userId: string, roleKey: string): Promise<void> {
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [userId, companyId, role.rows[0].id]);
    });
  }
  const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    db.withClaims(FIXTURE_CLAIMS, async (client) => (await client.query(text, params)).rows as T[]);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const id = (await client.query("INSERT INTO companies (name, slug, status) VALUES ($1, $2, 'active') RETURNING id", [`Starter Co ${stamp}`, `starter-${stamp}`])).rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee", "leave", "payroll", "expense"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true),($1,'leave',true),($1,'payroll',true),($1,'expense',true)", [id]);
      return id;
    });

    const hrUser = await createUser(`starter-hr-${stamp}@example.com`);
    await assignRole(hrUser, "hr_admin");
    hrToken = sign(hrUser);
    staffUserId = await createUser(`starter-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service");
    staffToken = sign(staffUserId);

    const emp = await request(app.getHttpServer())
      .post("/employees")
      .set("Authorization", `Bearer ${hrToken}`)
      .send({ firstName: "Starter", lastName: "Staff", userAccountId: staffUserId, dateOfJoining: "2020-01-01" });
    staffEmployeeId = emp.body.id;
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("an employee cannot read or apply the starter setup", async () => {
    expect((await request(app.getHttpServer()).get("/starter-setup").set("Authorization", `Bearer ${staffToken}`)).status).toBe(403);
    expect((await request(app.getHttpServer()).post("/starter-setup/apply").set("Authorization", `Bearer ${staffToken}`)).status).toBe(403);
  });

  it("a brand-new company shows every approval route, the holidays, the leave policy and the shift as missing", async () => {
    const res = await request(app.getHttpServer()).get("/starter-setup").set("Authorization", `Bearer ${hrToken}`);
    expect(res.status).toBe(200);
    expect(res.body.canApply).toBe(true);
    const state = (key: string) => res.body.items.find((i: { key: string }) => i.key === key)?.state;
    for (const key of ["leave_request", "expense_claim", "job_requisition", "org_reorganization", "data_subject_request", "payroll_run"]) {
      expect(state(`workflow:${key}`)).toBe("missing");
    }
    expect(state("holidays")).toBe("missing");
    expect(state("leave_policy")).toBe("missing");
    expect(state("shift")).toBe("missing");
    expect(state("payroll_approver")).toBe("attention");
  });

  it("a failed leave submission leaves no pending request behind", async () => {
    const policy = await request(app.getHttpServer())
      .post("/leave-policies")
      .set("Authorization", `Bearer ${hrToken}`)
      .send({ name: "Pre-existing", annualLeaveDays: 14, casualLeaveDays: 10, sickLeaveDays: 8, isDefault: true });
    expect(policy.status).toBe(201);
    const res = await request(app.getHttpServer())
      .post("/leave-requests")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ employeeId: staffEmployeeId, leaveType: "annual", startDate: "2030-03-04", endDate: "2030-03-05" });
    // Since BACKLOG58 the submission is checked first and refused with a plain "no approver" message (nothing is saved).
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("LEAVE_VALIDATION_FAILED");
    expect(res.body.message).toContain("No approver");
    const rows = await sql("SELECT 1 FROM leave_requests WHERE company_id = $1", [companyId]);
    expect(rows).toHaveLength(0);
  });

  it("a failed expense claim leaves no claim behind", async () => {
    const res = await request(app.getHttpServer())
      .post("/expense-claims")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ employeeId: staffEmployeeId, category: "travel", expenseDate: "2030-03-04", amount: 500 });
    expect(res.status).toBe(404);
    expect(await sql("SELECT 1 FROM expense_claims WHERE company_id = $1", [companyId])).toHaveLength(0);
  });

  it("a privacy request without a route still reaches HR (BACKLOG52) - nothing is lost", async () => {
    const res = await request(app.getHttpServer())
      .post("/data-subject-requests")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ employeeId: staffEmployeeId, requestType: "access", description: "Copy of my data" });
    expect(res.status).toBe(201);
    expect(await sql("SELECT 1 FROM data_subject_requests WHERE company_id = $1 AND workflow_instance_id IS NULL", [companyId])).toHaveLength(1);
    await sql("DELETE FROM data_subject_requests WHERE company_id = $1", [companyId]);
  });

  it("applying adds the routes, holidays, leave policy (kept if one exists) and shift, and reports what it did", async () => {
    const res = await request(app.getHttpServer()).post("/starter-setup/apply").set("Authorization", `Bearer ${hrToken}`);
    expect(res.status).toBe(201);
    expect(res.body.created).toEqual(expect.arrayContaining(["workflow:leave_request", "workflow:payroll_run", "holidays", "shift"]));
    // The company already had a leave policy from the earlier test: it is left exactly as it was.
    expect(res.body.created).not.toContain("leave_policy");
    expect(res.body.skipped).toContain("leave_policy");
    expect(res.body.status.canApply).toBe(false);

    const templates = await sql<{ key: string }>("SELECT key FROM workflow_templates WHERE company_id = $1 ORDER BY key", [companyId]);
    expect(templates.map((t) => t.key)).toEqual(["data_subject_request", "expense_claim", "job_requisition", "leave_request", "org_reorganization", "payroll_run"]);
    const holidays = await sql<{ n: string }>("SELECT count(*)::text AS n FROM holidays WHERE company_id = $1", [companyId]);
    expect(Number(holidays[0].n)).toBe(8);
    const policies = await sql<{ name: string }>("SELECT name FROM leave_policies WHERE company_id = $1", [companyId]);
    expect(policies.map((p) => p.name)).toEqual(["Pre-existing"]);
  });

  it("applying again adds nothing", async () => {
    const res = await request(app.getHttpServer()).post("/starter-setup/apply").set("Authorization", `Bearer ${hrToken}`);
    expect(res.status).toBe(201);
    expect(res.body.created).toEqual([]);
    expect(await sql("SELECT 1 FROM holidays WHERE company_id = $1", [companyId])).toHaveLength(8);
    expect(await sql("SELECT 1 FROM workflow_templates WHERE company_id = $1", [companyId])).toHaveLength(6);
  });

  it("leave and expense requests now reach an approver, and a payroll run can be submitted for approval", async () => {
    const leave = await request(app.getHttpServer())
      .post("/leave-requests")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ employeeId: staffEmployeeId, leaveType: "annual", startDate: "2030-03-04", endDate: "2030-03-05" });
    expect(leave.status).toBe(201);
    expect(leave.body.request.status).toBe("pending");

    const claim = await request(app.getHttpServer())
      .post("/expense-claims")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ employeeId: staffEmployeeId, category: "travel", expenseDate: "2030-03-04", amount: 500 });
    expect(claim.status).toBe(201);

    await request(app.getHttpServer()).post("/employees/compensation").set("Authorization", `Bearer ${hrToken}`).send({ employeeId: staffEmployeeId, monthlySalary: 100000, effectiveFrom: "2020-01-01" });
    const run = await request(app.getHttpServer()).post("/payroll/runs").set("Authorization", `Bearer ${hrToken}`).send({ periodStart: "2030-03-01", periodEnd: "2030-03-31" });
    expect(run.status).toBe(201);
    expect((await request(app.getHttpServer()).post(`/payroll/runs/${run.body.id}/calculate`).set("Authorization", `Bearer ${hrToken}`)).status).toBe(201);
    const submit = await request(app.getHttpServer()).post(`/payroll/runs/${run.body.id}/submit-for-approval`).set("Authorization", `Bearer ${hrToken}`);
    expect(submit.status).toBe(201);
  });
});
