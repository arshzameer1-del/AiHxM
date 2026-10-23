import { Pool, type PoolClient } from "pg";
import { ForbiddenException } from "@nestjs/common";
import { MODULE_KEYS, type ReportResult } from "@aihxm/shared-types";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { ReportsService } from "./reports.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "reports-core-fixtures" };
const TODAY = "(now() AT TIME ZONE 'Asia/Karachi')::date";

/**
 * Workforce, recruitment, attendance, leave, payroll and performance reports, each figure worked out by hand from the rows
 * this spec inserts, plus the three protections the figures rely on: payroll-area scope, small-group suppression and the
 * refusal to run sensitive reports without the sensitive grant.
 *
 * People (company time = Asia/Karachi):
 *   E1 active, joined 400 days ago, Engineering, Lahore, permanent, male   (manager of E2 and E3)
 *   E2 active, joined 20 days ago,  Engineering, Lahore, contract,  female
 *   E3 active, joined 100 days ago, Sales,       Karachi, permanent, male
 *   E7 active, joined 50 days ago,  Sales,       Karachi, permanent, female
 *   E8 active, joined 50 days ago,  Sales,       Karachi, permanent, male
 *   E4 terminated 10 days ago, E5 terminated with no date, E6 joins in 5 days.
 * Headcount today is E1, E2, E3, E7, E8 = 5.
 */
describe("core report domains (hand-computed)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let reports: ReportsService;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let co: string;
  let ouEng: string;
  let all: RequestClaims;
  let mgr: RequestClaims;
  let scoped: RequestClaims;
  const fx = <T>(fn: (client: PoolClient) => Promise<T>) => db.withClaims(FIXTURE, fn);

  const run = async (claims: RequestClaims, id: string, filters: Record<string, unknown> = {}): Promise<ReportResult> => {
    const r = await reports.run(claims, id, filters);
    for (const row of r.rows) for (const c of r.columns) expect(c.key in row).toBe(true);
    return r;
  };
  const kpi = (r: ReportResult, key: string) => r.kpis.find((k) => k.key === key)?.value;
  const rowBy = (r: ReportResult, key: string, value: string | number) => r.rows.find((x) => x[key] === value);
  const ymd = async (offset: number) => (await fx((c) => c.query<{ d: string }>(`SELECT (${TODAY} + $1::int)::text AS d`, [offset]))).rows[0].d;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    reports = new ReportsService(db, new RbacService(db), new EntitlementsService(db), new AuditService());
    await fx(async (client) => {
      const c = await client.query("INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, 'Asia/Karachi') RETURNING id", [`Core ${stamp}`, `core-${stamp}`.toLowerCase()]);
      co = c.rows[0].id;
      await client.query("INSERT INTO company_config (company_id, enabled_modules) VALUES ($1, $2::jsonb)", [co, JSON.stringify(MODULE_KEYS)]);
      for (const m of MODULE_KEYS) await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, $2, true)", [co, m]);

      const allRole = await client.query("INSERT INTO roles (key, name) VALUES ($1, 'Core all') RETURNING id", [`core_all_${stamp}`]);
      await client.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions", [allRole.rows[0].id]);
      const scopedRole = await client.query("INSERT INTO roles (key, name) VALUES ($1, 'Core scoped payroll') RETURNING id", [`core_scoped_${stamp}`]);
      await client.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key IN ('reports.view', 'payroll.calculate.scoped')", [scopedRole.rows[0].id]);
      const lm = await client.query("SELECT id FROM roles WHERE key = 'line_manager'");
      const mkUser = async (tag: string, roleId: string) => {
        const u = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`core-${tag}-${stamp}@example.com`]);
        await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, co, roleId]);
        return u.rows[0].id as string;
      };
      const allUser = await mkUser("all", allRole.rows[0].id);
      const mgrUser = await mkUser("mgr", lm.rows[0].id);
      const scopedUser = await mkUser("scoped", scopedRole.rows[0].id);
      all = { is_platform_admin: false, company_id: co, sub: allUser };
      mgr = { is_platform_admin: false, company_id: co, sub: mgrUser };
      scoped = { is_platform_admin: false, company_id: co, sub: scopedUser };

      ouEng = (await client.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', 'Engineering') RETURNING id", [co])).rows[0].id;
      const ouSales = (await client.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', 'Sales') RETURNING id", [co])).rows[0].id;
      const lahore = (await client.query("INSERT INTO locations (company_id, location_type, name) VALUES ($1, 'city', 'Lahore') RETURNING id", [co])).rows[0].id;
      const karachi = (await client.query("INSERT INTO locations (company_id, location_type, name) VALUES ($1, 'city', 'Karachi') RETURNING id", [co])).rows[0].id;

      const emp = async (n: string, o: { joined: number; status?: string; term?: number | null; ou: string; loc: string; type: string; gender: string; user?: string | null }) => {
        const p = await client.query("INSERT INTO persons (company_id, full_name) VALUES ($1, $2) RETURNING id", [co, `Person ${n}`]);
        const r = await client.query(
          `INSERT INTO employees (company_id, employee_number, first_name, last_name, person_id, employment_status, date_of_joining, termination_date, org_unit_id, location_id, employment_type, gender, user_account_id)
           VALUES ($1, $2, 'Core', $3, $4, $5, ${TODAY} + $6::int, CASE WHEN $7::int IS NULL THEN NULL ELSE ${TODAY} + $7::int END, $8, $9, $10, $11, $12) RETURNING id`,
          [co, `C-${n}-${stamp}`.slice(0, 30), `Emp${n}`, p.rows[0].id, o.status ?? "active", o.joined, o.term ?? null, o.ou, o.loc, o.type, o.gender, o.user ?? null]
        );
        return r.rows[0].id as string;
      };
      const e1 = await emp("1", { joined: -400, ou: ouEng, loc: lahore, type: "permanent", gender: "male", user: mgrUser });
      const e2 = await emp("2", { joined: -20, ou: ouEng, loc: lahore, type: "contract", gender: "female" });
      const e3 = await emp("3", { joined: -100, ou: ouSales, loc: karachi, type: "permanent", gender: "male" });
      const e7 = await emp("7", { joined: -50, ou: ouSales, loc: karachi, type: "permanent", gender: "female" });
      const e8 = await emp("8", { joined: -50, ou: ouSales, loc: karachi, type: "permanent", gender: "male" });
      await emp("4", { joined: -300, status: "terminated", term: -10, ou: ouSales, loc: karachi, type: "permanent", gender: "male" });
      await emp("5", { joined: -300, status: "terminated", term: null, ou: ouSales, loc: karachi, type: "permanent", gender: "male" });
      const e6 = await emp("6", { joined: 5, ou: ouSales, loc: karachi, type: "permanent", gender: "male" });
      for (const e of [e2, e3]) await client.query("INSERT INTO org_relationships (company_id, employee_id, manager_employee_id, relationship_type) VALUES ($1, $2, $3, 'direct')", [co, e, e1]);

      // ---------------- attendance: three evaluated days for E1, E2, E3 and one open punch
      const day = (o: number) => `${TODAY} + ${o}`;
      const res = (emp: string, offset: number, status: string) =>
        client.query(`INSERT INTO attendance_daily_results (company_id, employee_id, work_date, status) VALUES ($1, $2, ${day(offset)}, $3)`, [co, emp, status]);
      await res(e1, -3, "present");
      await res(e2, -3, "late");
      await res(e3, -3, "absent");
      await res(e1, -2, "present");
      await res(e2, -2, "on_leave");
      await res(e3, -2, "present");
      await res(e1, -1, "holiday");
      await client.query(
        `INSERT INTO attendance_records (company_id, employee_id, employee_number, source, clock_in_at, work_date) VALUES ($1, $2, 'C-3', 'manual', now() - interval '4 days', ${day(-4)}), ($1, $3, 'C-1', 'manual', now() - interval '1 hour', ${TODAY})`,
        [co, e3, e1]
      );

      // ---------------- leave: balances for this year and four requests
      const year = `EXTRACT(year FROM ${TODAY})::int`;
      await client.query(
        `INSERT INTO leave_balances (company_id, employee_id, leave_type, year, entitled_days, used_days) VALUES
           ($1, $2, 'annual', ${year}, 20, 5), ($1, $3, 'annual', ${year}, 20, 25), ($1, $4, 'sick', ${year}, 10, 0)`,
        [co, e2, e3, e1]
      );
      const lr = (emp: string, type: string, from: number, to: number, days: number, status: string) =>
        client.query(`INSERT INTO leave_requests (company_id, employee_id, leave_type, start_date, end_date, days_requested, status, submitted_by_user_account_id) VALUES ($1, $2, $3, ${day(from)}, ${day(to)}, $4, $5, $6)`, [co, emp, type, days, status, allUser]);
      await lr(e2, "annual", -10, -9, 2, "approved");
      await lr(e3, "annual", -20, -20, 1, "approved");
      await lr(e2, "sick", -3, -3, 1, "pending");
      await lr(e3, "annual", -5, -5, 1, "rejected");

      // ---------------- recruitment: four requisitions
      const req = (title: string, status: string, headcount: number, filled: number, org: string | null) =>
        client.query("INSERT INTO job_requisitions (company_id, title, headcount, status, filled_headcount, org_unit_id, created_by_user_account_id) VALUES ($1, $2, $3, $4, $5, $6, $7)", [co, title, headcount, status, filled, org, allUser]);
      await req("Backend engineer", "open", 3, 1, ouEng);
      await req("Sales rep", "open", 1, 0, ouSales);
      await req("Designer", "filled", 2, 2, ouEng);
      await req("Analyst", "draft", 1, 0, null);

      // ---------------- performance: one cycle, five released ratings (5, 4, 4, 3, 2) and one pending review
      const cycle = (
        await client.query(`INSERT INTO review_cycles (company_id, name, period_start, period_end, status, created_by_user_account_id) VALUES ($1, 'H1 review', ${day(-60)}, ${day(30)}, 'active', $2) RETURNING id`, [co, allUser])
      ).rows[0].id;
      const review = (emp: string, status: string, rating: number | null) =>
        client.query(`INSERT INTO performance_reviews (company_id, review_cycle_id, employee_id, status, final_rating, released_at) VALUES ($1, $2, $3, $4, $5, CASE WHEN $5::int IS NULL THEN NULL ELSE now() END)`, [co, cycle, emp, status, rating]);
      await review(e1, "released", 5);
      await review(e2, "released", 4);
      await review(e3, "released", 4);
      await review(e7, "released", 3);
      await review(e8, "released", 2);
      await review(e6, "pending", null);

      // ---------------- payroll: two areas; area A finalised with two payslips, area B calculated with 2 failures, one company-wide run
      const areaA = (await client.query("INSERT INTO payroll_areas (company_id, code, name) VALUES ($1, 'PA', 'Area A') RETURNING id", [co])).rows[0].id;
      const areaB = (await client.query("INSERT INTO payroll_areas (company_id, code, name) VALUES ($1, 'PB', 'Area B') RETURNING id", [co])).rows[0].id;
      await client.query("INSERT INTO data_scope_assignments (user_account_id, company_id, scope_type, scope_entity_id, include_descendants) VALUES ($1, $2, 'payroll_area', $3, true)", [scopedUser, co, areaA]);
      const prun = async (area: string | null, status: string, failed: number) =>
        (
          await client.query(
            `INSERT INTO payroll_runs (company_id, period_start, period_end, status, payroll_area_id, population_count, calculated_count, failed_count, created_by_user_account_id)
             VALUES ($1, ${day(-40)}, ${day(-10)}, $2, $3, 2, $4, $5, $6) RETURNING id`,
            [co, status, area, 2 - failed, failed, allUser]
          )
        ).rows[0].id as string;
      const runA = await prun(areaA, "finalized", 0);
      await prun(areaB, "calculated", 2);
      await prun(null, "finalized", 0);
      const slip = (emp: string, no: string, gross: number, tax: number, eobi: number, net: number, cost: number) =>
        client.query(
          `INSERT INTO payslips (company_id, payroll_run_id, employee_id, employee_number, days_in_period, paid_days, taxable_annual_income, gross_pay, income_tax_monthly, eobi_employee_contribution, eobi_employer_contribution, net_pay, employer_cost, status, calculation_breakdown)
           VALUES ($1, $2, $3, $4, 30, 30, $5 * 12, $5, $6, $7, 1000, $8, $9, 'final', '{}'::jsonb)`,
          [co, runA, emp, no, gross, tax, eobi, net, cost]
        );
      await slip(e1, "C-1", 100000, 5000, 370, 94630, 105000);
      await slip(e2, "C-2", 50000, 0, 370, 49630, 55000);
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  // ---------------------------------------------------------------- workforce
  describe("workforce", () => {
    it("A03 counts 5 current people: Sales 3 and Engineering 2, and says one future joiner is not counted", async () => {
      const r = await run(all, "A03");
      expect(kpi(r, "headcount")).toBe(5);
      expect(rowBy(r, "label", "Sales")).toMatchObject({ headcount: 3, share: 60 });
      expect(rowBy(r, "label", "Engineering")).toMatchObject({ headcount: 2, share: 40 });
      expect(r.notes.join(" ")).toMatch(/1 employee has a joining date in the future/);
    });

    it("A05: 4 permanent and 1 contract", async () => {
      const r = await run(all, "A05");
      expect(rowBy(r, "label", "Permanent")).toMatchObject({ headcount: 4, share: 80 });
      expect(rowBy(r, "label", "Contract")).toMatchObject({ headcount: 1, share: 20 });
    });

    it("A06: 6 working (the future joiner counts as working), 2 left, 75% still working", async () => {
      const r = await run(all, "A06");
      expect(kpi(r, "working")).toBe(6);
      expect(kpi(r, "left")).toBe(2);
      expect(kpi(r, "workingShare")).toBe(75);
    });

    it("A11 never shows a group under 5 people: male 3 and female 2 are combined into one group of 5", async () => {
      const r = await run(all, "A11");
      const gender = r.rows.filter((x) => x.dimension === "Gender");
      expect(gender).toHaveLength(1);
      expect(gender[0]).toMatchObject({ label: "Other (groups under 5 combined)", n: 5, share: 100 });
      expect(JSON.stringify(r.rows)).not.toMatch(/"label":"Male"|"label":"Female"/);
    });

    it("B01 lists the 5 current people and carries no contact, ID, bank or pay field", async () => {
      const r = await run(all, "B01");
      expect(kpi(r, "rows")).toBe(5);
      expect(r.rows).toHaveLength(5);
      expect(r.columns.map((c) => c.key).join(" ")).not.toMatch(/cnic|email|phone|salary|bank|birth|gross|net/i);
      expect(JSON.stringify(r.rows)).not.toMatch(/@example\.com/);
    });

    it("team scope: a manager's A03 covers only the two people reporting to E1", async () => {
      const r = await run(mgr, "A03");
      expect(r.scope).toBe("team");
      expect(kpi(r, "headcount")).toBe(2);
      expect(rowBy(r, "label", "Engineering")).toMatchObject({ headcount: 1 });
      expect(rowBy(r, "label", "Sales")).toMatchObject({ headcount: 1 });
    });
  });

  // ---------------------------------------------------------------- recruitment
  describe("recruitment", () => {
    it("C01: 4 requisitions, 2 open asking for 4 with 1 filled; 7 openings and 3 filled in all", async () => {
      const r = await run(all, "C01");
      expect(rowBy(r, "status", "Open")).toMatchObject({ requisitions: 2, headcount: 4, filled: 1, share: 50 });
      expect(rowBy(r, "status", "Filled")).toMatchObject({ requisitions: 1, headcount: 2, filled: 2, share: 25 });
      expect(rowBy(r, "status", "Draft")).toMatchObject({ requisitions: 1, headcount: 1, filled: 0, share: 25 });
      expect(kpi(r, "total")).toBe(4);
      expect(kpi(r, "headcount")).toBe(7);
      expect(kpi(r, "filled")).toBe(3);
    });

    it("C01 for Engineering alone counts its 2 requisitions", async () => {
      const r = await run(all, "C01", { department: ouEng });
      expect(kpi(r, "total")).toBe(2);
      expect(kpi(r, "headcount")).toBe(5);
    });
  });

  // ---------------------------------------------------------------- attendance
  describe("attendance", () => {
    it("D01 day by day: 3 days ago 2 attended (1 late) and 1 absent; 2 days ago 2 attended and 1 on leave; a holiday expects nobody", async () => {
      const r = await run(all, "D01", { dateFrom: await ymd(-5), dateTo: await ymd(0) });
      const d3 = rowBy(r, "date", await ymd(-3));
      expect(d3).toMatchObject({ expected: 3, attended: 2, late: 1, absent: 1, onLeave: 0, rate: 66.7 });
      const d2 = rowBy(r, "date", await ymd(-2));
      expect(d2).toMatchObject({ expected: 3, attended: 2, late: 0, absent: 0, onLeave: 1, rate: 100 });
      const d1 = rowBy(r, "date", await ymd(-1));
      expect(d1).toMatchObject({ expected: 0, attended: 0 });
      expect(d1?.rate).toBeNull();
      expect(kpi(r, "attended")).toBe(4);
      expect(kpi(r, "absent")).toBe(1);
      expect(kpi(r, "late")).toBe(1);
      expect(kpi(r, "rate")).toBe(80);
    });

    it("D06 lists the past clock-in with no clock-out and ignores today's open punch", async () => {
      const r = await run(all, "D06", { dateFrom: await ymd(-10), dateTo: await ymd(0) });
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ issue: "Clock-out missing", date: await ymd(-4) });
      expect(kpi(r, "clockOut")).toBe(1);
    });

    it("a manager's D01 covers only their team: E2 and E3, so 2 attended and 1 absent three days ago", async () => {
      const r = await run(mgr, "D01", { dateFrom: await ymd(-5), dateTo: await ymd(0) });
      expect(rowBy(r, "date", await ymd(-3))).toMatchObject({ expected: 2, attended: 1, late: 1, absent: 1 });
    });
  });

  // ---------------------------------------------------------------- leave
  describe("leave", () => {
    it("E01: Annual leave has 2 people, 40 entitled, 30 used, 10 left (75% used) and 1 over their balance; Sick leave has 10 left", async () => {
      const r = await run(all, "E01");
      expect(rowBy(r, "type", "Annual leave")).toMatchObject({ people: 2, entitled: 40, used: 30, remaining: 10, utilisation: 75, negative: 1 });
      expect(rowBy(r, "type", "Sick leave")).toMatchObject({ people: 1, entitled: 10, used: 0, remaining: 10 });
      expect(kpi(r, "remaining")).toBe(20);
      expect(kpi(r, "used")).toBe(60);
      expect(kpi(r, "negative")).toBe(1);
    });

    it("E03: 4 requests, 1 waiting, and an approval rate of 2 of the 3 decided (66.7%)", async () => {
      const r = await run(all, "E03", { dateFrom: await ymd(-30), dateTo: await ymd(0) });
      expect(kpi(r, "total")).toBe(4);
      expect(kpi(r, "pending")).toBe(1);
      expect(kpi(r, "approvalRate")).toBe(66.7);
    });
  });

  // ---------------------------------------------------------------- performance
  describe("performance", () => {
    it("G01: one cycle with 6 reviews, 5 released and 1 not started", async () => {
      const r = await run(all, "G01");
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ cycle: "H1 review", reviews: 6, pending: 1, released: 5 });
    });

    it("G07: 5 rated people give 0, 1, 1, 2, 1 at ratings 1 to 5 and an average of 3.6", async () => {
      const r = await run(all, "G07");
      expect(r.rows.map((x) => x.people)).toEqual([0, 1, 1, 2, 1]);
      expect(rowBy(r, "rating", "4")).toMatchObject({ people: 2, share: 40 });
      expect(kpi(r, "rated")).toBe(5);
      expect(kpi(r, "avg")).toBe(3.6);
    });

    it("G07 for Engineering alone (2 people rated) is withheld, with a note, instead of exposing two individuals", async () => {
      const r = await run(all, "G07", { department: ouEng });
      expect(r.rows).toHaveLength(0);
      expect(kpi(r, "rated")).toBe(2);
      expect(r.notes.join(" ")).toMatch(/Only 2 people have a rating/);
    });

    it("a manager cannot open the sensitive rating distribution", async () => {
      await expect(reports.run(mgr, "G07", {})).rejects.toThrow(ForbiddenException);
    });
  });

  // ---------------------------------------------------------------- payroll
  describe("payroll", () => {
    it("F01 for a payroll user with every area: 3 runs, 1 still in progress, 1 with failures", async () => {
      const r = await run(all, "F01", { dateFrom: await ymd(-60), dateTo: await ymd(0) });
      expect(kpi(r, "runs")).toBe(3);
      expect(kpi(r, "inProgress")).toBe(1);
      expect(kpi(r, "problems")).toBe(1);
      expect(kpi(r, "share")).toBe(66.7);
    });

    it("F01 for a user scoped to Area A sees that one finalised run, not Area B and not the company-wide run", async () => {
      const r = await run(scoped, "F01", { dateFrom: await ymd(-60), dateTo: await ymd(0) });
      expect(r.scope).toBe("scoped");
      expect(kpi(r, "runs")).toBe(1);
      expect(kpi(r, "inProgress")).toBe(0);
      expect(kpi(r, "problems")).toBe(0);
    });

    it("F05 adds the two payslips of the finalised run: net 94,630 + 49,630 = 144,260, average 72,130", async () => {
      const r = await run(all, "F05", { dateFrom: await ymd(-60), dateTo: await ymd(0) });
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ employees: 2, total: 144260, avg: 72130, median: 72130, zeroOrLess: 0 });
      expect(kpi(r, "total")).toBe(144260);
    });

    it("F02 lists both payslips with their gross, tax and net, and works out 'other deductions' as the remainder", async () => {
      const r = await run(all, "F02", { dateFrom: await ymd(-60), dateTo: await ymd(0) });
      expect(r.rows).toHaveLength(2);
      const e1 = r.rows.find((x) => String(x.number).startsWith("C-1"));
      expect(e1).toMatchObject({ gross: 100000, tax: 5000, eobi: 370, other: 0, net: 94630, employerCost: 105000 });
    });

    it("a user scoped to payroll areas cannot run money reports: sensitive and restricted need their own grant", async () => {
      await expect(reports.run(scoped, "F05", {})).rejects.toThrow(ForbiddenException);
      await expect(reports.run(scoped, "F02", {})).rejects.toThrow(ForbiddenException);
    });

    it("the catalog a scoped user sees holds no sensitive or restricted payroll report", async () => {
      const cat = await reports.catalog(scoped);
      const payroll = cat.entries.filter((e) => e.categoryKey === "F" || e.categoryKey === "K");
      expect(payroll.length).toBeGreaterThan(0);
      expect(payroll.every((e) => e.sensitivity === "standard" || e.sensitivity === "internal")).toBe(true);
      expect(cat.entries.some((e) => e.id === "F02")).toBe(false);
    });
  });
});
