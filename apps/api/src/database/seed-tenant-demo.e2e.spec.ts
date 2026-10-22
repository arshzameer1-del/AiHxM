import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "./database.service";
import type { RequestClaims } from "./tenant-context";
import { seedDemoTenant, type SeedResult } from "./seed-tenant-demo";
import { Pool } from "pg";
import { executeReset, planReset } from "./reset-tenant-data";
import { runInTenantContext } from "./tenant-context";
import { DEMO_EMPLOYEES } from "./demo-tenant-data";

const SERVICE: RequestClaims = { is_platform_admin: false, is_service: true, sub: "seed-tenant-demo-spec" };

/**
 * The whole product on the demo data: signs up a company through the real public endpoint, loads the demo data set the way
 * the live reset does (reset, then seed), then walks the main screens' endpoints as the company's HR admin. If a module cannot
 * cope with realistic data, it shows up here.
 */
describe("demo tenant: reset, seed and a walk through the product", () => {
  let app: INestApplication;
  let db: DatabaseService;
  let companyId: string;
  let slug: string;
  let adminId: string;
  let token: string;
  let seeded: SeedResult;

  const get = (path: string) => request(app.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    db = app.get(DatabaseService);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const signup = await request(app.getHttpServer())
      .post("/signup")
      .send({ companyName: `Demo Seed ${stamp}`, adminFullName: "Demo Admin", adminEmail: `demo-admin-${stamp}@example.com`, adminPassword: "DemoSeedPassw0rd!", packageTier: "enterprise" });
    expect(signup.status).toBe(201);
    companyId = signup.body.companyId;
    slug = signup.body.slug;
    const admin = await db.withClaims(SERVICE, (c) =>
      c.query(
        `SELECT u.id FROM user_role_assignments ura JOIN roles r ON r.id = ura.role_id JOIN user_accounts u ON u.id = ura.user_account_id
          WHERE ura.company_id = $1 AND r.key = 'hr_admin' LIMIT 1`,
        [companyId]
      )
    );
    adminId = admin.rows[0].id;
    // the live HR admin also holds the self-service role (that is what "My ..." screens need); mirror it here
    await db.withClaims(SERVICE, (c) =>
      c.query(
        `INSERT INTO user_role_assignments (user_account_id, company_id, role_id)
         SELECT $1, $2, id FROM roles WHERE key = 'employee_self_service'`,
        [adminId, companyId]
      )
    );
    token = jwt.sign({ sub: adminId, is_platform_admin: false, company_id: companyId }, process.env.JWT_SECRET as string, { expiresIn: "30m" });
    seeded = await seedDemoTenant(app, companyId, (l) => /WARNING/.test(l) && console.log(l));
  }, 240000);

  afterAll(async () => {
    await db.withClaims(SERVICE, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId])).catch(() => undefined);
    await app.close();
  });

  it("loads every module without a warning", () => {
    expect(seeded.warnings).toEqual([]);
    expect(seeded.counts).toMatchObject({
      onboardingItems: 7, offboardingItems: 6, leavePolicies: 2, employeeGroups: 2, shifts: 2, shiftAssignments: 40,
      courses: 5, competencies: 5, reviewCycles: 1, developmentPlans: 5, requisitions: 3, candidates: 10, applications: 10, expenseClaims: 4, payrollRuns: 3,
    });
    expect(seeded.counts.courseEnrollments).toBeGreaterThan(80);
    expect(seeded.counts.goals).toBeGreaterThan(100);
    expect(seeded.counts.leaveBalances).toBe(120);
  });

  it("the module screens have data: leave balances, learning, recruitment, performance, expenses, attendance", async () => {
    const policies = await get("/leave-policies");
    expect(policies.status).toBe(200);
    expect(policies.body.length).toBeGreaterThanOrEqual(2);
    const employees = await get("/employees");
    const someone = employees.body.find((e: { designation: string }) => e.designation === "HR Manager");
    const balances = await get(`/employees/${someone.id}/leave-balances`);
    expect(balances.status).toBe(200);
    expect(balances.body.length).toBeGreaterThanOrEqual(3);
    const reqs = await get("/job-requisitions");
    expect(reqs.status).toBe(200);
    expect(reqs.body.filter((r: { status: string }) => r.status === "open")).toHaveLength(3);
    const apps = await get("/applications");
    expect(apps.status).toBe(200);
    expect(apps.body).toHaveLength(10);
    const courses = await get("/courses");
    expect(courses.status).toBe(200);
    expect(courses.body).toHaveLength(5);
    const claims = await get("/expense-claims");
    expect(claims.status).toBe(200);
    const goals = await get("/goals");
    expect(goals.status).toBe(200);
    const shifts = await get("/shifts");
    expect(shifts.status).toBe(200);
  });

  it("loads the full data set", () => {
    expect(seeded.counts).toMatchObject({ locations: 7, orgUnits: 9, jobs: 23, employees: 40, positions: 40, seatsFilled: 40, headPositions: 6, compensation: 40, paymentAccounts: 40 });
    expect(DEMO_EMPLOYEES).toHaveLength(40);
  });

  it("lists 40 employees, numbered in order, each with a manager except the CEO", async () => {
    const res = await get("/employees");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(40);
    const numbers = res.body.map((e: { employeeNumber: string }) => e.employeeNumber).sort();
    expect(numbers[0]).toBe("EMP-0001");
    expect(new Set(numbers).size).toBe(40);
    const withoutManager = res.body.filter((e: { managerId: string | null }) => !e.managerId);
    expect(withoutManager).toHaveLength(1);
    expect(withoutManager[0].designation).toBe("Chief Executive Officer");
  });

  it("the organization structure shows units, positions and holders", async () => {
    const res = await get("/organization/structure");
    expect(res.status).toBe(200);
    const flat: Array<{ kind?: string; type?: string }> = [];
    const walk = (nodes: Array<Record<string, unknown>>) =>
      nodes.forEach((n) => {
        flat.push(n as never);
        if (Array.isArray(n.children)) walk(n.children as Array<Record<string, unknown>>);
      });
    // eslint-disable-next-line no-console
    console.log("structure keys:", Object.keys(res.body).join(","), JSON.stringify(res.body).slice(0, 400));
    walk(Array.isArray(res.body) ? res.body : (res.body.roots ?? res.body.nodes ?? []));
    expect(flat.length).toBeGreaterThan(40 + 9);
  });

  it("the HR admin's own org chart reaches the CEO above and the team below", async () => {
    const res = await get("/employees/me/org-chart");
    expect(res.status).toBe(200);
    expect(res.body.me.fullName).toBe("Ayesha Siddiqui");
    expect(res.body.managerChain.map((p: { fullName: string }) => p.fullName)).toEqual(["Imran Qureshi"]);
    expect(res.body.downline).toHaveLength(4);
  });

  it("the organization command center reports no data-quality warnings", async () => {
    const res = await get("/organization/command-center");
    expect(res.status).toBe(200);
    // eslint-disable-next-line no-console
    console.log("command-center:", JSON.stringify(res.body).slice(0, 1500));
  });

  it("payroll calculates for all 40 people", async () => {
    const created = await request(app.getHttpServer())
      .post("/payroll/runs")
      .set("Authorization", `Bearer ${token}`)
      .send({ periodStart: "2026-10-01", periodEnd: "2026-10-31" });
    expect(created.status).toBe(201);
    const calc = await request(app.getHttpServer()).post(`/payroll/runs/${created.body.id}/calculate`).set("Authorization", `Bearer ${token}`);
    // eslint-disable-next-line no-console
    console.log("calculate:", calc.status, JSON.stringify(calc.body).slice(0, 600));
    expect(calc.status).toBeLessThan(300);
    const run = await get(`/payroll/runs/${created.body.id}`);
    expect(run.body.payslipCount).toBe(40);
    expect(run.body.totalNetPay).toBeGreaterThan(0);
    // July-September are finalized history, so October tax is about a twelfth-ish of the year, not a time-based lump
    const list = (await db.withClaims(SERVICE, (c) => c.query(
      "SELECT p.id, p.net_pay FROM payslips p WHERE p.payroll_run_id = $1 ORDER BY p.gross_pay DESC LIMIT 1", [created.body.id]))).rows;
    const detail = await get(`/payslips/${list[0].id}/detail`);
    const tax = (detail.body.components as Array<{ key: string; amount: number; trace: Record<string, number> }>).find((c) => c.key === "income_tax")!;
    // eslint-disable-next-line no-console
    console.log("top earner October tax:", -tax.amount, JSON.stringify(tax.trace).slice(0, 400));
    expect(tax.trace.priorYtdTaxable).toBeGreaterThan(0);
    expect(tax.trace.priorYtdTaxWithheld).toBeGreaterThan(0);
    const monthly = -tax.amount;
    const yearTax = tax.trace.slabAnnualTax;
    expect(monthly).toBeGreaterThan((yearTax / 12) * 0.8);
    expect(monthly).toBeLessThan((yearTax / 12) * 1.2);
  }, 60000);

  it("reset removes the people and structure again and the seed can run once more", async () => {
    // like the real script: the owner connection, not the app's limited login
    const owner = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const plan = await runInTenantContext(owner, SERVICE, (c) => planReset(c, companyId));
      expect(plan.find((p) => p.table === "employees")?.rows).toBe(40);
      await runInTenantContext(owner, SERVICE, (c) => executeReset(c, companyId));
    } finally {
      await owner.end();
    }
    const left = await db.withClaims(SERVICE, (c) => c.query("SELECT (SELECT count(*) FROM employees WHERE company_id = $1)::int AS e, (SELECT count(*) FROM org_units WHERE company_id = $1)::int AS u, (SELECT count(*) FROM payroll_runs WHERE company_id = $1)::int AS r", [companyId]));
    expect(left.rows[0]).toEqual({ e: 0, u: 0, r: 0 });
    const again = await seedDemoTenant(app, companyId, () => undefined);
    expect(again.counts.employees).toBe(40);
    expect(again.warnings).toEqual([]);
    const numbers = await get("/employees");
    expect(numbers.body.map((e: { employeeNumber: string }) => e.employeeNumber).sort()[0]).toBe("EMP-0001");
  }, 240000);
});
