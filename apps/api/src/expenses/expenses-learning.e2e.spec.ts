import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "expenses-learning-e2e-fixtures" };

/** Over HTTP: expense claims (submit, approve, reimburse through payroll, who may do what) and the learning catalog (create, edit, enrol). */
describe("Expenses and Learning (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let hrToken: string;
  let staffToken: string;
  let staffEmployeeId: string;

  const sign = (sub: string) => jwt.sign({ sub, is_platform_admin: false, company_id: companyId }, process.env.JWT_SECRET as string, { expiresIn: "10m" });
  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
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
    companyId = (await sql<{ id: string }>("INSERT INTO companies (name, slug, status) VALUES ($1, $2, 'active') RETURNING id", [`ExpLearn Co ${stamp}`, `explearn-${stamp}`]))[0].id;
    await sql(
      `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
       VALUES ($1, '["employee", "expense", "learning", "payroll"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
      [companyId]
    );
    await sql(
      "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true),($1,'expense',true),($1,'learning',true),($1,'payroll',true)",
      [companyId]
    );
    const mkUser = async (email: string, role: string) => {
      const id = (await sql<{ id: string }>("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]))[0].id;
      await sql("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) SELECT $1, $2, id FROM roles WHERE key = $3", [id, companyId, role]);
      return id;
    };
    const hrUser = await mkUser(`explearn-hr-${stamp}@example.com`, "hr_admin");
    const staffUser = await mkUser(`explearn-staff-${stamp}@example.com`, "employee_self_service");
    hrToken = sign(hrUser);
    staffToken = sign(staffUser);
    staffEmployeeId = (await http().post("/employees").set(as(hrToken)).send({ firstName: "Ex", lastName: "Learn", userAccountId: staffUser, dateOfJoining: "2020-01-01" })).body.id;
    await http().post("/starter-setup/apply").set(as(hrToken));
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  describe("expense claims", () => {
    let claimId: string;

    it("an employee submits a claim; the list carries a total-count header and honours limit/offset", async () => {
      const res = await http().post("/expense-claims").set(as(staffToken)).send({ employeeId: staffEmployeeId, category: "travel", expenseDate: "2026-10-12", amount: 4500, description: "Client visit" });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: "pending", amount: 4500, queuedForPayroll: false });
      claimId = res.body.id;

      const list = await http().get("/expense-claims?limit=1&offset=0").set(as(hrToken));
      expect(list.status).toBe(200);
      expect(Number(list.headers["x-total-count"])).toBeGreaterThanOrEqual(1);
      expect(list.body.length).toBeLessThanOrEqual(1);
    });

    it("an employee cannot approve, mark paid or reimburse", async () => {
      expect((await http().patch(`/expense-claims/${claimId}/decision`).set(as(staffToken)).send({ decision: "approved" })).status).toBe(403);
      expect((await http().post(`/expense-claims/${claimId}/mark-paid`).set(as(staffToken))).status).toBe(403);
      expect((await http().post(`/expense-claims/${claimId}/reimburse-in-payroll`).set(as(staffToken)).send({})).status).toBe(403);
    });

    it("cannot be reimbursed before it is approved", async () => {
      const res = await http().post(`/expense-claims/${claimId}/reimburse-in-payroll`).set(as(hrToken)).send({});
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/approved/);
    });

    it("HR approves it, queues it for payroll once, and can then no longer mark it paid by hand", async () => {
      const approved = await http().patch(`/expense-claims/${claimId}/decision`).set(as(hrToken)).send({ decision: "approved" });
      expect(approved.status).toBe(200);
      expect(approved.body.status).toBe("approved");

      const queued = await http().post(`/expense-claims/${claimId}/reimburse-in-payroll`).set(as(hrToken)).send({ effectiveDate: "2026-10-20" });
      expect(queued.status).toBe(201);
      expect(queued.body).toMatchObject({ status: "approved", queuedForPayroll: true });
      const payments = await sql<{ amount: string; is_taxable: boolean; status: string }>("SELECT amount, is_taxable, status FROM employee_additional_payments WHERE expense_claim_id = $1", [claimId]);
      expect(payments).toEqual([{ amount: "4500.00", is_taxable: false, status: "pending" }]);

      expect((await http().post(`/expense-claims/${claimId}/reimburse-in-payroll`).set(as(hrToken)).send({})).status).toBe(400);
      expect((await http().post(`/expense-claims/${claimId}/mark-paid`).set(as(hrToken))).status).toBe(400);
    });

    it("rejects a malformed effective date", async () => {
      expect((await http().post(`/expense-claims/${claimId}/reimburse-in-payroll`).set(as(hrToken)).send({ effectiveDate: "tomorrow" })).status).toBe(400);
    });
  });

  describe("learning", () => {
    let courseId: string;

    it("HR creates a course; an employee cannot", async () => {
      const body = { title: "Fire Safety", category: "compliance", durationMinutes: 30 };
      expect((await http().post("/courses").set(as(staffToken)).send(body)).status).toBe(403);
      const res = await http().post("/courses").set(as(hrToken)).send(body);
      expect(res.status).toBe(201);
      courseId = res.body.id;
    });

    it("HR edits only what is sent; an employee and an empty edit are refused", async () => {
      const edited = await http().patch(`/courses/${courseId}`).set(as(hrToken)).send({ title: "Fire Safety 2026", durationMinutes: 45, isMandatory: true });
      expect(edited.status).toBe(200);
      expect(edited.body).toMatchObject({ title: "Fire Safety 2026", durationMinutes: 45, isMandatory: true, category: "compliance" });
      expect((await http().patch(`/courses/${courseId}`).set(as(hrToken)).send({})).status).toBe(400);
      expect((await http().patch(`/courses/${courseId}`).set(as(staffToken)).send({ title: "Hijack" })).status).toBe(403);
      expect((await http().patch(`/courses/${courseId}`).set(as(hrToken)).send({ category: "nonsense" })).status).toBe(400);
    });

    it("an employee enrols once, moves progress to completion, and the enrolment list reports a total", async () => {
      const enrol = await http().post("/course-enrollments").set(as(staffToken)).send({ employeeId: staffEmployeeId, courseId });
      expect(enrol.status).toBe(201);
      expect((await http().post("/course-enrollments").set(as(staffToken)).send({ employeeId: staffEmployeeId, courseId })).status).toBe(400);
      const done = await http().patch(`/course-enrollments/${enrol.body.id}/progress`).set(as(staffToken)).send({ progressPercent: 100 });
      expect(done.status).toBe(200);
      expect(done.body.status).toBe("completed");
      const list = await http().get("/course-enrollments").set(as(hrToken));
      expect(list.status).toBe(200);
      expect(Number(list.headers["x-total-count"])).toBeGreaterThanOrEqual(1);
    });
  });
});
