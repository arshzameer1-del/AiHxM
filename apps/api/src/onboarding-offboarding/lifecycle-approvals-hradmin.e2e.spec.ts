import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "lifecycle-approvals-e2e-fixtures" };

/** Over HTTP: offboarding and its final-settlement hand-off, the approvals inbox, and the HR Administration reference catalog. */
describe("Offboarding, approvals inbox and HR Administration (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let hrToken: string;
  let staffToken: string;
  let leaverId: string;
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
    companyId = (await sql<{ id: string }>("INSERT INTO companies (name, slug, status) VALUES ($1, $2, 'active') RETURNING id", [`Lifecycle Co ${stamp}`, `lifecycle-${stamp}`]))[0].id;
    const modules = ["employee", "leave", "payroll", "expense", "exit"];
    await sql(
      `INSERT INTO company_config (company_id, enabled_modules, employee_number_format) VALUES ($1, $2::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
      [companyId, JSON.stringify(modules)]
    );
    for (const m of modules) await sql("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,$2,true) ON CONFLICT DO NOTHING", [companyId, m]);
    const mkUser = async (email: string, role: string) => {
      const id = (await sql<{ id: string }>("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]))[0].id;
      await sql("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) SELECT $1, $2, id FROM roles WHERE key = $3", [id, companyId, role]);
      return id;
    };
    const hrUser = await mkUser(`lc-hr-${stamp}@example.com`, "hr_admin");
    const staffUser = await mkUser(`lc-staff-${stamp}@example.com`, "employee_self_service");
    hrToken = sign(hrUser);
    staffToken = sign(staffUser);
    staffEmployeeId = (await http().post("/employees").set(as(hrToken)).send({ firstName: "Stay", lastName: "Staff", userAccountId: staffUser, dateOfJoining: "2020-01-01" })).body.id;
    leaverId = (await http().post("/employees").set(as(hrToken)).send({ firstName: "Leaving", lastName: "Person", dateOfJoining: "2020-01-01" })).body.id;
    await http().post("/starter-setup/apply").set(as(hrToken));
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  describe("offboarding", () => {
    it("an employee cannot start an offboarding", async () => {
      const res = await http().post(`/employees/${leaverId}/offboarding`).set(as(staffToken)).send({ reason: "resignation", lastWorkingDay: "2026-11-30" });
      expect(res.status).toBe(403);
    });

    it("HR starts one, ticks the checklist, finalises it, and the termination opens a final settlement", async () => {
      const started = await http().post(`/employees/${leaverId}/offboarding`).set(as(hrToken)).send({ reason: "resignation", lastWorkingDay: "2026-10-20" });
      expect(started.status).toBe(201);
      expect(started.body.status).toBe("in_progress");
      expect((await http().post(`/employees/${leaverId}/offboarding`).set(as(hrToken)).send({ reason: "resignation", lastWorkingDay: "2026-10-20" })).status).toBeGreaterThanOrEqual(400);

      for (const item of started.body.items as Array<{ id: string }>) {
        const done = await http().patch(`/offboarding-items/${item.id}`).set(as(hrToken)).send({ status: "completed" });
        expect(done.status).toBe(200);
      }
      const finished = await http().post(`/employees/${leaverId}/offboarding/complete`).set(as(hrToken));
      expect(finished.status).toBe(201);
      expect(finished.body.status).toBe("completed");

      const employee = await http().get(`/employees/${leaverId}`).set(as(hrToken));
      expect(employee.body.employmentStatus).toBe("terminated");
      const settlements = await http().get("/payroll/final-settlements").set(as(hrToken));
      expect(settlements.status).toBe(200);
      expect(settlements.body.some((s: { employeeId: string }) => s.employeeId === leaverId)).toBe(true);
      expect((await http().get("/payroll/final-settlements").set(as(staffToken))).status).toBe(403);
    });
  });

  describe("approvals inbox", () => {
    it("a submitted expense claim shows in HR's inbox, an employee's own inbox hides others' items, and HR can decide it there", async () => {
      const claim = await http().post("/expense-claims").set(as(staffToken)).send({ employeeId: staffEmployeeId, category: "meals", expenseDate: "2026-10-10", amount: 900 });
      expect(claim.status).toBe(201);
      const items = await http().get("/inbox/items?tab=pending").set(as(hrToken));
      expect(items.status).toBe(200);
      const mine = (items.body.items ?? items.body) as Array<{ instanceId?: string; id?: string; objectKey?: string }>;
      const found = mine.find((i) => (i.objectKey ?? "") === "expense_claim");
      expect(found).toBeDefined();

      const counts = await http().get("/inbox/counts").set(as(hrToken));
      expect(counts.status).toBe(200);

      const staffItems = await http().get("/inbox/items?tab=pending").set(as(staffToken));
      expect(staffItems.status).toBe(200);
      const staffList = (staffItems.body.items ?? staffItems.body) as Array<{ objectKey?: string }>;
      expect(staffList.filter((i) => i.objectKey === "expense_claim")).toHaveLength(0);

      const instanceId = (found!.instanceId ?? found!.id) as string;
      const decided = await http().post(`/inbox/items/${instanceId}/decision`).set(as(hrToken)).send({ decision: "approved", comment: "ok" });
      expect(decided.status).toBeLessThan(300);
      const after = await http().get(`/expense-claims/${claim.body.id}`).set(as(hrToken));
      expect(after.body.status).toBe("approved");
    });

    it("answers a malformed item id with 400, not a crash", async () => {
      expect((await http().get("/inbox/items/not-a-uuid").set(as(hrToken))).status).toBe(400);
    });
  });

  describe("HR Administration reference catalog", () => {
    it("lists the catalog types for HR, refuses an employee, and lets HR add an item (a duplicate code is refused)", async () => {
      const types = await http().get("/hr-administration/reference-catalog/types").set(as(hrToken));
      expect(types.status).toBe(200);
      expect(types.body.length).toBeGreaterThan(5);
      expect((await http().get("/hr-administration/reference-catalog/types").set(as(staffToken))).status).toBe(403);

      const created = await http().post("/hr-administration/reference-catalog").set(as(hrToken)).send({ catalogType: "employment_type", code: "seasonal_e2e", label: "Seasonal" });
      expect(created.status).toBe(201);
      expect((await http().post("/hr-administration/reference-catalog").set(as(hrToken)).send({ catalogType: "employment_type", code: "seasonal_e2e", label: "Seasonal again" })).status).toBeGreaterThanOrEqual(400);
      const listed = await http().get("/hr-administration/reference-catalog/employment_type").set(as(hrToken));
      expect(listed.body.some((i: { code: string }) => i.code === "seasonal_e2e")).toBe(true);
      expect((await http().post("/hr-administration/reference-catalog").set(as(staffToken)).send({ catalogType: "employment_type", code: "x_e2e", label: "X" })).status).toBe(403);
    });
  });
});
