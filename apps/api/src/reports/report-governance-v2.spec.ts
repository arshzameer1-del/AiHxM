import { Pool, type PoolClient } from "pg";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { ReportsService } from "./reports.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "report-governance-v2-fixtures" };

/** O06, O07, O08, O09, O13, O14 and N06: reports over saved reports, sharing, schedules, the builder and dashboards. Real Postgres. */
describe("Reports about the reporting features (O06 O07 O08 O09 O13 O14 N06)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let reports: ReportsService;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let a: string;
  let b: string;
  let hr: RequestClaims;
  let hrB: RequestClaims;
  const fx = <T>(fn: (c: PoolClient) => Promise<T>) => db.withClaims(FIXTURE, fn);

  async function makeUser(client: PoolClient, companyId: string, tag: string, first: string): Promise<RequestClaims> {
    const u = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`gov-${tag}-${stamp}@example.com`]);
    const role = await client.query("SELECT id FROM roles WHERE key = 'hr_admin'");
    await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, companyId, role.rows[0].id]);
    const p = await client.query("INSERT INTO persons (company_id, full_name) VALUES ($1, $2) RETURNING id", [companyId, first]);
    await client.query(
      `INSERT INTO employees (company_id, employee_number, first_name, last_name, person_id, employment_status, date_of_joining, user_account_id)
       VALUES ($1, $2, $3, 'Owner', $4, 'active', current_date - 100, $5)`,
      [companyId, `G-${tag}-${stamp}`.slice(0, 30), first, p.rows[0].id, u.rows[0].id]
    );
    return { is_platform_admin: false, company_id: companyId, sub: u.rows[0].id };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    reports = new ReportsService(db, new RbacService(db), new EntitlementsService(db), new AuditService());
    await fx(async (client) => {
      const mk = async (label: string) => {
        const r = await client.query("INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, 'Asia/Karachi') RETURNING id", [`Gov ${label} ${stamp}`, `gov-${label}-${stamp}`.toLowerCase()]);
        await client.query("INSERT INTO company_config (company_id, enabled_modules) VALUES ($1, $2::jsonb)", [r.rows[0].id, JSON.stringify(["employee"])]);
        await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [r.rows[0].id]);
        return r.rows[0].id as string;
      };
      a = await mk("a");
      b = await mk("b");
      hr = await makeUser(client, a, "hr", "Hina");
      hrB = await makeUser(client, b, "hrb", "Bilal");
      const other = await makeUser(client, a, "other", "Omar");

      const saved = async (name: string, kind: "catalog" | "custom", reportId: string | null, definition: object, visibility: string) =>
        (await client.query(
          `INSERT INTO saved_reports (company_id, owner_user_account_id, name, kind, report_id, definition, visibility) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING id`,
          [a, hr.sub, name, kind, reportId, JSON.stringify(definition), visibility]
        )).rows[0].id as string;
      const s1 = await saved("Quarterly headcount", "catalog", "A03", {}, "shared");
      const s2 = await saved("CEO pay watch", "catalog", "F02", {}, "private");
      const s3 = await saved("Staff by department", "custom", null, { dataset: "employees", columns: ["employee_number", "department"], groupBy: ["department"], measures: [{ field: null, aggregate: "count" }], filters: [{ field: "department", op: "eq", value: "x" }] }, "private");
      const s4 = await saved("Leave days", "custom", null, { dataset: "leave_requests", groupBy: ["department"], measures: [{ field: "days", aggregate: "sum" }] }, "private");
      await client.query("INSERT INTO saved_reports (company_id, owner_user_account_id, name, kind, report_id, visibility, archived_at) VALUES ($1,$2,'Old',$3,'A03','private', now())", [a, hr.sub, "catalog"]);
      await client.query("INSERT INTO report_shares (company_id, saved_report_id, grantee_type, grantee_user_account_id) VALUES ($1,$2,'user',$3)", [a, s1, other.sub]);
      await client.query("INSERT INTO report_shares (company_id, saved_report_id, grantee_type, grantee_role_key) VALUES ($1,$2,'role','line_manager')", [a, s1]);

      const dash = (await client.query("INSERT INTO dashboards (company_id, owner_user_account_id, name, visibility) VALUES ($1,$2,'People board','shared') RETURNING id", [a, hr.sub])).rows[0].id;
      await client.query("INSERT INTO report_shares (company_id, dashboard_id, grantee_type, grantee_user_account_id) VALUES ($1,$2,'user',$3)", [a, dash, other.sub]);
      const w = (type: string, rid: string | null, sid: string | null, pos: number) =>
        client.query("INSERT INTO dashboard_widgets (company_id, dashboard_id, position, widget_type, report_id, saved_report_id) VALUES ($1,$2,$3,$4,$5,$6)", [a, dash, pos, type, rid, sid]);
      await w("kpi", "A03", null, 0);
      await w("chart", "A03", null, 1);
      await w("table", null, s3, 2);

      const sched = async (name: string, status: string, failures: number, nextOffsetMin: number) =>
        (await client.query(
          `INSERT INTO report_schedules (company_id, owner_user_account_id, name, saved_report_id, frequency, hour_local, format, recipients, status, next_run_at, last_run_at, consecutive_failures)
           VALUES ($1,$2,$3,$4,'daily',7,'xlsx','[{"userAccountId":"x"},{"userAccountId":"y"}]'::jsonb,$5, now() + ($6 || ' minutes')::interval, now() - interval '1 day', $7) RETURNING id`,
          [a, hr.sub, name, s1, status, String(nextOffsetMin), failures]
        )).rows[0].id as string;
      const ok = await sched("Monday headcount", "active", 0, 600);
      const bad = await sched("Broken one", "failed", 3, 600);
      await sched("Failing now", "active", 1, 600);
      await sched("Late", "active", 0, -120);
      await sched("On hold", "paused", 0, 600);
      const delivery = (sid: string, status: string, err: string | null) =>
        client.query("INSERT INTO report_deliveries (company_id, schedule_id, status, error_category, run_at) VALUES ($1,$2,$3,$4,now())", [a, sid, status, err]);
      await delivery(ok, "sent", null);
      await delivery(ok, "stored", null);
      await delivery(ok, "stored", null);
      await delivery(bad, "failed", "forbidden");
      await delivery(bad, "skipped", null);
      void s2; void s4;
    });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  const kpi = (r: { kpis: { key: string; value: number | null }[] }, key: string) => r.kpis.find((k) => k.key === key)?.value;

  it("O06 lists active saved reports, hides the name of private ones and counts shares and schedules", async () => {
    const r = await reports.run(hr, "O06", {});
    expect(r.rows).toHaveLength(4);
    const names = r.rows.map((x) => x.name);
    expect(names).toContain("Quarterly headcount");
    expect(names).not.toContain("CEO pay watch");
    expect(names.filter((n) => n === "Private report")).toHaveLength(3);
    const shared = r.rows.find((x) => x.name === "Quarterly headcount");
    expect(shared).toMatchObject({ owner: "Hina Owner", kind: "Library report", source: "A03", visibility: "Shared", sharedWith: 2, schedules: 5 });
    expect(r.rows.find((x) => x.source === "Employees")).toMatchObject({ kind: "Built in Report Builder" });
    expect(kpi(r, "shared")).toBe(1);
    expect(kpi(r, "custom")).toBe(2);
  });

  it("O07 lists the shared report and the shared dashboard with people and roles", async () => {
    const r = await reports.run(hr, "O07", {});
    expect(r.rows).toHaveLength(2);
    expect(r.rows.find((x) => x.type === "Saved report")).toMatchObject({ name: "Quarterly headcount", people: 1, roles: 1 });
    expect(r.rows.find((x) => x.type === "Dashboard")).toMatchObject({ name: "People board", people: 1, roles: 0 });
    expect(kpi(r, "people")).toBe(2);
  });

  it("O08 lists every schedule, failed ones first, with the recipient count", async () => {
    const r = await reports.run(hr, "O08", {});
    expect(r.rows).toHaveLength(5);
    expect(r.rows[0]).toMatchObject({ name: "Broken one", status: "Failed", recipients: 2, format: "XLSX", frequency: "Daily" });
    expect(kpi(r, "active")).toBe(3);
    expect(kpi(r, "failed")).toBe(1);
  });

  it("O09 counts outcomes this month and leaves skipped runs out of the success rate", async () => {
    const r = await reports.run(hr, "O09", {});
    const total = (k: string) => r.rows.reduce((s, x) => s + Number(x[k]), 0);
    expect(total("runs")).toBe(5);
    expect(total("sent")).toBe(1);
    expect(total("stored")).toBe(2);
    expect(total("failed")).toBe(1);
    expect(total("skipped")).toBe(1);
    expect(kpi(r, "success")).toBe(75); // 3 of 4 attempted
  });

  it("O13 counts where each field is used in saved Report Builder reports", async () => {
    const r = await reports.run(hr, "O13", {});
    const dept = r.rows.find((x) => x.dataset === "Employees" && x.field === "Department");
    expect(dept).toMatchObject({ reports: 1, asColumn: 1, asGroup: 1, asFilter: 1, asMeasure: 0 });
    const days = r.rows.find((x) => x.dataset === "Leave Requests" && x.field === "Days");
    expect(days).toMatchObject({ reports: 1, asMeasure: 1 });
    expect(r.rows.find((x) => x.dataset === "Leave Requests" && x.field === "Department")).toMatchObject({ asGroup: 1 });
  });

  it("O14 counts widgets by the report they show", async () => {
    const r = await reports.run(hr, "O14", {});
    expect(r.rows.find((x) => x.source === "A03")).toMatchObject({ widgets: 2, dashboards: 1, numbers: 1, charts: 1, tables: 0 });
    expect(r.rows.find((x) => x.source === "Custom report (Report Builder)")).toMatchObject({ widgets: 1, tables: 1 });
  });

  it("N06 sorts failing schedules first and names the last error category", async () => {
    const r = await reports.run(hr, "N06", {});
    expect(r.rows.map((x) => x.health)).toEqual(["Failed", "Failing", "Overdue", "Healthy", "Paused"]);
    expect(r.rows[0]).toMatchObject({ name: "Broken one", failures: 3, error: "forbidden" });
    expect(kpi(r, "attention")).toBe(3);
    expect(kpi(r, "healthy")).toBe(1);
  });

  it("another company sees none of it", async () => {
    for (const id of ["O06", "O07", "O08", "O13", "O14", "N06"]) {
      const r = await reports.run(hrB, id, {});
      expect(r.rows).toHaveLength(0);
    }
    const o9 = await reports.run(hrB, "O09", {});
    expect(o9.rows.every((x) => Number(x.runs) === 0)).toBe(true);
  });
});
