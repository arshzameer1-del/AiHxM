import { Pool, type PoolClient } from "pg";
import type { ReportResult, ReportSection } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { ReportsService } from "./reports.service";
import { DEPTH_SECTIONS } from "./engine/depth";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "report-depth-data-spec-fixtures" };

/**
 * The extra tables under each report, run against real Postgres on a small company with hand-counted figures. The smoke spec
 * proves every table parses and respects scope; this one proves the numbers are right and that another company never leaks in.
 */
describe("Report depth: hand-counted figures in the extra tables", () => {
  let pool: Pool;
  let db: DatabaseService;
  let reports: ReportsService;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let a: string;
  let b: string;
  let hr: RequestClaims;
  let today: string;
  const e: Record<string, string> = {};
  const fx = <T>(fn: (c: PoolClient) => Promise<T>) => db.withClaims(FIXTURE, fn);
  const day = (offset: number): string => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };

  async function makeUser(c: PoolClient, companyId: string, tag: string, roleKey: string): Promise<RequestClaims> {
    const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`dd-${tag}-${stamp}@example.com`]);
    const role = await c.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
    await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, companyId, role.rows[0].id]);
    return { is_platform_admin: false, company_id: companyId, sub: u.rows[0].id };
  }
  async function makeEmployee(c: PoolClient, companyId: string, n: string, o: { status?: string; joined: string; left?: string | null; unit?: string | null; type?: string }) {
    const p = await c.query("INSERT INTO persons (company_id, full_name) VALUES ($1, $2) RETURNING id", [companyId, `Person ${n}`]);
    const r = await c.query(
      `INSERT INTO employees (company_id, employee_number, first_name, last_name, person_id, employment_status, date_of_joining, termination_date, org_unit_id, employment_type)
       VALUES ($1, $2, 'T', $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [companyId, `DD-${n}-${stamp}`.slice(0, 30), `Emp${n}`, p.rows[0].id, o.status ?? "active", o.joined, o.left ?? null, o.unit ?? null, o.type ?? "permanent"]
    );
    return r.rows[0].id as string;
  }
  const section = (r: ReportResult, key: string): ReportSection => {
    const s = r.sections?.find((x) => x.key === key);
    if (!s) throw new Error(`no section ${key} (have ${r.sections?.map((x) => x.key).join(", ")})`);
    return s;
  };
  const sum = (s: ReportSection, key: string) => s.rows.reduce((t, x) => t + Number(x[key] ?? 0), 0);

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    reports = new ReportsService(db, new RbacService(db), new EntitlementsService(db), new AuditService());
    today = (await fx((cl) => cl.query("SELECT ((now() AT TIME ZONE 'Asia/Karachi')::date)::text AS d"))).rows[0].d;
    await fx(async (c) => {
      const mk = async (label: string) => {
        const modules = ["employee", "leave", "payroll"];
        const r = await c.query("INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, 'Asia/Karachi') RETURNING id", [`DD ${label} ${stamp}`, `dd-${label}-${stamp}`.toLowerCase()]);
        await c.query("INSERT INTO company_config (company_id, enabled_modules) VALUES ($1, $2::jsonb)", [r.rows[0].id, JSON.stringify(modules)]);
        for (const m of modules) await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, $2, true)", [r.rows[0].id, m]);
        return r.rows[0].id as string;
      };
      a = await mk("a");
      b = await mk("b");
      hr = await makeUser(c, a, "hr", "hr_admin");
      const eng = (await c.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', 'Engineering') RETURNING id", [a])).rows[0].id;
      const sales = (await c.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', 'Sales') RETURNING id", [a])).rows[0].id;
      const unitB = (await c.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', 'Engineering') RETURNING id", [b])).rows[0].id;

      // Engineering: three current (two permanent, one contract). Sales: one permanent and one leaver.
      e.e1 = await makeEmployee(c, a, "1", { joined: day(-800), unit: eng });
      e.e2 = await makeEmployee(c, a, "2", { joined: day(-400), unit: eng });
      e.e3 = await makeEmployee(c, a, "3", { joined: day(-10), unit: eng, type: "contract" });
      e.s1 = await makeEmployee(c, a, "4", { joined: day(-300), unit: sales });
      e.s2 = await makeEmployee(c, a, "5", { status: "terminated", joined: day(-500), left: day(-5), unit: sales });
      // another company with its own people: must never show up
      await makeEmployee(c, b, "b1", { joined: day(-100), unit: unitB });
      await makeEmployee(c, b, "b2", { joined: day(-100), unit: unitB });

      // approved leave: e1 has 3 + 2 days, e4 (Sales) has 1 day; a pending request and another company's leave do not count
      const leave = (emp: string, type: string, start: number, days: number, status = "approved", company = a) =>
        c.query(
          "INSERT INTO leave_requests (company_id, employee_id, leave_type, start_date, end_date, days_requested, status, submitted_by_user_account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [company, emp, type, day(start), day(start + days - 1), days, status, hr.sub]
        );
      await leave(e.e1, "annual", -20, 3);
      await leave(e.e1, "sick", -10, 2);
      await leave(e.s1, "annual", -15, 1);
      await leave(e.e2, "annual", -8, 4, "pending");

      // payroll: one finalized and one draft run in company A
      const run = (status: string, from: number, to: number) =>
        c.query(
          "INSERT INTO payroll_runs (company_id, period_start, period_end, status, created_by_user_account_id, population_count, calculated_count, failed_count) VALUES ($1,$2,$3,$4,$5,4,4,0)",
          [a, day(from), day(to), status, hr.sub]
        );
      await run("finalized", -60, -31);
      await run("draft", -30, -1);

      // how reports themselves are used. Seeded on report ids the tests below never run, so the tests' own runs (which are logged too)
      // cannot change these figures: B01 run three times by two people and exported once, B02 once and slowly, C01 refused, C02 failed twice.
      const mkUser = async (tag: string) => (await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`dd-log-${tag}-${stamp}@example.com`])).rows[0].id as string;
      const u1 = await mkUser("1");
      const u2 = await mkUser("2");
      const ub = await mkUser("b");
      const log = (user: string, report: string, kind: string, status: string, ms: number, rows: number | null, category: string | null, ago: number, company = a) =>
        c.query(
          "INSERT INTO report_run_log (company_id, user_account_id, report_id, report_version, kind, status, duration_ms, row_count, error_category, created_at) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8, now() - ($9 || ' days')::interval)",
          [company, user, report, kind, status, ms, rows, category, String(ago)]
        );
      await log(u1, "B01", "run", "ok", 300, 4, null, 2);
      await log(u1, "B01", "run", "ok", 700, 4, null, 3);
      await log(u1, "B01", "export", "ok", 900, 4, null, 3);
      await log(u2, "B01", "run", "ok", 200, 4, null, 1);
      await log(u1, "B02", "run", "ok", 6000, 20, null, 4);
      await log(u1, "C01", "run", "denied", 5, null, null, 4);
      await log(u1, "C02", "run", "error", 40, null, "timeout", 5);
      await log(u1, "C02", "run", "error", 55, null, "timeout", 6);
      // another company's activity on the same report: must not be counted
      for (let i = 0; i < 5; i++) await log(ub, "B01", "run", "ok", 100, 2, null, 1, b);

      // notifications: 3 sent, 1 failed by email; 2 logged by in-app
      const note = (channel: string, status: string) => c.query("INSERT INTO notification_log (company_id, channel, recipient, template_key, payload, status) VALUES ($1,$2,'someone@example.com','leave_approved','{}'::jsonb,$3)", [a, channel, status]);
      for (const s of ["sent", "sent", "sent", "failed"]) await note("email", s);
      for (let i = 0; i < 2; i++) await note("in_app", "logged");
    });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  it("A01 breaks headcount down by unit and employment type and counts only this company", async () => {
    const r = await reports.run(hr, "A01", {});
    const byUnit = section(r, "by-unit");
    expect(byUnit.rows.find((x) => x.label === "Engineering")).toEqual(expect.objectContaining({ employees: 3 }));
    expect(byUnit.rows.find((x) => x.label === "Sales")).toEqual(expect.objectContaining({ employees: 1 }));
    expect(sum(byUnit, "employees")).toBe(4);
    const byType = section(r, "by-type");
    expect(byType.rows.find((x) => x.label === "Permanent")).toEqual(expect.objectContaining({ employees: 3 }));
    expect(byType.rows.find((x) => x.label === "Contract")).toEqual(expect.objectContaining({ employees: 1 }));
    expect(sum(section(r, "tenure-bands"), "employees")).toBe(4);
  });

  it("A01 lists the recent joiner and the recent leaver", async () => {
    const r = await reports.run(hr, "A01", {});
    expect(section(r, "recent-joiners").rows.map((x) => x.number)).toEqual([expect.stringContaining("DD-3-")]);
    expect(section(r, "recent-leavers").rows.map((x) => x.number)).toEqual([expect.stringContaining("DD-5-")]);
  });

  it("E02 adds up approved leave by unit and per person, leaving out pending requests", async () => {
    const r = await reports.run(hr, "E02", { dateFrom: day(-30), dateTo: day(0) });
    const unit = section(r, "leave-by-unit");
    expect(unit.rows.find((x) => x.label === "Engineering")).toEqual(expect.objectContaining({ days: 5 }));
    expect(unit.rows.find((x) => x.label === "Sales")).toEqual(expect.objectContaining({ days: 1 }));
    const person = section(r, "leave-per-person");
    expect(person.rows).toHaveLength(2);
    expect(sum(person, "days")).toBe(6);
    expect(person.rows[0]).toEqual(expect.objectContaining({ days: 5, requests: 2 }));
  });

  it("F01 counts payroll runs by status", async () => {
    const r = await reports.run(hr, "F01", { dateFrom: day(-90), dateTo: day(0) });
    const s = section(r, "by-status");
    expect(sum(s, "total")).toBe(2);
    expect(s.rows.find((x) => x.label === "Finalized")).toEqual(expect.objectContaining({ regular: 1, total: 1, employees: 4 }));
    expect(s.rows.find((x) => x.label === "Draft")).toEqual(expect.objectContaining({ regular: 1, total: 1 }));
  });

  it("O02 counts runs, exports and people per report, only for this company", async () => {
    const r = await reports.run(hr, "O02", { dateFrom: day(-30), dateTo: day(0) });
    expect(r.rows.find((x) => x.report === "B01")).toEqual(expect.objectContaining({ runs: 3, people: 2, exports: 1 }));
    const rate = section(r, "export-rate-by-report").rows.find((x) => x.report === "B01");
    expect(rate).toEqual(expect.objectContaining({ runs: 3, exports: 1, rate: 33.3 }));
    expect(sum(section(r, "runs-by-month"), "exports")).toBeGreaterThanOrEqual(1);
  });

  it("O05 groups failures by cause and O11 lists the refusal", async () => {
    const r5 = await reports.run(hr, "O05", { dateFrom: day(-30), dateTo: day(0) });
    expect(section(r5, "errors-by-category").rows).toEqual([expect.objectContaining({ label: "Timeout", failed: 2, reports: 1, people: 1 })]);
    expect(section(r5, "failures-by-report-and-cause").rows).toEqual([expect.objectContaining({ report: "C02", cause: "Timeout", failed: 2 })]);
    const r11 = await reports.run(hr, "O11", { dateFrom: day(-30), dateTo: day(0) });
    expect(section(r11, "denials-by-report").rows).toEqual([expect.objectContaining({ report: "C01", denied: 1, people: 1 })]);
  });

  it("O04 puts the 6 second run in the slow band and names it among the slowest", async () => {
    const r = await reports.run(hr, "O04", { dateFrom: day(-30), dateTo: day(0) });
    expect(section(r, "speed-bands").rows.find((x) => x.label === "5 to 15 seconds")).toEqual(expect.objectContaining({ runs: 1 }));
    expect(section(r, "slowest-runs").rows[0]).toEqual(expect.objectContaining({ report: "B02", ms: 6000 }));
  });

  it("O10 sizes exports by report and band", async () => {
    const r = await reports.run(hr, "O10", { dateFrom: day(-30), dateTo: day(0) });
    expect(section(r, "exports-by-report").rows).toEqual([expect.objectContaining({ report: "B01", exports: 1, rows: 4, people: 1 })]);
    expect(section(r, "export-size-bands").rows).toEqual([expect.objectContaining({ label: "Under 50", exports: 1 })]);
  });

  it("N09 counts notifications by channel and status and reports the failure rate by template", async () => {
    const r = await reports.run(hr, "N09", { dateFrom: day(-3), dateTo: day(0) });
    const status = section(r, "notifications-by-status");
    expect(status.rows.find((x) => x.channel === "Email" && x.status === "Sent")).toEqual(expect.objectContaining({ total: 3 }));
    expect(status.rows.find((x) => x.channel === "Email" && x.status === "Failed")).toEqual(expect.objectContaining({ total: 1 }));
    const template = section(r, "notifications-by-template");
    expect(template.rows).toEqual([expect.objectContaining({ template: "Leave Approved", total: 6, sent: 3, failed: 1, rate: 25 })]);
    expect(section(r, "notification-volume").rows.find((x) => x.channel === "In App")).toEqual(expect.objectContaining({ total: 2, recipients: 1 }));
  });

  it("N12 counts the active setup records and the employees missing a link", async () => {
    const r = await reports.run(hr, "N12", {});
    const gaps = section(r, "employee-record-gaps");
    expect(gaps.rows.find((x) => x.label === "Organisation unit")).toEqual(expect.objectContaining({ missing: 0, employees: 4 }));
    expect(gaps.rows.find((x) => x.label === "Location")).toEqual(expect.objectContaining({ missing: 4, employees: 4 }));
    expect(section(r, "setup-active-and-inactive").rows.find((x) => x.item === "Organisation units")).toEqual(expect.objectContaining({ total: 2, active: 2, inactive: 0 }));
  });

  it("O12 describes the catalog without reading any table", async () => {
    const r = await reports.run(hr, "O12", {});
    const status = section(r, "catalog-by-status");
    expect(sum(status, "reports")).toBe(245);
    expect(section(r, "not-yet-available").rows.every((x) => x.status !== "Available")).toBe(true);
  });

  it("no extra table in any report exposes an identity number, bank number, password, secret, token or IP address", async () => {
    const forbidden = /cnic|iban|account number|account_number|password|secret|token|ip address|ip_address|date of birth|passport|\bntn\b/i;
    const found: string[] = [];
    for (const id of Object.keys(DEPTH_SECTIONS)) {
      let r: ReportResult;
      try {
        r = await reports.run(hr, id, {});
      } catch {
        continue; // not open to this role, or needs a filter: the smoke spec covers every report with full rights
      }
      for (const sec of r.sections ?? []) for (const c of sec.columns) if (forbidden.test(`${c.key} ${c.label}`)) found.push(`${id}/${sec.key}: ${c.label}`);
    }
    expect(found).toEqual([]);
  }, 120_000);
});
