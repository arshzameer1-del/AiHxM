import { Pool, type PoolClient } from "pg";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { ReportsService } from "./reports.service";
import { DataQualitySnapshotService } from "./quality/data-quality-snapshot.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "report-depth-spec-fixtures" };

/** L03, L06, I05 and M14: reports that became possible once the product recorded the data behind them. Real Postgres. */
describe("Report depth: mandatory training, training cost, payslip access, data quality trend", () => {
  let pool: Pool;
  let db: DatabaseService;
  let reports: ReportsService;
  let snapshots: DataQualitySnapshotService;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let a: string;
  let b: string;
  let hr: RequestClaims;
  let hrB: RequestClaims;
  let today: string;
  const fx = <T>(fn: (c: PoolClient) => Promise<T>) => db.withClaims(FIXTURE, fn);
  const day = (offset: number): string => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const emp: string[] = [];
  const slip: string[] = [];

  async function makeUser(client: PoolClient, companyId: string, tag: string): Promise<RequestClaims> {
    const u = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`depth-${tag}-${stamp}@example.com`]);
    const role = await client.query("SELECT id FROM roles WHERE key = 'hr_admin'");
    await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, companyId, role.rows[0].id]);
    return { is_platform_admin: false, company_id: companyId, sub: u.rows[0].id };
  }
  async function makeEmployee(client: PoolClient, companyId: string, n: string, o: { email?: string | null; phone?: string | null } = {}): Promise<string> {
    const p = await client.query("INSERT INTO persons (company_id, full_name) VALUES ($1, $2) RETURNING id", [companyId, `Person ${n}`]);
    const e = await client.query(
      `INSERT INTO employees (company_id, employee_number, first_name, last_name, person_id, employment_status, date_of_joining, email, phone)
       VALUES ($1, $2, 'T', $3, $4, 'active', $5, $6, $7) RETURNING id`,
      [companyId, `D-${n}-${stamp}`.slice(0, 30), `Emp${n}`, p.rows[0].id, day(-200), o.email ?? null, o.phone ?? null]
    );
    return e.rows[0].id as string;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    reports = new ReportsService(db, new RbacService(db), new EntitlementsService(db), new AuditService());
    snapshots = new DataQualitySnapshotService(db);
    today = (await fx((cl) => cl.query("SELECT ((now() AT TIME ZONE 'Asia/Karachi')::date)::text AS d"))).rows[0].d;
    await fx(async (client) => {
      const mk = async (label: string) => {
        const modules = ["employee", "leave", "payroll", "learning"];
        const r = await client.query("INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, 'Asia/Karachi') RETURNING id", [`Depth ${label} ${stamp}`, `depth-${label}-${stamp}`.toLowerCase()]);
        await client.query("INSERT INTO company_config (company_id, enabled_modules) VALUES ($1, $2::jsonb)", [r.rows[0].id, JSON.stringify(modules)]);
        for (const m of modules) await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, $2, true)", [r.rows[0].id, m]);
        return r.rows[0].id as string;
      };
      a = await mk("a");
      b = await mk("b");
      hr = await makeUser(client, a, "hr");
      hrB = await makeUser(client, b, "hrb");
      // four people; two have email, one of those also a phone
      emp.push(await makeEmployee(client, a, "1", { email: "a@example.com", phone: "0300" }));
      emp.push(await makeEmployee(client, a, "2", { email: "b@example.com" }));
      emp.push(await makeEmployee(client, a, "3"));
      emp.push(await makeEmployee(client, a, "4"));
      await makeEmployee(client, b, "b1", { email: "z@example.com" });

      // courses: one mandatory costing 5000 (paid for by 3 enrolments), one optional with no cost, one inactive mandatory (ignored)
      const course = async (title: string, mandatory: boolean, cost: number | null, active = true) =>
        (await client.query("INSERT INTO courses (company_id, title, category, duration_minutes, is_mandatory, cost_amount, is_active) VALUES ($1,$2,'compliance',60,$3,$4,$5) RETURNING id", [a, title, mandatory, cost, active])).rows[0].id as string;
      const safety = await course("Fire safety", true, 5000);
      const optional = await course("Excel basics", false, null);
      await course("Retired induction", true, 100, false);
      const enrol = (e: string, c: string, status: string, due: string | null) =>
        client.query(
          `INSERT INTO course_enrollments (company_id, employee_id, course_id, status, progress_percent, due_date, completed_at) VALUES ($1,$2,$3,$4,0,$5, CASE WHEN $4 = 'completed' THEN now() ELSE NULL END)`,
          [a, e, c, status, due]
        );
      await enrol(emp[0], safety, "completed", null);
      await enrol(emp[1], safety, "in_progress", day(-5)); // past due
      await enrol(emp[2], safety, "assigned", day(10));
      // emp[3] is not enrolled in the mandatory course at all
      await enrol(emp[0], optional, "completed", null);

      const run = (await client.query(
        "INSERT INTO payroll_runs (company_id, period_start, period_end, status, created_by_user_account_id, population_count, calculated_count, failed_count) VALUES ($1,$2,$3,'finalized',$4,3,3,0) RETURNING id",
        [a, day(-30), day(-1), hr.sub]
      )).rows[0].id;
      for (const e of emp.slice(0, 3)) {
        const r = await client.query(
          `INSERT INTO payslips (company_id, payroll_run_id, employee_id, employee_number, days_in_period, paid_days, unpaid_leave_days, gross_pay, taxable_annual_income, income_tax_monthly,
             eobi_employee_contribution, eobi_employer_contribution, net_pay, calculation_breakdown, status) VALUES ($1,$2,$3,$4,30,30,0,100000,100000,1000,370,1850,90000,'{}'::jsonb,'final') RETURNING id`,
          [a, run, e, `P-${e.slice(0, 5)}`]
        );
        slip.push(r.rows[0].id);
      }
      // employee 1 opened their payslip twice, employee 2 once; employee 3 never. A third party (the HR admin) opening does not count as the employee.
      const viewer = (await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`depth-viewer-${stamp}@example.com`])).rows[0].id;
      for (const [i, n] of [[0, 2], [1, 1]] as const) {
        for (let k = 0; k < n; k++) {
          await client.query("INSERT INTO payslip_access_log (company_id, employee_id, payslip_id, kind, viewer_user_account_id, created_at) VALUES ($1,$2,$3,'payslip',$4, now() - ($5 || ' hours')::interval)", [a, emp[i], slip[i], viewer, String(k)]);
        }
      }
    });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  const kpi = (r: { kpis: { key: string; value: number | null }[] }, key: string) => r.kpis.find((k) => k.key === key)?.value;

  it("L03 measures every current employee against each active mandatory course and ignores optional and inactive ones", async () => {
    const r = await reports.run(hr, "L03", {});
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ course: "Fire safety", required: 4, completed: 1, inProgress: 1, notStarted: 1, notAssigned: 1, overdue: 1, compliance: 25 });
    expect(kpi(r, "overall")).toBe(25);
    expect(kpi(r, "overdue")).toBe(1);
  });

  it("L03 says so when no course is mandatory", async () => {
    const r = await reports.run(hrB, "L03", {});
    expect(r.rows).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/Mandatory/);
  });

  it("L06 totals enrolments times the recorded cost and refuses to guess for courses with none", async () => {
    const r = await reports.run(hr, "L06", {});
    const fire = r.rows.find((x) => x.course === "Fire safety");
    const excel = r.rows.find((x) => x.course === "Excel basics");
    expect(fire).toMatchObject({ enrolled: 3, completed: 1, costEach: 5000, totalCost: 15000, completedCost: 5000 });
    expect(excel).toMatchObject({ enrolled: 1, costEach: null, totalCost: null });
    expect(kpi(r, "total")).toBe(15000);
    expect(kpi(r, "uncosted")).toBe(1);
    expect(r.notes.join(" ")).toMatch(/no cost recorded/);
  });

  it("I05 counts a finalised payslip as opened when the employee opened it, and totals the opens", async () => {
    const r = await reports.run(hr, "I05", {});
    const row = r.rows.find((x) => Number(x.payslips) > 0);
    expect(row).toMatchObject({ payslips: 3, opened: 2, opens: 3 });
    expect(Number(row?.openRate)).toBeCloseTo(66.7, 1);
    expect(kpi(r, "opens")).toBe(3);
  });

  it("I05 never shows another company's opens", async () => {
    const r = await reports.run(hrB, "I05", {});
    expect(r.rows.every((x) => Number(x.payslips) === 0 && Number(x.opens) === 0)).toBe(true);
  });

  it("M14 builds its trend from snapshots: four employees, email filled for two, phone for one", async () => {
    await snapshots.captureCompany(a);
    await snapshots.captureCompany(a); // the same day replaces itself
    const rows = (await fx((c) => c.query("SELECT field, total, filled FROM data_quality_snapshots WHERE company_id = $1 ORDER BY field_order", [a]))).rows;
    expect(rows).toHaveLength(9);
    expect(rows.find((x) => x.field === "Email address")).toMatchObject({ total: 4, filled: 2 });
    expect(rows.find((x) => x.field === "Phone number")).toMatchObject({ total: 4, filled: 1 });

    const r = await reports.run(hr, "M14", {});
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ employees: 4, snapshot: today });
    // the A14 report agrees with the snapshot for the same moment
    const a14 = await reports.run(hr, "A14", {});
    const avg = a14.rows.reduce((s, x) => s + Number(x.completeness), 0) / a14.rows.length;
    expect(Number(r.rows[0].completeness)).toBeCloseTo(avg, 0);
    expect(["Phone number", "Date of birth", "National ID (CNIC)", "Address on file", "Organisation unit", "Position", "Work location", "Reporting manager"]).toContain(r.rows[0].weakest);
  });

  it("M14 for a company with no snapshot yet explains why it is empty", async () => {
    const r = await reports.run(hrB, "M14", {});
    expect(r.rows).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/snapshot/i);
  });
});
