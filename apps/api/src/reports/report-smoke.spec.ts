import { Pool, type PoolClient } from "pg";
import { ForbiddenException } from "@nestjs/common";
import { MODULE_KEYS, type ReportCatalogEntry, type ReportFilterKey } from "@aihxm/shared-types";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { ReportsService } from "./reports.service";
import { REPORT_CATALOG } from "./catalog/report-catalog";
import { decideAccess } from "./report-access";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "reports-smoke-fixtures" };
jest.setTimeout(120000);

/**
 * Runs EVERY available report, as a user who holds every permission and as a line manager, against a small real
 * company. It proves each query is valid SQL, honours each filter it declares, returns rows that match its columns,
 * and that nobody sees a report they should not. Figures are checked report by report in the domain specs.
 */
describe("every available report runs (real database)", () => {
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
  let co: string;
  let all: RequestClaims;
  let mgr: RequestClaims;
  let ou: string;
  let loc: string;
  const fx = <T>(fn: (client: PoolClient) => Promise<T>) => db.withClaims(FIXTURE, fn);

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    reports = new ReportsService(db, new RbacService(db), new EntitlementsService(db), new AuditService());
    today = (await fx((cl) => cl.query("SELECT ((now() AT TIME ZONE 'Asia/Karachi')::date)::text AS d"))).rows[0].d;
    await fx(async (client) => {
      const c = await client.query("INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, 'Asia/Karachi') RETURNING id", [`Smoke ${stamp}`, `smoke-${stamp}`.toLowerCase()]);
      co = c.rows[0].id;
      await client.query("INSERT INTO company_config (company_id, enabled_modules) VALUES ($1, $2::jsonb)", [co, JSON.stringify(MODULE_KEYS)]);
      for (const m of MODULE_KEYS) await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, $2, true)", [co, m]);

      const role = await client.query("INSERT INTO roles (key, name) VALUES ($1, 'Smoke all') RETURNING id", [`smoke_all_${stamp}`]);
      await client.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions", [role.rows[0].id]);
      const mk = async (tag: string, roleId: string) => {
        const u = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`smoke-${tag}-${stamp}@example.com`]);
        await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, co, roleId]);
        return { is_platform_admin: false, company_id: co, sub: u.rows[0].id as string };
      };
      all = await mk("all", role.rows[0].id);
      const lm = await client.query("SELECT id FROM roles WHERE key = 'line_manager'");
      mgr = await mk("mgr", lm.rows[0].id);

      ou = (await client.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', 'Engineering') RETURNING id", [co])).rows[0].id;
      loc = (await client.query("INSERT INTO locations (company_id, location_type, name) VALUES ($1, 'city', 'Lahore') RETURNING id", [co])).rows[0].id;
      const emp = async (n: string, joined: string, extra: { user?: string; ou?: string; status?: string; term?: string | null } = {}) => {
        const p = await client.query("INSERT INTO persons (company_id, full_name) VALUES ($1, $2) RETURNING id", [co, `Person ${n}`]);
        const r = await client.query(
          `INSERT INTO employees (company_id, employee_number, first_name, last_name, person_id, employment_status, date_of_joining, termination_date, org_unit_id, location_id, user_account_id)
           VALUES ($1, $2, 'Smoke', $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [co, `S-${n}-${stamp}`.slice(0, 30), `Emp${n}`, p.rows[0].id, extra.status ?? "active", joined, extra.term ?? null, extra.ou ?? ou, loc, extra.user ?? null]
        );
        return r.rows[0].id as string;
      };
      const boss = await emp("1", day(-500), { user: mgr.sub });
      const e2 = await emp("2", day(-300));
      const e3 = await emp("3", day(-40), {});
      await emp("4", day(-400), { status: "terminated", term: day(-20) });
      for (const e of [e2, e3]) await client.query("INSERT INTO org_relationships (company_id, employee_id, manager_employee_id, relationship_type) VALUES ($1, $2, $3, 'direct')", [co, e, boss]);
      await client.query("INSERT INTO leave_requests (company_id, employee_id, leave_type, start_date, end_date, days_requested, status, submitted_by_user_account_id) VALUES ($1,$2,'annual',$3,$4,2,'approved',$5)", [co, e2, day(-10), day(-9), all.sub]);
      await client.query("INSERT INTO employee_important_dates (company_id, employee_id, date_type, date_value, status) VALUES ($1,$2,'probation_end',$3,'active'), ($1,$2,'contract_end',$4,'active')", [co, e3, day(20), day(40)]);
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  const SAMPLE: Record<Exclude<ReportFilterKey, "dateRange">, () => string> = {
    department: () => ou,
    location: () => loc,
    employmentType: () => "permanent",
    employmentStatus: () => "active",
    leaveType: () => "annual",
    requestStatus: () => "pending",
    runStatus: () => "draft",
  };

  async function availableFor(claims: RequestClaims): Promise<ReportCatalogEntry[]> {
    return (await reports.catalog(claims)).entries.filter((e) => e.status === "available");
  }

  it("the catalog's available list is exactly the reports that have a query", async () => {
    const entries = await availableFor(all);
    const fromCatalog = REPORT_CATALOG.filter((d) => d.status === "available").map((d) => d.id).sort();
    expect(entries.map((e) => e.id).sort()).toEqual(fromCatalog);
    expect(fromCatalog.length).toBeGreaterThan(10);
  });

  it("runs every available report as a user holding every permission, and returns well-formed results", async () => {
    const entries = await availableFor(all);
    const failures: string[] = [];
    for (const e of entries) {
      try {
        const r = await reports.run(all, e.id, {});
        if (r.columns.length === 0) failures.push(`${e.id}: no columns`);
        for (const row of r.rows) for (const c of r.columns) if (!(c.key in row)) failures.push(`${e.id}: row is missing "${c.key}"`);
        if (r.calculation.length === 0) failures.push(`${e.id}: no calculation notes`);
        if (r.reportId !== e.id || r.title !== e.title) failures.push(`${e.id}: identity mismatch`);
        for (const ch of r.charts) if (ch.series.length === 0) failures.push(`${e.id}: chart without series`);
        for (const k of r.kpis) if (!k.label) failures.push(`${e.id}: KPI without label`);
        const keys = r.kpis.map((k) => k.key);
        if (new Set(keys).size !== keys.length) failures.push(`${e.id}: duplicate KPI keys ${keys.join(",")}`);
        const labels = r.kpis.map((k) => k.label);
        if (new Set(labels).size !== labels.length) failures.push(`${e.id}: duplicate KPI labels ${labels.join(" | ")}`);
        if (e.filters.includes("dateRange") && !r.dateRange) failures.push(`${e.id}: declares a date range but ran without one`);
      } catch (err) {
        failures.push(`${e.id}: ${(err as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("accepts every filter each report declares, one at a time", async () => {
    const entries = await availableFor(all);
    const failures: string[] = [];
    for (const e of entries) {
      for (const f of e.filters) {
        const params: Record<string, string> = f === "dateRange" ? { dateFrom: day(-120), dateTo: day(30) } : { [f]: SAMPLE[f]() };
        try {
          const r = await reports.run(all, e.id, params);
          if (f !== "dateRange" && r.appliedFilters[f] === undefined) failures.push(`${e.id}: ${f} not echoed back`);
        } catch (err) {
          failures.push(`${e.id} with ${f}: ${(err as Error).message}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("rejects a filter a report does not declare", async () => {
    const entries = await availableFor(all);
    for (const e of entries) {
      const undeclared = (["department", "location", "employmentType", "employmentStatus", "leaveType", "requestStatus", "runStatus"] as const).find((f) => !e.filters.includes(f));
      if (!undeclared) continue;
      await expect(reports.run(all, e.id, { [undeclared]: SAMPLE[undeclared]() })).rejects.toThrow(/does not accept/);
    }
  });

  it("a line manager runs exactly the team-scoped reports and is refused all others", async () => {
    const visible = new Set((await reports.catalog(mgr)).entries.map((e) => e.id));
    const failures: string[] = [];
    for (const def of REPORT_CATALOG.filter((d) => d.status === "available")) {
      if (visible.has(def.id)) {
        try {
          const r = await reports.run(mgr, def.id, {});
          if (r.scope !== "team") failures.push(`${def.id}: manager scope was ${r.scope}`);
        } catch (err) {
          failures.push(`${def.id}: ${(err as Error).message}`);
        }
      } else {
        await expect(reports.run(mgr, def.id, {})).rejects.toThrow(ForbiddenException);
      }
    }
    expect(failures).toEqual([]);
    // the policy function agrees with what the service did
    const held = new Set(["reports.view", "employee.view.team", "leave_request.view.team", "performance_review.view.team"]);
    const modules = new Set<string>(MODULE_KEYS);
    for (const def of REPORT_CATALOG) {
      const a = decideAccess(def, held, modules);
      if (a) expect(a.scope).toBe("team");
    }
  });

  it("exports every exportable report as CSV with a header block and no formula-leading cells", async () => {
    const entries = (await availableFor(all)).filter((e) => e.canExport);
    expect(entries.length).toBeGreaterThan(5);
    const failures: string[] = [];
    for (const e of entries) {
      try {
        const out = await reports.exportCsv(all, e.id, {});
        const lines = out.csv.replace(/^\uFEFF/, "").split("\r\n").filter(Boolean);
        if (!lines[0].startsWith("# ")) failures.push(`${e.id}: CSV has no metadata header`);
        for (const line of lines.slice(1)) {
          for (const m of line.matchAll(/("(?:[^"]|"")*"|[^,]*)(?:,|$)/g)) {
            const cell = m[1].replace(/^"|"$/g, "").replace(/""/g, '"');
            if (/^[=+@\t\r]/.test(cell) || (/^-/.test(cell) && !/^-?\d+(\.\d+)?$/.test(cell))) failures.push(`${e.id}: formula-leading cell: ${cell.slice(0, 40)}`);
          }
        }
      } catch (err) {
        failures.push(`${e.id}: ${(err as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
