import { Pool, type PoolClient } from "pg";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { ReportsService } from "./reports.service";
import { EXECUTORS } from "./engine/executors";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "reports-spec-fixtures" };

/**
 * Real Postgres, no mocks. One hand-computable company ("A") so every figure can be checked exactly, a second company
 * ("B") to prove tenant isolation, and a third with only the Employee licence to prove module gating.
 */
describe("ReportsService (real database)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let reports: ReportsService;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  let today: string;
  const day = (offset: number): string => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };

  let a: string; // company A
  let b: string; // company B
  let c: string; // company C (employee licence only)
  let hr: RequestClaims;
  let mgr: RequestClaims;
  let ess: RequestClaims;
  let nobody: RequestClaims;
  let hrNoSensitive: RequestClaims;
  let hrB: RequestClaims;
  let hrC: RequestClaims;
  let platform: RequestClaims;
  let ouEng: string;
  let ouFin: string;

  const fx = <T>(fn: (client: PoolClient) => Promise<T>) => db.withClaims(FIXTURE, fn);

  async function makeCompany(client: PoolClient, label: string, modules: string[]): Promise<string> {
    const r = await client.query("INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, 'Asia/Karachi') RETURNING id", [`Reports ${label} ${stamp}`, `reports-${label}-${stamp}`.toLowerCase()]);
    const id = r.rows[0].id as string;
    await client.query("INSERT INTO company_config (company_id, enabled_modules) VALUES ($1, $2::jsonb)", [id, JSON.stringify(modules)]);
    for (const m of modules) await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, $2, true)", [id, m]);
    return id;
  }

  async function makeUser(client: PoolClient, companyId: string, tag: string, roleKey: string | null): Promise<RequestClaims> {
    const u = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`rep-${tag}-${stamp}@example.com`]);
    const id = u.rows[0].id as string;
    if (roleKey) {
      const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [id, companyId, role.rows[0].id]);
    }
    return { is_platform_admin: false, company_id: companyId, sub: id };
  }

  async function makeEmployee(
    client: PoolClient,
    companyId: string,
    n: string,
    o: { joined: string; status?: string; terminated?: string | null; type?: string; ou?: string | null; loc?: string | null; user?: string | null }
  ): Promise<string> {
    const p = await client.query("INSERT INTO persons (company_id, full_name) VALUES ($1, $2) RETURNING id", [companyId, `Person ${n}`]);
    const e = await client.query(
      `INSERT INTO employees (company_id, employee_number, first_name, last_name, person_id, employment_status, date_of_joining, termination_date, employment_type, org_unit_id, location_id, user_account_id)
       VALUES ($1, $2, 'Test', $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [companyId, `R-${n}-${stamp}`.slice(0, 30), `Emp${n}`, p.rows[0].id, o.status ?? "active", o.joined, o.terminated ?? null, o.type ?? "permanent", o.ou ?? null, o.loc ?? null, o.user ?? null]
    );
    return e.rows[0].id as string;
  }

  const emp: Record<string, string> = {};
  const leaveName: Record<string, string> = {};

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    reports = new ReportsService(db, new RbacService(db), new EntitlementsService(db), new AuditService());
    today = (await fx((cl) => cl.query("SELECT ((now() AT TIME ZONE 'Asia/Karachi')::date)::text AS d"))).rows[0].d;

    await fx(async (client) => {
      a = await makeCompany(client, "a", ["employee", "leave", "payroll"]);
      b = await makeCompany(client, "b", ["employee", "leave"]);
      c = await makeCompany(client, "c", ["employee"]);

      hr = await makeUser(client, a, "hr", "hr_admin");
      mgr = await makeUser(client, a, "mgr", "line_manager");
      ess = await makeUser(client, a, "ess", "employee_self_service");
      nobody = await makeUser(client, a, "nobody", null);
      hrB = await makeUser(client, b, "hrb", "hr_admin");
      hrC = await makeUser(client, c, "hrc", "hr_admin");
      platform = { is_platform_admin: true, company_id: null, sub: "platform-admin-for-reports-spec" };

      // an HR role that has reports.view but NOT reports.view.sensitive
      const role = await client.query("INSERT INTO roles (key, name) VALUES ($1, 'Reports no sensitive') RETURNING id", [`reports_no_sens_${stamp}`]);
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $1, id FROM permissions WHERE key IN ('reports.view','employee.view.all','leave_request.view.all','payroll.calculate.all','reports.export')`,
        [role.rows[0].id]
      );
      const u = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`rep-nosens-${stamp}@example.com`]);
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, a, role.rows[0].id]);
      hrNoSensitive = { is_platform_admin: false, company_id: a, sub: u.rows[0].id };

      // org structure for company A
      ouEng = (await client.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', 'Engineering') RETURNING id", [a])).rows[0].id;
      // a name that a spreadsheet would run as a formula
      ouFin = (await client.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', '=HYPERLINK(\"http://x\",\"Finance\")') RETURNING id", [a])).rows[0].id;
      const l1 = (await client.query("INSERT INTO locations (company_id, location_type, name) VALUES ($1, 'city', 'Lahore') RETURNING id", [a])).rows[0].id;
      const l2 = (await client.query("INSERT INTO locations (company_id, location_type, name) VALUES ($1, 'city', 'Karachi') RETURNING id", [a])).rows[0].id;

      // E4 is the line manager's own employee record (no department, no location)
      emp.e1 = await makeEmployee(client, a, "1", { joined: day(-400), ou: ouEng, loc: l1 });
      emp.e2 = await makeEmployee(client, a, "2", { joined: day(-400), ou: ouEng, loc: l1 });
      emp.e3 = await makeEmployee(client, a, "3", { joined: day(-100), ou: ouFin, loc: l2, type: "contract" });
      emp.e4 = await makeEmployee(client, a, "4", { joined: day(-400), user: mgr.sub });
      emp.e5 = await makeEmployee(client, a, "5", { joined: day(-400), ou: ouEng, status: "terminated", terminated: day(-10) });
      emp.e6 = await makeEmployee(client, a, "6", { joined: day(-5), ou: ouFin, loc: l2, type: "intern" });
      emp.e7 = await makeEmployee(client, a, "7", { joined: day(-400), status: "terminated", terminated: null });
      emp.e8 = await makeEmployee(client, a, "8", { joined: day(10) });
      for (const e of [emp.e1, emp.e2]) await client.query("INSERT INTO org_relationships (company_id, employee_id, manager_employee_id, relationship_type) VALUES ($1, $2, $3, 'direct')", [a, e, emp.e4]);

      // leave
      // leave types are seeded with the company; read the names the report will show
      const lt = await client.query("SELECT code, name FROM leave_types WHERE company_id = $1 AND code IN ('annual','sick')", [a]);
      for (const x of lt.rows) leaveName[x.code as string] = x.name as string;
      const lr = (e: string, type: string, s: number, en: number, days: number, status: string) =>
        client.query(
          "INSERT INTO leave_requests (company_id, employee_id, leave_type, start_date, end_date, days_requested, status, submitted_by_user_account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [a, e, type, day(s), day(en), days, status, hr.sub]
        );
      await lr(emp.e1, "annual", -10, -8, 3, "approved");
      await lr(emp.e1, "sick", -20, -20, 1, "approved");
      await lr(emp.e2, "annual", -30, -29, 2, "approved");
      await lr(emp.e3, "annual", -3, -3, 1, "pending");
      await lr(emp.e4, "annual", -15, -15, 1, "rejected");
      await lr(emp.e2, "annual", -50, -50, 1, "cancelled");
      await lr(emp.e4, "annual", -62, -58, 5, "approved"); // straddles the start of a 60-day range

      // payroll runs (no amounts needed: F01 never reads them)
      const run = (s: number, en: number, status: string, failed: number) =>
        client.query(
          "INSERT INTO payroll_runs (company_id, period_start, period_end, status, created_by_user_account_id, population_count, calculated_count, failed_count) VALUES ($1,$2,$3,$4,$5,10,$6,$7)",
          [a, day(s), day(en), status, hr.sub, 10 - failed, failed]
        );
      await run(-60, -31, "finalized", 0);
      await run(-30, -1, "calculated", 2);

      // company B: exactly one employee in one department
      const ouB = (await client.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', 'Only B') RETURNING id", [b])).rows[0].id;
      await makeEmployee(client, b, "b1", { joined: day(-300), ou: ouB });
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  const val = (r: { kpis: { key: string; value: number | null }[] }, key: string) => r.kpis.find((k) => k.key === key)?.value;

  // ---------------------------------------------------------------- catalog and authorisation
  describe("catalog and access", () => {
    it("HR Admin sees the available reports; counts add up", async () => {
      const cat = await reports.catalog(hr);
      expect(cat.catalogTotal).toBe(220);
      const available = cat.entries.filter((e) => e.status === "available").map((e) => e.id).sort();
      // "available" means a query exists: every available entry has an executor, and the first ten reports built are all there.
      expect(available.every((id) => id in EXECUTORS)).toBe(true);
      expect(available).toEqual(expect.arrayContaining(["A01", "A03", "A04", "A05", "A06", "A07", "A08", "E02", "E03", "F01"]));
      expect(available.length).toBeGreaterThanOrEqual(100);
      expect(cat.counts.visible).toBe(cat.entries.length);
      expect(cat.counts.available + cat.counts.planned + cat.counts.blocked + cat.counts.unavailable).toBe(cat.counts.visible);
    });

    it("Employee Self Service and a user with no role cannot open Reports & Analytics at all", async () => {
      await expect(reports.catalog(ess)).rejects.toThrow(ForbiddenException);
      await expect(reports.catalog(nobody)).rejects.toThrow(ForbiddenException);
      await expect(reports.run(ess, "A03", {})).rejects.toThrow(ForbiddenException);
    });

    it("a Platform Admin session (no company) is refused: no HR data without a tenant role", async () => {
      await expect(reports.catalog(platform)).rejects.toThrow(ForbiddenException);
      await expect(reports.run(platform, "A03", {})).rejects.toThrow(ForbiddenException);
    });

    it("a Line Manager sees only team-scoped reports they hold the team permission for, and no payroll or sensitive reports", async () => {
      const cat = await reports.catalog(mgr);
      const ids = new Set(cat.entries.map((e) => e.id));
      expect(ids.has("A03")).toBe(true);
      expect(ids.has("E02")).toBe(true);
      expect(ids.has("F01")).toBe(false); // payroll
      expect(ids.has("F02")).toBe(false); // sensitive
      expect(ids.has("C01")).toBe(false); // recruitment needs recruitment.manage.all
      expect(cat.entries.filter((e) => ids.has(e.id)).every((e) => e.scope === "team")).toBe(true);
      expect(cat.entries.every((e) => !e.canExport)).toBe(true);
    });

    it("sensitive reports need reports.view.sensitive on top of the data permission", async () => {
      const full = await reports.catalog(hr);
      const limited = await reports.catalog(hrNoSensitive);
      expect(full.entries.some((e) => e.id === "F02")).toBe(true);
      expect(limited.entries.some((e) => e.id === "F02")).toBe(false);
      expect(limited.entries.some((e) => e.id === "F01")).toBe(true); // internal, payroll permission held
      await expect(reports.entry(hrNoSensitive, "F02")).rejects.toThrow(ForbiddenException);
    });

    it("a module the tenant has not licensed hides its reports and refuses to run them", async () => {
      const cat = await reports.catalog(hrC);
      expect(cat.entries.some((e) => e.id === "E02")).toBe(false);
      expect(cat.entries.some((e) => e.id === "F01")).toBe(false);
      expect(cat.entries.some((e) => e.id === "A03")).toBe(true);
      await expect(reports.run(hrC, "E02", {})).rejects.toThrow(ForbiddenException);
    });

    it("an unknown id is 404, and a planned or blocked report is refused with its reason rather than an invented result", async () => {
      await expect(reports.run(hr, "Z99", {})).rejects.toThrow(NotFoundException);
      await expect(reports.run(hr, "E07", {})).rejects.toThrow(ConflictException);
      const err = await reports.run(hr, "A02", {}).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({ code: "REPORT_NOT_AVAILABLE", status: "blocked" });
    });

    it("favourites are per user and survive in the catalog", async () => {
      await reports.setFavorite(hr, "A03", true);
      expect((await reports.catalog(hr)).favorites).toContain("A03");
      expect((await reports.catalog(hrNoSensitive)).favorites).not.toContain("A03");
      await reports.setFavorite(hr, "A03", false);
      expect((await reports.catalog(hr)).favorites).not.toContain("A03");
    });
  });

  // ---------------------------------------------------------------- headcount reports (hand-computed)
  describe("workforce reports", () => {
    it("A01 snapshot: headcount, joiners, leavers and net change", async () => {
      const r = await reports.run(hr, "A01", {});
      expect(val(r, "headcount")).toBe(5); // e1 e2 e3 e4 e6; e5/e7 left, e8 starts in the future
      expect(val(r, "joiners")).toBe(1); // e6
      expect(val(r, "leavers")).toBe(1); // e5
      expect(val(r, "net")).toBe(0);
      expect(r.notes.join(" ")).toMatch(/joining date in the future/);
      expect(r.notes.join(" ")).toMatch(/no termination date/);
    });

    it("A03 headcount by department counts everyone once, with an honest 'No department set' bucket", async () => {
      const r = await reports.run(hr, "A03", {});
      const by = Object.fromEntries(r.rows.map((x) => [x.label as string, x.headcount]));
      expect(by["Engineering"]).toBe(2);
      expect(by['=HYPERLINK("http://x","Finance")']).toBe(2);
      expect(by["No department set"]).toBe(1);
      expect(val(r, "headcount")).toBe(5);
      expect(r.rows.reduce((s, x) => s + Number(x.headcount), 0)).toBe(5);
      expect(r.notes.join(" ")).toMatch(/no department on record/);
    });

    it("A03 filters by department and location, including the 'unassigned' bucket", async () => {
      const eng = await reports.run(hr, "A05", { department: ouEng });
      expect(val(eng, "headcount")).toBe(2);
      const none = await reports.run(hr, "A05", { department: "unassigned" });
      expect(val(none, "headcount")).toBe(1);
      const lahore = await reports.run(hr, "A05", { location: "unassigned" });
      expect(val(lahore, "headcount")).toBe(1);
      const intern = await reports.run(hr, "A03", { employmentType: "intern" });
      expect(val(intern, "headcount")).toBe(1);
    });

    it("A04 by location and A05 by employment type", async () => {
      const loc = Object.fromEntries((await reports.run(hr, "A04", {})).rows.map((x) => [x.label as string, x.headcount]));
      expect(loc).toMatchObject({ Lahore: 2, Karachi: 2, "No location set": 1 });
      const typ = Object.fromEntries((await reports.run(hr, "A05", {})).rows.map((x) => [x.label as string, x.headcount]));
      expect(typ).toMatchObject({ Permanent: 3, Contract: 1, Intern: 1 });
    });

    it("A06 active vs inactive: working is anything not terminated, over all records", async () => {
      const r = await reports.run(hr, "A06", {});
      expect(val(r, "working")).toBe(6); // e1 e2 e3 e4 e6 e8
      expect(val(r, "left")).toBe(2);
      expect(val(r, "workingShare")).toBe(75);
    });

    it("A07 monthly trend: start, end and growth are computed from joining and termination dates", async () => {
      const r = await reports.run(hr, "A07", {});
      expect(r.rows.length).toBeGreaterThanOrEqual(12);
      expect(val(r, "start")).toBe(4); // e1 e2 e4 e5 (e3 joined 100 days ago; e7 excluded: no termination date)
      expect(val(r, "end")).toBe(5);
      expect(val(r, "change")).toBe(1);
      expect(val(r, "growth")).toBe(25);
      expect(r.notes.join(" ")).toMatch(/left out of dated figures/);
    });

    it("A08 joiners and leavers over an explicit range", async () => {
      const r = await reports.run(hr, "A08", { dateFrom: day(-30), dateTo: day(0) });
      expect(val(r, "joiners")).toBe(1);
      expect(val(r, "leavers")).toBe(1);
      const wide = await reports.run(hr, "A08", {});
      expect(val(wide, "joiners")).toBe(2); // e3 and e6; e8 starts after today
      expect(val(wide, "leavers")).toBe(1);
    });

    it("team scope: a manager's numbers cover only their direct reports", async () => {
      const r = await reports.run(mgr, "A03", {});
      expect(r.scope).toBe("team");
      expect(val(r, "headcount")).toBe(2);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ label: "Engineering", headcount: 2 });
      const opts = await reports.filterOptions(mgr, "A05");
      expect(opts.department?.map((o) => o.label)).toEqual(["No department set", "Engineering"]);
      expect(opts.department?.some((o) => o.value === ouFin)).toBe(false); // other departments are not revealed
    });

    it("a manager cannot widen scope by passing someone else's department", async () => {
      const r = await reports.run(mgr, "A05", { department: ouFin });
      expect(val(r, "headcount")).toBe(0);
    });

    it("a manager with no employee record sees nobody", async () => {
      const lone = await fx((cl) => makeUser(cl, a, "lone-mgr", "line_manager"));
      const r = await reports.run(lone, "A03", {});
      expect(val(r, "headcount")).toBe(0);
    });
  });

  // ---------------------------------------------------------------- tenant isolation
  describe("tenant isolation", () => {
    it("company B sees only company B's people, never company A's", async () => {
      const r = await reports.run(hrB, "A03", {});
      expect(val(r, "headcount")).toBe(1);
      expect(r.rows.map((x) => x.label)).toEqual(["Only B"]);
    });

    it("company A's department id used as a filter in company B returns nothing", async () => {
      const r = await reports.run(hrB, "A05", { department: ouEng });
      expect(val(r, "headcount")).toBe(0);
      const opts = await reports.filterOptions(hrB, "A05");
      expect(opts.department?.some((o) => o.value === ouEng)).toBe(false);
    });

    it("company B's leave report is empty of company A's leave", async () => {
      const r = await reports.run(hrB, "E02", { dateFrom: day(-60), dateTo: day(0) });
      expect(val(r, "days")).toBe(0);
    });
  });

  // ---------------------------------------------------------------- leave and payroll
  describe("leave reports", () => {
    const range = () => ({ dateFrom: day(-60), dateTo: day(0) });

    it("E02: approved days per type, prorating a request that straddles the range start", async () => {
      const r = await reports.run(hr, "E02", range());
      const by = Object.fromEntries(r.rows.map((x) => [x.label as string, x]));
      // annual: e1 3 + e2 2 + e4 5*(3/5)=3  = 8 days over 3 requests; sick: e1 1
      expect(by[leaveName.annual]).toMatchObject({ requests: 3, days: 8 });
      expect(by[leaveName.sick]).toMatchObject({ requests: 1, days: 1 });
      expect(val(r, "days")).toBe(9);
      expect(val(r, "people")).toBe(3);
    });

    it("E02 respects the leave type filter and the manager's team scope", async () => {
      const sick = await reports.run(hr, "E02", { ...range(), leaveType: "sick" });
      expect(val(sick, "days")).toBe(1);
      const team = await reports.run(mgr, "E02", range());
      expect(val(team, "days")).toBe(6); // e1 3 + 1, e2 2; e4 is the manager, not their own report
    });

    it("E03: requests by status and the approval rate (decided requests only)", async () => {
      const r = await reports.run(hr, "E03", range());
      const by = Object.fromEntries(r.rows.map((x) => [x.label as string, x.requests]));
      expect(by).toMatchObject({ Approved: 3, Pending: 1, Rejected: 1, Cancelled: 1 });
      expect(val(r, "total")).toBe(6);
      expect(val(r, "pending")).toBe(1);
      expect(val(r, "approvalRate")).toBe(75);
    });
  });

  describe("payroll", () => {
    it("F01 lists runs and statuses with no amounts", async () => {
      const r = await reports.run(hr, "F01", {});
      expect(val(r, "runs")).toBe(2);
      expect(val(r, "inProgress")).toBe(1);
      expect(val(r, "problems")).toBe(1);
      expect(r.columns.map((c) => c.key)).not.toEqual(expect.arrayContaining(["gross", "net", "totalGross"]));
      expect(JSON.stringify(r)).not.toMatch(/total_gross|total_net/);
    });

    it("a Line Manager is refused payroll runs", async () => {
      await expect(reports.run(mgr, "F01", {})).rejects.toThrow(ForbiddenException);
    });
  });

  // ---------------------------------------------------------------- input validation
  describe("filter validation", () => {
    it("rejects unknown filters, bad dates, reversed and over-long ranges, and malformed ids", async () => {
      await expect(reports.run(hr, "A03", { dateFrom: "2026-01-01" })).rejects.toThrow(BadRequestException); // A03 has no date range
      await expect(reports.run(hr, "A03", { "; DROP TABLE employees": "x" })).rejects.toThrow(BadRequestException);
      await expect(reports.run(hr, "A05", { department: "' OR 1=1 --" })).rejects.toThrow(BadRequestException);
      await expect(reports.run(hr, "A03", { employmentType: "x'; select 1" })).rejects.toThrow(BadRequestException);
      await expect(reports.run(hr, "A08", { dateFrom: "2026-13-01", dateTo: "2026-12-31" })).rejects.toThrow(BadRequestException);
      await expect(reports.run(hr, "A08", { dateFrom: "2026-05-01", dateTo: "2026-04-01" })).rejects.toThrow(BadRequestException);
      await expect(reports.run(hr, "A08", { dateFrom: "2010-01-01", dateTo: "2026-04-01" })).rejects.toThrow(BadRequestException);
      await expect(reports.run(hr, "E02", { leaveType: "Annual;--" })).rejects.toThrow(BadRequestException);
    });
  });

  // ---------------------------------------------------------------- export, audit, telemetry
  describe("export, audit and telemetry", () => {
    it("exports CSV with a BOM, defuses spreadsheet formulas, and writes an audit row without row data", async () => {
      const { filename, csv } = await reports.exportCsv(hr, "A03", {});
      expect(filename).toMatch(/^A03-\d{4}-\d{2}-\d{2}\.csv$/);
      expect(csv.charCodeAt(0)).toBe(0xfeff);
      expect(csv).toContain("Department,Headcount,Share of headcount (%)");
      expect(csv).toContain("Engineering,2,40");
      expect(csv).toContain(`"'=HYPERLINK(""http://x"",""Finance"")"`); // the leading quote makes it text, not a formula
      expect(csv).not.toMatch(/(^|\r\n)=HYPERLINK/);

      const audit = await fx((cl) => cl.query("SELECT metadata FROM audit_log WHERE company_id = $1 AND action = 'report.export' AND target = 'A03'", [a]));
      expect(audit.rows.length).toBeGreaterThanOrEqual(1);
      const meta = JSON.stringify(audit.rows[0].metadata);
      expect(meta).toContain("A03");
      expect(meta).not.toContain("Engineering"); // no row contents in the audit trail
    });

    it("export needs reports.export: a Line Manager is refused", async () => {
      await expect(reports.exportCsv(mgr, "A03", {})).rejects.toThrow(ForbiddenException);
    });

    it("runs are logged without filter values or rows; denials and bad input are logged too", async () => {
      await reports.run(hr, "A03", { location: "unassigned" });
      await reports.run(hr, "A03", { location: "nope" }).catch(() => undefined);
      await reports.run(ess, "A03", {}).catch(() => undefined);
      const rows = (await fx((cl) => cl.query("SELECT status, error_category, kind FROM report_run_log WHERE company_id = $1 AND report_id = 'A03'", [a]))).rows;
      expect(rows.some((x) => x.status === "ok" && x.kind === "run")).toBe(true);
      expect(rows.some((x) => x.status === "invalid")).toBe(true);
      const cols = (await fx((cl) => cl.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'report_run_log'"))).rows.map((x) => x.column_name);
      expect(cols).not.toEqual(expect.arrayContaining(["filters"]));
    });

    it("a sensitive report that is not built yet is refused with its reason, never answered with invented numbers", async () => {
      await expect(reports.run(hr, "F09", {})).rejects.toThrow(ConflictException);
      const log = await fx((cl) => cl.query("SELECT 1 FROM audit_log WHERE company_id = $1 AND action = 'report.run' AND target = 'F09'", [a]));
      expect(log.rowCount).toBe(0); // nothing ran, so there is nothing to audit
    });
  });
});
