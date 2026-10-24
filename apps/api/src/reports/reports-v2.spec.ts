import { Pool, type PoolClient } from "pg";
import ExcelJS from "exceljs";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { BuilderDefinition } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { MailerService } from "../mailer/mailer.service";
import { RbacService } from "../rbac/rbac.service";
import { BuilderService } from "./builder/builder.service";
import { compile, validateDefinition } from "./builder/compile";
import { ExportService } from "./export/export.service";
import { ReportsService, applyComparison } from "./reports.service";
import { DashboardsService } from "./saved/dashboards.service";
import { ReportRunnerService } from "./saved/runner.service";
import { SavedReportsService } from "./saved/saved-reports.service";
import { SharingService } from "./saved/sharing.service";
import { SchedulesService } from "./schedules/schedules.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "reports-v2-spec-fixtures" };

/** Real Postgres, no mocks: saved reports, sharing, the builder, dashboards, exports and schedules, with their access rules. */
describe("Reports v2 (real database)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let reports: ReportsService;
  let builder: BuilderService;
  let saved: SavedReportsService;
  let dashboards: DashboardsService;
  let exportsSvc: ExportService;
  let schedules: SchedulesService;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  let a: string;
  let b: string;
  let hr: RequestClaims;
  let hr2: RequestClaims;
  let mgr: RequestClaims;
  let ess: RequestClaims;
  let hrB: RequestClaims;
  let today: string;
  const emp: Record<string, string> = {};
  const fx = <T>(fn: (c: PoolClient) => Promise<T>) => db.withClaims(FIXTURE, fn);
  const day = (offset: number): string => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };

  async function makeUser(client: PoolClient, companyId: string, tag: string, roleKey: string): Promise<RequestClaims> {
    const u = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`v2-${tag}-${stamp}@example.com`]);
    const id = u.rows[0].id as string;
    const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
    await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [id, companyId, role.rows[0].id]);
    return { is_platform_admin: false, company_id: companyId, sub: id };
  }
  async function makeEmployee(client: PoolClient, companyId: string, n: string, o: { joined: string; ou?: string | null; user?: string | null; status?: string; first?: string }): Promise<string> {
    const p = await client.query("INSERT INTO persons (company_id, full_name) VALUES ($1, $2) RETURNING id", [companyId, `Person ${n}`]);
    const e = await client.query(
      `INSERT INTO employees (company_id, employee_number, first_name, last_name, person_id, employment_status, date_of_joining, org_unit_id, user_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [companyId, `V-${n}-${stamp}`.slice(0, 30), o.first ?? "Test", `Emp${n}`, p.rows[0].id, o.status ?? "active", o.joined, o.ou ?? null, o.user ?? null]
    );
    return e.rows[0].id as string;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const audit = new AuditService();
    reports = new ReportsService(db, new RbacService(db), new EntitlementsService(db), audit);
    builder = new BuilderService(db, reports, audit);
    const runner = new ReportRunnerService(reports, builder);
    const sharing = new SharingService(db, reports, audit);
    saved = new SavedReportsService(db, reports, runner, sharing);
    dashboards = new DashboardsService(db, reports, saved, runner, sharing);
    exportsSvc = new ExportService(db, runner);
    schedules = new SchedulesService(db, reports, saved, runner, exportsSvc, new MailerService());
    today = (await fx((cl) => cl.query("SELECT ((now() AT TIME ZONE 'Asia/Karachi')::date)::text AS d"))).rows[0].d;

    await fx(async (client) => {
      const mk = async (label: string, modules: string[]) => {
        const r = await client.query("INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, 'Asia/Karachi') RETURNING id", [`V2 ${label} ${stamp}`, `v2-${label}-${stamp}`.toLowerCase()]);
        await client.query("INSERT INTO company_config (company_id, enabled_modules) VALUES ($1, $2::jsonb)", [r.rows[0].id, JSON.stringify(modules)]);
        for (const m of modules) await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, $2, true)", [r.rows[0].id, m]);
        return r.rows[0].id as string;
      };
      a = await mk("a", ["employee", "leave", "payroll"]);
      b = await mk("b", ["employee", "leave"]);
      hr = await makeUser(client, a, "hr", "hr_admin");
      hr2 = await makeUser(client, a, "hr2", "hr_admin");
      mgr = await makeUser(client, a, "mgr", "line_manager");
      ess = await makeUser(client, a, "ess", "employee_self_service");
      hrB = await makeUser(client, b, "hrb", "hr_admin");

      const ouEng = (await client.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', 'Engineering') RETURNING id", [a])).rows[0].id;
      const ouFin = (await client.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', '=HYPERLINK(\"http://x\",\"Finance\")') RETURNING id", [a])).rows[0].id;
      // user-linked employees give names to share targets and recipients
      await makeEmployee(client, a, "hr", { joined: day(-500), ou: ouEng, user: hr.sub, first: "Hina" });
      await makeEmployee(client, a, "hr2", { joined: day(-500), ou: ouEng, user: hr2.sub, first: "Hamid" });
      emp.mgr = await makeEmployee(client, a, "mgr", { joined: day(-500), user: mgr.sub, first: "Maha" });
      await makeEmployee(client, a, "ess", { joined: day(-500), user: ess.sub, first: "Esha" });
      emp.e1 = await makeEmployee(client, a, "1", { joined: day(-400), ou: ouEng });
      emp.e2 = await makeEmployee(client, a, "2", { joined: day(-300), ou: ouEng });
      emp.e3 = await makeEmployee(client, a, "3", { joined: day(-100), ou: ouFin });
      for (const e of [emp.e1, emp.e3]) await client.query("INSERT INTO org_relationships (company_id, employee_id, manager_employee_id, relationship_type) VALUES ($1, $2, $3, 'direct')", [a, e, emp.mgr]);
      await makeEmployee(client, b, "b1", { joined: day(-300) });

      const lr = (e: string, type: string, s: number, e2: number, days: number, status: string) =>
        client.query("INSERT INTO leave_requests (company_id, employee_id, leave_type, start_date, end_date, days_requested, status, submitted_by_user_account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [a, e, type, day(s), day(e2), days, status, hr.sub]);
      await lr(emp.e1, "annual", -3, -2, 2, "approved");
      await lr(emp.e1, "sick", -5, -5, 1, "approved");
      await lr(emp.e2, "annual", -9, -8, 2, "pending");
      await lr(emp.e3, "annual", -1, -1, 1, "approved");

      const run = (await client.query(
        "INSERT INTO payroll_runs (company_id, period_start, period_end, status, created_by_user_account_id, population_count, calculated_count, failed_count) VALUES ($1,$2,$3,'finalized',$4,2,2,0) RETURNING id",
        [a, day(-30), day(-1), hr.sub]
      )).rows[0].id;
      for (const [e, gross, net] of [[emp.e1, 100000, 90000], [emp.e2, 120000, 105000]] as const) {
        await client.query(
          `INSERT INTO payslips (company_id, payroll_run_id, employee_id, employee_number, days_in_period, paid_days, unpaid_leave_days, gross_pay, taxable_annual_income, income_tax_monthly,
             eobi_employee_contribution, eobi_employer_contribution, net_pay, calculation_breakdown, status) VALUES ($1,$2,$3,$4,30,30,0,$5,$5,1000,370,1850,$6,'{}'::jsonb,'final')`,
          [a, run, e, `P-${e.slice(0, 4)}`, gross, net]
        );
      }
    });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  // ---------------------------------------------------------------- presets, comparison, drill-down
  describe("date presets, comparison and drill-down", () => {
    it("a preset replaces the date range and the comparison measures against the equal period before", async () => {
      const r = await reports.run(hr, "E03", {}, { preset: "last30Days", compare: true });
      expect(r.dateRange).toEqual({ from: day(-29), to: today });
      expect(r.comparison).toEqual({ from: day(-59), to: day(-30) });
      const total = r.kpis.find((k) => k.previous !== undefined);
      expect(total).toBeDefined();
      expect(typeof total?.delta).toBe("number");
    });
    it("comparison and presets are refused on a report with no date range", async () => {
      await expect(reports.run(hr, "A03", {}, { compare: true })).rejects.toThrow(BadRequestException);
      await expect(reports.run(hr, "A03", {}, { preset: "thisMonth" })).rejects.toThrow(BadRequestException);
    });
    it("applyComparison leaves a KPI alone when it has no twin", () => {
      const out = applyComparison(
        [{ key: "x", label: "X", value: 10, unit: "count" }, { key: "y", label: "Y", value: 5, unit: "count" }, { key: "z", label: "Z", value: null, unit: "count" }],
        [{ key: "x", label: "X", value: 4, unit: "count" }, { key: "z", label: "Z", value: 3, unit: "count" }]
      );
      expect(out[0]).toMatchObject({ previous: 4, delta: 6 });
      expect(out[1]).toEqual({ key: "y", label: "Y", value: 5, unit: "count" });
      expect(out[2]).toEqual({ key: "z", label: "Z", value: null, unit: "count" });
    });
    it("a grouped headcount report tells the screen how to open the matching employees", async () => {
      const r = await reports.run(hr, "A03", {});
      expect(r.drill).toMatchObject({ reportId: "B01", filter: "department", rowKey: "_key" });
      const eng = r.rows.find((x) => x.label === "Engineering");
      expect(typeof eng?._key).toBe("string");
      const drilled = await reports.run(hr, "B01", { department: eng?._key as string });
      expect(drilled.totalRows).toBe(eng?.headcount);
    });
  });

  // ---------------------------------------------------------------- the builder
  describe("Report Builder", () => {
    const byDept: BuilderDefinition = { dataset: "employees", groupBy: ["department"], measures: [{ field: null, aggregate: "count" }], sort: { by: "count_rows", direction: "desc" } };

    it("totals employees by department with exact counts", async () => {
      const { result } = await builder.run(hr, byDept, { rowLimit: 500, kind: "run" });
      const m = Object.fromEntries(result.rows.map((r) => [r.department, r.count_rows]));
      expect(m["Engineering"]).toBe(4); // the two HR users and e1, e2
      expect((Object.values(m) as unknown[]).reduce<number>((s, n) => s + Number(n), 0)).toBe(7);
      expect(result.charts[0]?.kind).toBe("bar");
      expect(result.reportId).toBe("X00");
    });
    it("a line manager only ever sees their own direct reports", async () => {
      const { result, access } = await builder.run(mgr, { dataset: "employees", columns: ["employee_number", "department"] }, { rowLimit: 500, kind: "run" });
      expect(access.scope).toBe("team");
      expect(result.rows.length).toBe(2);
    });
    it("employee self service cannot build, and a manager has no payroll data", async () => {
      await expect(builder.catalog(ess)).rejects.toThrow(ForbiddenException);
      await expect(builder.run(mgr, { dataset: "payslips", columns: ["employee"] }, { rowLimit: 500, kind: "run" })).rejects.toThrow(ForbiddenException);
      await expect(builder.run(ess, byDept, { rowLimit: 500, kind: "run" })).rejects.toThrow(ForbiddenException);
    });
    it("HR sees payslip totals; the manager's catalog does not list payroll or recruitment data", async () => {
      const { result } = await builder.run(hr, { dataset: "payslips", measures: [{ field: "gross_pay", aggregate: "sum" }, { field: "net_pay", aggregate: "avg" }] }, { rowLimit: 500, kind: "run" });
      expect(result.rows[0]).toMatchObject({ sum_gross_pay: 220000, avg_net_pay: 97500 });
      const cat = await builder.catalog(mgr);
      expect(cat.datasets.map((d) => d.key)).not.toContain("payslips");
      expect(cat.datasets.map((d) => d.key)).not.toContain("applications");
    });
    it("monthly buckets draw a line chart", async () => {
      const { result } = await builder.run(hr, { dataset: "leave_requests", groupBy: ["start_date@month"], measures: [{ field: "days", aggregate: "sum" }] }, { rowLimit: 500, kind: "run" });
      expect(result.charts[0]?.kind).toBe("line");
      expect(result.rows.reduce((s, r) => s + Number(r.sum_days), 0)).toBe(6);
    });
    it("filters are bound values: a hostile value is just text that matches nothing", async () => {
      const def: BuilderDefinition = { dataset: "employees", columns: ["employee"], filters: [{ field: "department", op: "eq", value: "x'; DROP TABLE employees; --" }] };
      const { result } = await builder.run(hr, def, { rowLimit: 500, kind: "run" });
      expect(result.rows).toEqual([]);
      const c = await builder.run(hr, { dataset: "employees", columns: ["employee"], filters: [{ field: "department", op: "contains", value: "%" }] }, { rowLimit: 500, kind: "run" });
      expect(c.result.rows).toEqual([]); // % is matched literally, not as a wildcard
      const ok = await builder.run(hr, { dataset: "employees", columns: ["employee"], filters: [{ field: "department", op: "in", value: ["Engineering"] }] }, { rowLimit: 500, kind: "run" });
      expect(ok.result.rows.length).toBe(4);
    });
    it("rejects anything outside the allowlist", () => {
      for (const bad of [
        { dataset: "pg_shadow", columns: ["x"] },
        { dataset: "employees", columns: ["cnic"] },
        { dataset: "employees", columns: ["bank_account_number"] },
        { dataset: "employees", columns: ["employee"], filters: [{ field: "employee", op: "gt", value: "a" }] },
        { dataset: "employees", groupBy: ["employee_number"], measures: [{ field: "employee", aggregate: "sum" }] },
        { dataset: "employees", columns: ["employee"], extra: 1 },
        { dataset: "employees", columns: ["employee"], limit: 100000 },
        { dataset: "employees", columns: ["employee"], sort: { by: "x; DROP", direction: "asc" } },
        { dataset: "employees", groupBy: ["joined@decade"], measures: [] },
      ]) {
        expect(() => compile({ def: validateDefinition(bad) as never, companyId: a, scope: "tenant", callerEmployeeId: null, payrollAccess: null, rowLimit: 500 })).toThrow(BadRequestException);
      }
    });
    it("company B never sees company A's rows", async () => {
      const { result } = await builder.run(hrB, { dataset: "employees", columns: ["employee_number"] }, { rowLimit: 500, kind: "run" });
      expect(result.rows.length).toBe(1);
    });
  });

  // ---------------------------------------------------------------- saved reports and sharing
  describe("saved reports and sharing", () => {
    let savedId: string;
    it("saves a catalog report with its filters and period, and lists it for the owner only", async () => {
      const s = await saved.create(hr, { name: "Leave last 30 days", kind: "catalog", reportId: "E03", preset: "last30Days", filters: {}, compare: true });
      savedId = s.id;
      expect(s).toMatchObject({ isOwner: true, preset: "last30Days", compare: true, visibility: "private" });
      expect((await saved.list(hr)).mine.map((x) => x.id)).toContain(savedId);
      expect((await saved.list(hr2)).mine.map((x) => x.id)).not.toContain(savedId);
      await expect(saved.get(hr2, savedId)).rejects.toThrow(NotFoundException); // existence is not revealed
      await expect(saved.get(hrB, savedId)).rejects.toThrow(NotFoundException);
    });
    it("running it applies the saved period and comparison", async () => {
      const r = await saved.run(hr, savedId);
      expect(r.result.comparison).not.toBeNull();
      expect(r.saved.name).toBe("Leave last 30 days");
    });
    it("a person without the report permission cannot save it", async () => {
      await expect(saved.create(mgr, { name: "x", kind: "catalog", reportId: "F01" })).rejects.toThrow(ForbiddenException);
    });
    it("sharing needs reports.share; a share lets the person open it, and unsharing closes it again", async () => {
      await expect(saved.setShares(mgr, savedId, [])).rejects.toThrow();
      const targets = await saved.targets(hr);
      expect(targets.users.map((u) => u.label).join()).toContain("Hamid");
      await saved.setShares(hr, savedId, [{ type: "user", id: hr2.sub }]);
      expect((await saved.get(hr2, savedId)).isOwner).toBe(false);
      expect((await saved.list(hr2)).shared.map((x) => x.id)).toContain(savedId);
      expect((await saved.run(hr2, savedId)).result.reportId).toBe("E03");
      await expect(saved.update(hr2, savedId, { name: "hijack", kind: "catalog", reportId: "E03" })).rejects.toThrow(ForbiddenException);
      await expect(saved.archive(hr2, savedId)).rejects.toThrow(ForbiddenException);
      await expect(saved.shares(hr2, savedId)).rejects.toThrow(ForbiddenException);
      await saved.setShares(hr, savedId, []);
      await expect(saved.get(hr2, savedId)).rejects.toThrow(NotFoundException);
    });
    it("sharing by role reaches people holding the role, not others", async () => {
      await saved.setShares(hr, savedId, [{ type: "role", id: "line_manager" }]);
      expect((await saved.get(mgr, savedId)).id).toBe(savedId);
      await expect(saved.get(ess, savedId)).rejects.toThrow();
      // the manager may open it but E03 is team-scoped for them: the viewer's own access decides the numbers
      const r = await saved.run(mgr, savedId);
      expect(r.result.scope).toBe("team");
      await saved.setShares(hr, savedId, []);
    });
    it("a report shared with someone who has no access to its data is refused with a clear message", async () => {
      const f = await saved.create(hr, { name: "Payroll runs", kind: "catalog", reportId: "F01" });
      await saved.setShares(hr, f.id, [{ type: "user", id: mgr.sub }]);
      await expect(saved.run(mgr, f.id)).rejects.toThrow(/do not have access to the data/);
    });
    it("cannot share with someone outside the company", async () => {
      await expect(saved.setShares(hr, savedId, [{ type: "user", id: hrB.sub }])).rejects.toThrow(BadRequestException);
      await expect(saved.setShares(hr, savedId, [{ type: "role", id: "no_such_role" }])).rejects.toThrow(BadRequestException);
    });
    it("a custom report keeps its builder definition and is re-checked against the viewer", async () => {
      const c = await saved.create(hr, { name: "Headcount by dept", kind: "custom", definition: { dataset: "employees", groupBy: ["department"], measures: [{ field: null, aggregate: "count" }] } });
      expect(c.definition?.dataset).toBe("employees");
      const r = await saved.run(hr, c.id);
      expect(r.result.title).toBe("Headcount by dept");
      await expect(saved.create(hr, { name: "bad", kind: "custom", definition: { dataset: "employees", columns: ["salary_band"] } })).rejects.toThrow(BadRequestException);
    });
    it("archiving hides it", async () => {
      const s = await saved.create(hr, { name: "temp", kind: "catalog", reportId: "A03" });
      await saved.archive(hr, s.id);
      await expect(saved.get(hr, s.id)).rejects.toThrow(NotFoundException);
    });
  });

  // ---------------------------------------------------------------- export
  describe("export", () => {
    it("builds a real Excel file with typed cells, and a name that looks like a formula stays text", async () => {
      const f = await exportsSvc.build(hr, { kind: "catalog", reportId: "A03", filters: {} }, "xlsx");
      expect(f.filename.endsWith(".xlsx")).toBe(true);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(f.buffer as never);
      const ws = wb.getWorksheet("Report") as ExcelJS.Worksheet;
      let found: ExcelJS.Cell | null = null;
      ws.eachRow((row) => row.eachCell((cell) => { if (typeof cell.value === "string" && cell.value.startsWith("=HYPERLINK")) found = cell; }));
      expect(found).not.toBeNull();
      expect((found as unknown as ExcelJS.Cell).type).toBe(ExcelJS.ValueType.String);
      expect(wb.getWorksheet("About this report")).toBeDefined();
    });
    it("builds a PDF and a CSV", async () => {
      const pdf = await exportsSvc.build(hr, { kind: "catalog", reportId: "A03", filters: {} }, "pdf");
      expect(pdf.buffer.subarray(0, 4).toString()).toBe("%PDF");
      const csv = await exportsSvc.build(hr, { kind: "catalog", reportId: "A03", filters: {} }, "csv");
      expect(csv.buffer.toString("utf8").startsWith("﻿")).toBe(true);
      expect(csv.buffer.toString("utf8")).toContain("'=HYPERLINK");
    });
    it("needs the export permission and records history without any rows", async () => {
      await expect(exportsSvc.build(ess, { kind: "catalog", reportId: "A03", filters: {} }, "csv")).rejects.toThrow(ForbiddenException);
      const h = await exportsSvc.history(hr);
      expect(h.length).toBeGreaterThanOrEqual(3);
      expect(h[0]).toMatchObject({ reportId: "A03" });
    });
    it("exports a builder report", async () => {
      const f = await exportsSvc.build(hr, { kind: "custom", title: "By dept", definition: { dataset: "employees", groupBy: ["department"], measures: [{ field: null, aggregate: "count" }] } }, "xlsx");
      expect(f.rowCount).toBeGreaterThan(0);
      expect(f.reportId).toBe("X00");
    });
    it("a sensitive export is written to the audit log", async () => {
      await exportsSvc.build(hr, { kind: "custom", title: "Payslips", definition: { dataset: "payslips", columns: ["employee", "net_pay"] } }, "csv");
      const n = await fx((c) => c.query("SELECT COUNT(*)::int AS n FROM audit_log WHERE company_id = $1 AND action = 'report.export' AND target = 'custom:payslips'", [a]));
      expect(n.rows[0].n).toBe(1);
    });
  });

  // ---------------------------------------------------------------- dashboards
  describe("dashboards", () => {
    let dashId: string;
    it("creates a dashboard of KPI, chart and table widgets and draws it with live data", async () => {
      const cs = await saved.create(hr, { name: "Dept headcount", kind: "custom", definition: { dataset: "employees", groupBy: ["department"], measures: [{ field: null, aggregate: "count" }] } });
      const d = await dashboards.create(hr, {
        name: "People today",
        widgets: [
          { widgetType: "kpi", reportId: "A01" },
          { widgetType: "chart", savedReportId: cs.id },
          { widgetType: "table", reportId: "A03", title: "By department", config: { rows: 3 } },
        ],
      });
      dashId = d.id;
      expect(d.widgets.length).toBe(3);
      const data = await dashboards.data(hr, dashId);
      expect(data.widgets.every((w) => w.ok)).toBe(true);
      expect(data.widgets[0]?.result?.kpis.length).toBe(1);
      expect(data.widgets[1]?.result?.charts.length).toBe(1);
      expect(data.widgets[2]?.result?.rows.length).toBeLessThanOrEqual(3);
      expect(data.widgets[2]?.title).toBe("By department");
    });
    it("a shared dashboard shows each viewer only what they may run: no access means an error tile with no data", async () => {
      const d = await dashboards.create(hr, { name: "Mixed", widgets: [{ widgetType: "kpi", reportId: "A01" }, { widgetType: "table", reportId: "F01" }] });
      await dashboards.setShares(hr, d.id, [{ type: "user", id: mgr.sub }]);
      const data = await dashboards.data(mgr, d.id);
      const f01 = data.widgets.find((w) => w.title.includes("Payroll") || w.widgetId === d.widgets[1]?.id) ?? data.widgets[1];
      expect(f01?.ok).toBe(false);
      expect(f01?.result).toBeNull();
      expect(f01?.error).toMatch(/do not have access/);
      expect(data.widgets[0]?.result?.scope).toBe("team"); // the manager's own scope, not the owner's
      await expect(dashboards.data(ess, d.id)).rejects.toThrow();
    });
    it("only the owner edits; unknown reports and too many widgets are refused", async () => {
      await expect(dashboards.update(hr2, dashId, { name: "x" })).rejects.toThrow(NotFoundException);
      await expect(dashboards.create(hr, { name: "bad", widgets: [{ widgetType: "kpi", reportId: "Z99" }] })).rejects.toThrow(BadRequestException);
      await expect(dashboards.create(hr, { name: "big", widgets: Array.from({ length: 13 }, () => ({ widgetType: "kpi" as const, reportId: "A01" })) })).rejects.toThrow(BadRequestException);
      await expect(dashboards.create(mgr, { name: "mgr dash", widgets: [{ widgetType: "kpi", reportId: "F01" }] })).rejects.toThrow(ForbiddenException);
    });
  });

  // ---------------------------------------------------------------- schedules
  describe("schedules", () => {
    const base = { name: "Weekly directory", reportId: "B01", frequency: "weekly" as const, dayOfWeek: 1, dayOfMonth: null, hourLocal: 7, format: "xlsx" as const };
    let scheduleId: string;

    it("creates a schedule, with the owner always included, and warns about a recipient who could not receive it", async () => {
      const s = await schedules.create(hr, { ...base, recipientUserIds: [hr2.sub, mgr.sub] });
      scheduleId = s.id;
      expect(s.status).toBe("active");
      expect(s.nextRunAt).not.toBeNull();
      expect(s.recipients.map((r) => r.id)).toEqual(expect.arrayContaining([hr.sub, hr2.sub, mgr.sub]));
      // a team-scoped manager would see everyone in a file built with the HR admin's access
      expect(s.warnings?.some((w) => w.includes("Maha"))).toBe(true);
      expect(s.warnings?.some((w) => w.includes("Hamid"))).toBe(false);
    });
    it("needs reports.schedule and an exportable report", async () => {
      await expect(schedules.create(ess, { ...base, recipientUserIds: [] })).rejects.toThrow(ForbiddenException);
      await expect(schedules.create(hr, { ...base, reportId: "F01", name: "x", recipientUserIds: [hrB.sub] })).rejects.toThrow(BadRequestException); // outside the company
    });
    it("delivers a stored file now; only the owner and eligible recipients may download it", async () => {
      const d = await schedules.runNow(hr, scheduleId);
      expect(d.status).toBe("stored"); // no SMTP in the test environment, so the file waits in the app
      expect(d.recipientCount).toBe(2);
      expect(d.skippedRecipients).toBe(1);
      expect(d.downloadable).toBe(true);
      const own = await schedules.download(hr, d.id);
      expect(own.filename.endsWith(".xlsx")).toBe(true);
      expect((await schedules.download(hr2, d.id)).buffer.length).toBe(own.buffer.length);
      expect((await schedules.inbox(hr2)).map((i) => i.deliveryId)).toContain(d.id);
      await expect(schedules.download(mgr, d.id)).rejects.toThrow(); // a team-scoped manager is not eligible
      await expect(schedules.download(ess, d.id)).rejects.toThrow();
      await expect(schedules.download(hrB, d.id)).rejects.toThrow();
      expect((await schedules.deliveries(hr, scheduleId))[0]?.id).toBe(d.id);
    });
    it("another person cannot see, change or run someone else's schedule", async () => {
      await expect(schedules.runNow(hr2, scheduleId)).rejects.toThrow(NotFoundException);
      await expect(schedules.setStatus(hr2, scheduleId, "paused")).rejects.toThrow(NotFoundException);
      await expect(schedules.remove(hr2, scheduleId)).rejects.toThrow(NotFoundException);
      expect((await schedules.list(hr2)).map((s) => s.id)).not.toContain(scheduleId);
    });
    it("the worker delivers what is due exactly once and moves the next run forward", async () => {
      await fx((c) => c.query("UPDATE report_schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1", [scheduleId]));
      const n = await schedules.runDue();
      expect(n).toBeGreaterThanOrEqual(1);
      const row = (await fx((c) => c.query("SELECT next_run_at, last_status FROM report_schedules WHERE id = $1", [scheduleId]))).rows[0];
      expect(new Date(row.next_run_at).getTime()).toBeGreaterThan(Date.now());
      expect(row.last_status).toBe("stored");
      const again = await schedules.runDue();
      const count = (await fx((c) => c.query("SELECT COUNT(*)::int AS n FROM report_deliveries WHERE schedule_id = $1", [scheduleId]))).rows[0].n;
      expect(again).toBe(0);
      expect(count).toBe(2);
    });
    it("stops after repeated failures when the owner loses the right to the report", async () => {
      const s = await schedules.create(hr2, { ...base, name: "Doomed", recipientUserIds: [] });
      await fx((c) => c.query("DELETE FROM user_role_assignments WHERE user_account_id = $1", [hr2.sub]));
      for (let i = 0; i < 3; i++) {
        const d = await schedules.runNow(hr2, s.id).catch((e) => e);
        // the owner can no longer even open Reports: the schedule list itself is closed to them
        expect(d).toBeInstanceOf(ForbiddenException);
      }
      // the worker path (no session) records the failure
      await fx((c) => c.query("UPDATE report_schedules SET next_run_at = now() - interval '1 minute', status = 'active' WHERE id = $1", [s.id]));
      await schedules.runDue();
      const row = (await fx((c) => c.query("SELECT status, last_status, consecutive_failures FROM report_schedules WHERE id = $1", [s.id]))).rows[0];
      expect(row.last_status).toBe("failed: forbidden");
      expect(row.consecutive_failures).toBe(1);
      for (let i = 0; i < 2; i++) {
        await fx((c) => c.query("UPDATE report_schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1", [s.id]));
        await schedules.runDue();
      }
      expect((await fx((c) => c.query("SELECT status FROM report_schedules WHERE id = $1", [s.id]))).rows[0].status).toBe("failed");
    });
    it("expired files are removed", async () => {
      await fx((c) => c.query("UPDATE report_deliveries SET file_expires_at = now() - interval '1 day' WHERE schedule_id = $1", [scheduleId]));
      expect(await schedules.purgeExpiredFiles()).toBeGreaterThanOrEqual(1);
      expect((await schedules.deliveries(hr, scheduleId)).every((d) => !d.downloadable)).toBe(true);
    });
    it("pausing and removing work", async () => {
      expect((await schedules.setStatus(hr, scheduleId, "paused")).status).toBe("paused");
      expect((await schedules.setStatus(hr, scheduleId, "active")).status).toBe("active");
      await schedules.remove(hr, scheduleId);
      expect((await schedules.list(hr)).map((s) => s.id)).not.toContain(scheduleId);
    });
  });
});
