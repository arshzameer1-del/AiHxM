import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "run-selection-e2e-fixtures" };

/**
 * Payroll run selection (SAP payroll driver "Selection"): a run can pay a chosen set of employees, payroll areas and employee
 * groups instead of everyone. Several selection runs may share a period, nobody is paid twice, and the choices are checked.
 */
describe("Payroll run selection (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let hr: string;
  const emp: Record<string, string> = {};
  let area1: string;
  let area2: string;
  let contractGroup: string;
  let internGroup: string;

  const sign = (sub: string) => jwt.sign({ sub, is_platform_admin: false, company_id: companyId }, process.env.JWT_SECRET as string, { expiresIn: "10m" });
  const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => db.withClaims(FIXTURE_CLAIMS, async (client) => (await client.query(text, params)).rows as T[]);
  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${hr}` });
  const payslipEmployees = async (runId: string) => (await sql<{ employee_number: string }>("SELECT employee_number FROM payslips WHERE payroll_run_id = $1 ORDER BY employee_number", [runId])).map((r) => r.employee_number);

  async function hire(key: string, employmentType: string) {
    const res = await http().post("/employees").set(auth()).send({ firstName: key, lastName: "Selection", dateOfJoining: "2020-01-01", employmentType });
    expect(res.status).toBe(201);
    emp[key] = res.body.id;
    await http().post("/employees/compensation").set(auth()).send({ employeeId: res.body.id, monthlySalary: 100000, effectiveFrom: "2020-01-01" });
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
      const id = (await client.query("INSERT INTO companies (name, slug, status) VALUES ($1, $2, 'active') RETURNING id", [`Selection Co ${stamp}`, `selection-${stamp}`])).rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee", "leave", "payroll"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true),($1,'leave',true),($1,'payroll',true)", [id]);
      return id;
    });
    const hrUser = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const uid = (await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`selection-hr-${stamp}@example.com`])).rows[0].id as string;
      const role = await client.query("SELECT id FROM roles WHERE key = 'hr_admin'");
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [uid, companyId, role.rows[0].id]);
      return uid;
    });
    hr = sign(hrUser);

    await hire("a", "permanent");
    await hire("b", "contract");
    await hire("c", "permanent");
    await hire("d", "contract");

    area1 = (await http().post("/payroll/areas").set(auth()).send({ code: "SEL1", name: "Selection area 1" })).body.id;
    area2 = (await http().post("/payroll/areas").set(auth()).send({ code: "SEL2", name: "Selection area 2" })).body.id;
    for (const [key, area] of [["a", area1], ["b", area1], ["c", area2]] as const) {
      expect((await http().post("/payroll/areas/employee-assignments").set(auth()).send({ employeeId: emp[key], payrollAreaId: area })).status).toBeLessThan(300);
    }
    contractGroup = (await http().post("/employee-groups").set(auth()).send({ name: "Contract staff", conditions: [{ field: "employmentType", equals: "contract" }] })).body.id;
    internGroup = (await http().post("/employee-groups").set(auth()).send({ name: "Interns", conditions: [{ field: "employmentType", equals: "intern" }] })).body.id;
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  const create = (period: string, selection?: Record<string, string[]>, extra: Record<string, unknown> = {}) =>
    http().post("/payroll/runs").set(auth()).send({ periodStart: `${period}-01`, periodEnd: `${period}-28`, ...(selection ? { selection } : {}), ...extra });
  const calculate = (id: string) => http().post(`/payroll/runs/${id}/calculate`).set(auth());

  it("a run for chosen employees pays only them, and the run shows what was chosen", async () => {
    const run = await create("2030-04", { employeeIds: [emp.a, emp.c] });
    expect(run.status).toBe(201);
    expect(run.body.selection).toMatchObject({ employeeIds: expect.arrayContaining([emp.a, emp.c]), payrollAreaIds: [], employeeGroupIds: [], groupMemberCount: 0 });
    const calc = await calculate(run.body.id);
    expect(calc.status).toBe(201);
    expect(calc.body.payslipCount).toBe(2);
    expect(await sql("SELECT 1 FROM payslips WHERE payroll_run_id = $1 AND employee_id = ANY($2::uuid[])", [run.body.id, [emp.a, emp.c]])).toHaveLength(2);
    const listed = await http().get("/payroll/runs").set(auth());
    expect(listed.body.find((r: { id: string }) => r.id === run.body.id).selection.employeeIds).toHaveLength(2);
  });

  it("another selection run for the same period is allowed and pays its own people (employee group)", async () => {
    const run = await create("2030-04", { employeeGroupIds: [contractGroup] });
    expect(run.status).toBe(201);
    expect(run.body.selection.groupMemberCount).toBe(2);
    const calc = await calculate(run.body.id);
    expect(calc.body.payslipCount).toBe(2);
    expect(await sql("SELECT 1 FROM payslips WHERE payroll_run_id = $1 AND employee_id = ANY($2::uuid[])", [run.body.id, [emp.b, emp.d]])).toHaveLength(2);
  });

  it("nobody is paid twice: an employee another run of the period already paid is refused", async () => {
    const run = await create("2030-04", { employeeIds: [emp.a] });
    expect(run.status).toBe(201);
    const calc = await calculate(run.body.id);
    expect(calc.body.payslipCount).toBe(0);
    expect(calc.body.errors).toHaveLength(1);
    expect(await payslipEmployees(run.body.id)).toEqual([]);
  });

  it("a run that pays everyone cannot be added beside selection runs of the same period", async () => {
    const full = await create("2030-04");
    expect(full.status).toBe(400);
  });

  it("the selections narrow each other: payroll area AND chosen employees", async () => {
    const run = await create("2030-05", { payrollAreaIds: [area1], employeeIds: [emp.b, emp.c] });
    expect(run.status).toBe(201);
    const calc = await calculate(run.body.id);
    expect(calc.body.payslipCount).toBe(1);
    expect(await sql("SELECT 1 FROM payslips WHERE payroll_run_id = $1 AND employee_id = $2", [run.body.id, emp.b])).toHaveLength(1);
  });

  it("several payroll areas can be chosen in one run", async () => {
    const run = await create("2030-06", { payrollAreaIds: [area1, area2] });
    expect(run.status).toBe(201);
    expect((await calculate(run.body.id)).body.payslipCount).toBe(3);
  });

  it("a selection that cannot work is refused with a clear message", async () => {
    const unknown = await create("2030-07", { employeeIds: ["00000000-0000-4000-8000-000000000001"] });
    expect(unknown.status).toBe(400);
    const emptyGroup = await create("2030-07", { employeeGroupIds: [internGroup] });
    expect(emptyGroup.status).toBe(400);
    expect(JSON.stringify(emptyGroup.body)).toContain("no active members");
    const badArea = await create("2030-07", { payrollAreaIds: ["00000000-0000-4000-8000-000000000002"] });
    expect(badArea.status).toBe(400);
    const notIds = await create("2030-07", { employeeIds: ["EMP0001"] });
    expect(notIds.status).toBe(400);
    expect(await sql("SELECT 1 FROM payroll_runs WHERE company_id = $1 AND period_start = '2030-07-01'", [companyId])).toHaveLength(0);
  });

  it("a run for one employee cannot also carry a selection", async () => {
    const res = await create("2030-08", { employeeIds: [emp.a] }, { runType: "off_cycle", offCycleReason: "bonus", targetEmployeeId: emp.a });
    expect(res.status).toBe(400);
  });

  it("an empty selection is the same as none: the run pays everyone it covers", async () => {
    const run = await create("2030-09", { employeeIds: [], payrollAreaIds: [], employeeGroupIds: [] });
    expect(run.status).toBe(201);
    expect(run.body.selection ?? null).toBeNull();
    expect((await calculate(run.body.id)).body.payslipCount).toBe(4);
  });

  it("the same request sent twice with one idempotency key returns the same run", async () => {
    const body = { idempotencyKey: `sel-${Date.now()}`, selection: { employeeIds: [emp.c, emp.d] } };
    const first = await create("2030-10", body.selection, { idempotencyKey: body.idempotencyKey });
    const again = await create("2030-10", { employeeIds: [emp.d, emp.c] }, { idempotencyKey: body.idempotencyKey });
    expect(first.status).toBe(201);
    expect(again.body.id).toBe(first.body.id);
    const different = await create("2030-10", { employeeIds: [emp.a] }, { idempotencyKey: body.idempotencyKey });
    expect(different.status).toBe(409);
  });
});
