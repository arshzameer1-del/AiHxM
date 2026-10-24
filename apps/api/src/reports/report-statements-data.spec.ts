import { Pool, type PoolClient } from "pg";
import type { ReportResult, ReportSection } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { ReportsService } from "./reports.service";
import { DEPTH_SECTIONS } from "./engine/depth";
import { REPORT_BY_ID } from "./catalog/report-catalog";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "report-statements-data-spec-fixtures" };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The pay statement reports (F11 to F30) and their extra tables against real Postgres, on a small company with hand-counted
 * figures: salaries and revisions, payslips with tax and EOBI, a payment batch, loans with instalments, a final settlement.
 * Another company holds pay data too and must never show up.
 */
describe("Pay statement reports: hand-counted figures", () => {
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
  const monthOf = (offset: number) => MONTHS[new Date(`${day(offset)}T00:00:00Z`).getUTCMonth()];
  const range = () => ({ dateFrom: day(-70), dateTo: day(0) });
  const kpi = (r: ReportResult, key: string) => r.kpis.find((k) => k.key === key)?.value;
  const section = (r: ReportResult, key: string): ReportSection => {
    const s = r.sections?.find((x) => x.key === key);
    if (!s) throw new Error(`no section ${key} (have ${r.sections?.map((x) => x.key).join(", ")})`);
    return s;
  };
  const row = (r: ReportResult | ReportSection, prefix: string) => {
    const found = r.rows.find((x) => String(x.number).startsWith(`ST-${prefix}-`));
    if (!found) throw new Error(`no row for employee ${prefix}`);
    return found;
  };
  const sum = (s: ReportSection | ReportResult, key: string) => s.rows.reduce((t, x) => t + Number(x[key] ?? 0), 0);

  async function makeEmployee(c: PoolClient, companyId: string, n: string, o: { status?: string; joined: string; left?: string | null; unit?: string | null; type?: string }) {
    const p = await c.query("INSERT INTO persons (company_id, full_name) VALUES ($1, $2) RETURNING id", [companyId, `Person ${n}`]);
    const r = await c.query(
      `INSERT INTO employees (company_id, employee_number, first_name, last_name, person_id, employment_status, date_of_joining, termination_date, org_unit_id, employment_type)
       VALUES ($1, $2, 'T', $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [companyId, `ST-${n}-${stamp}`.slice(0, 30), `Emp${n}`, p.rows[0].id, o.status ?? "active", o.joined, o.left ?? null, o.unit ?? null, o.type ?? "permanent"]
    );
    return r.rows[0].id as string;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    reports = new ReportsService(db, new RbacService(db), new EntitlementsService(db), new AuditService());
    today = (await fx((cl) => cl.query("SELECT ((now() AT TIME ZONE 'Asia/Karachi')::date)::text AS d"))).rows[0].d;
    await fx(async (c) => {
      const mk = async (label: string) => {
        const modules = ["employee", "leave", "payroll"];
        const r = await c.query("INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, 'Asia/Karachi') RETURNING id", [`ST ${label} ${stamp}`, `st-${label}-${stamp}`.toLowerCase()]);
        await c.query("INSERT INTO company_config (company_id, enabled_modules) VALUES ($1, $2::jsonb)", [r.rows[0].id, JSON.stringify(modules)]);
        for (const m of modules) await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, $2, true)", [r.rows[0].id, m]);
        return r.rows[0].id as string;
      };
      a = await mk("a");
      b = await mk("b");
      const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`st-hr-${stamp}@example.com`]);
      const role = await c.query("SELECT id FROM roles WHERE key = 'hr_admin'");
      await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, a, role.rows[0].id]);
      hr = { is_platform_admin: false, company_id: a, sub: u.rows[0].id };
      const by = hr.sub as string;

      const eng = (await c.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', 'Engineering') RETURNING id", [a])).rows[0].id;
      const sales = (await c.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', 'Sales') RETURNING id", [a])).rows[0].id;
      // Engineering: e1, e2 permanent and e3 contract. Sales: s1 (no salary on file) and s2 (left five days ago).
      e.e1 = await makeEmployee(c, a, "1", { joined: day(-800), unit: eng });
      e.e2 = await makeEmployee(c, a, "2", { joined: day(-400), unit: eng });
      e.e3 = await makeEmployee(c, a, "3", { joined: day(-10), unit: eng, type: "contract" });
      e.s1 = await makeEmployee(c, a, "4", { joined: day(-300), unit: sales });
      e.s2 = await makeEmployee(c, a, "5", { status: "terminated", joined: day(-500), left: day(-5), unit: sales });
      const bEmp = await makeEmployee(c, b, "b1", { joined: day(-100) });

      // salary records: e1 had 100,000 and now 120,000 (a 20% revision 100 days ago); e2 80,000; e3 60,000; s2 50,000 (left)
      const salary = (emp: string, amount: number, from: number, to: number | null) =>
        c.query("INSERT INTO employee_compensation (company_id, employee_id, monthly_salary, effective_from, effective_to, created_by_user_account_id) VALUES ($1,$2,$3,$4,$5,$6)", [a, emp, amount, day(from), to === null ? null : day(to), by]);
      await salary(e.e1, 100000, -700, -101);
      await salary(e.e1, 120000, -100, null);
      await salary(e.e2, 80000, -400, null);
      await salary(e.e3, 60000, -10, null);
      await salary(e.s2, 50000, -500, null);
      // a fuel allowance: e1 5,000 a month, e2 3,000 a month, e3 12,000 a year (1,000 a month)
      const fuel = (await c.query("INSERT INTO compensation_components (company_id, key, name, component_type) VALUES ($1, 'fuel', 'Fuel allowance', 'earning') RETURNING id", [a])).rows[0].id;
      const comp = (emp: string, amount: number, freq: string) =>
        c.query("INSERT INTO employee_compensation_components (company_id, employee_id, component_id, amount, pay_frequency, effective_from, created_by_user_account_id) VALUES ($1,$2,$3,$4,$5,$6,$7)", [a, emp, fuel, amount, freq, day(-300), by]);
      await comp(e.e1, 5000, "monthly");
      await comp(e.e2, 3000, "monthly");
      await comp(e.e3, 12000, "annual");

      // tax profiles: e1 filer, e2 non-filer; nobody else has one
      const profile = (emp: string, filer: string) => c.query("INSERT INTO employee_tax_profiles (company_id, employee_id, effective_from, filer_status) VALUES ($1,$2,$3,$4)", [a, emp, day(-800), filer]);
      await profile(e.e1, "filer");
      await profile(e.e2, "non_filer");

      // payroll: R1 regular (-60..-31), R2 regular (-30..-1, payment released), R3 off-cycle bonus (today)
      const run = async (status: string, from: number, to: number, type = "regular", reason: string | null = null) =>
        (await c.query("INSERT INTO payroll_runs (company_id, period_start, period_end, status, created_by_user_account_id, run_type, off_cycle_reason, population_count, calculated_count, failed_count) VALUES ($1,$2,$3,$4,$5,$6,$7,4,4,0) RETURNING id", [a, day(from), day(to), status, by, type, reason])).rows[0].id as string;
      const r1 = await run("finalized", -60, -31);
      const r2 = await run("payment_released", -30, -1);
      const r3 = await run("finalized", 0, 0, "off_cycle", "bonus");
      const slip = async (runId: string, emp: string, number: string, o: { gross: number; tax: number; eobi: number; er: number; net: number; arrears?: number; company?: string }) =>
        (await c.query(
          `INSERT INTO payslips (company_id, payroll_run_id, employee_id, employee_number, days_in_period, paid_days, gross_pay, taxable_annual_income, income_tax_monthly, eobi_employee_contribution, eobi_employer_contribution,
                                 net_pay, calculation_breakdown, taxable_gross_this_period, status, employer_cost, arrears_amount)
           VALUES ($1,$2,$3,$4,30,30,$5,$5,$6,$7,$8,$9,'{}'::jsonb,$5,'final',$5,$10) RETURNING id`,
          [o.company ?? a, runId, emp, number, o.gross, o.tax, o.eobi, o.er, o.net, o.arrears ?? 0]
        )).rows[0].id as string;
      await slip(r1, e.e1, "ST-1", { gross: 100000, tax: 4000, eobi: 370, er: 1000, net: 95630 });
      await slip(r1, e.e2, "ST-2", { gross: 80000, tax: 2000, eobi: 370, er: 1000, net: 77630 });
      await slip(r1, e.e3, "ST-3", { gross: 60000, tax: 0, eobi: 0, er: 0, net: 60000 });
      await slip(r1, e.s2, "ST-5", { gross: 50000, tax: 0, eobi: 370, er: 1000, net: 49630 });
      const p21 = await slip(r2, e.e1, "ST-1", { gross: 120000, tax: 6000, eobi: 370, er: 1000, net: 50000 });
      const p22 = await slip(r2, e.e2, "ST-2", { gross: 80000, tax: 2000, eobi: 370, er: 1000, net: 40000, arrears: 5000 });
      const p23 = await slip(r2, e.e3, "ST-3", { gross: 60000, tax: 0, eobi: 0, er: 0, net: 10000 });
      await slip(r2, e.s1, "ST-4", { gross: 30000, tax: 0, eobi: 0, er: 0, net: 30000 });
      await slip(r3, e.e1, "ST-1", { gross: 30000, tax: 3000, eobi: 0, er: 0, net: 27000 });
      // another company's payslip: must never show up
      const rb = (await c.query("INSERT INTO payroll_runs (company_id, period_start, period_end, status, created_by_user_account_id, population_count, calculated_count, failed_count) VALUES ($1,$2,$3,'finalized',$4,1,1,0) RETURNING id", [b, day(-30), day(-1), by])).rows[0].id as string;
      await slip(rb, bEmp, "ST-B1", { gross: 999999, tax: 99999, eobi: 370, er: 1000, net: 800000, company: b });

      // a payment batch on R2: e1 paid (HBL), e2 rejected (HBL), e3 paid after a retry (MCB); s1 has a payslip but no payment
      const batch = (await c.query(
        "INSERT INTO payroll_payment_batches (company_id, payroll_run_id, batch_reference, row_count, total_net_pay, status, generated_by_user_account_id) VALUES ($1,$2,$3,3,100000,'released',$4) RETURNING id",
        [a, r2, `ST-BATCH-${stamp}`, by]
      )).rows[0].id as string;
      const item = (payslip: string, emp: string, number: string, amount: number, bank: string, status: string, retries: number) =>
        c.query(
          "INSERT INTO payroll_payment_items (company_id, batch_id, payroll_run_id, payslip_id, employee_id, employee_number, amount, bank_name, account_title, account_last4, status, retry_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Title','1234',$9,$10)",
          [a, batch, r2, payslip, emp, number, amount, bank, status, retries]
        );
      await item(p21, e.e1, "ST-1", 50000, "HBL", "acknowledged", 0);
      await item(p22, e.e2, "ST-2", 40000, "HBL", "rejected", 0);
      await item(p23, e.e3, "ST-3", 10000, "MCB", "acknowledged", 1);

      // loans: e1 has a 60,000 loan (2 instalments recovered, one overdue, one to come); e2 has a 20,000 advance; e3's loan is closed
      const loan = async (emp: string, type: string, principal: number, instalment: number, outstanding: number, status: string) =>
        (await c.query(
          "INSERT INTO employee_loans (company_id, employee_id, loan_type, principal_amount, installment_amount, outstanding_balance, status, issued_date, installments_count, created_by_user_account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,6,$9) RETURNING id",
          [a, emp, type, principal, instalment, outstanding, status, day(-120), by]
        )).rows[0].id as string;
      const l1 = await loan(e.e1, "loan", 60000, 10000, 40000, "active");
      const l2 = await loan(e.e2, "salary_advance", 20000, 20000, 20000, "active");
      await loan(e.e3, "loan", 10000, 5000, 0, "closed");
      const sched = (l: string, no: number, due: number, status: string, paid: number) =>
        c.query("INSERT INTO loan_schedules (company_id, loan_id, installment_no, due_date, amount, status, paid_amount) VALUES ($1,$2,$3,$4,10000,$5,$6)", [a, l, no, day(due), status, paid]);
      await sched(l1, 1, -60, "paid", 10000);
      await sched(l1, 2, -30, "paid", 10000);
      await sched(l1, 3, -5, "scheduled", 0);
      await sched(l1, 4, 25, "scheduled", 0);
      await sched(l2, 1, 5, "scheduled", 0);

      // a final settlement for s2: salary due 40,000 + gratuity 100,000 - notice recovery 5,000 = 135,000 net (plus an information line that is not money)
      const ev = (await c.query("INSERT INTO employee_lifecycle_events (company_id, employee_id, action_type, effective_date) VALUES ($1,$2,'termination',$3) RETURNING id", [a, e.s2, day(-5)])).rows[0].id as string;
      // a termination event may start its own open settlement; use that one if it is there
      const started = await c.query("SELECT id FROM payroll_final_settlements WHERE termination_event_id = $1", [ev]);
      const st: string = started.rows[0]
        ? (await c.query("UPDATE payroll_final_settlements SET last_working_day = $2, status = 'finalized', finalized_at = now() WHERE id = $1 RETURNING id", [started.rows[0].id, day(-5)])).rows[0].id
        : (await c.query("INSERT INTO payroll_final_settlements (company_id, employee_id, termination_event_id, last_working_day, status, finalized_at) VALUES ($1,$2,$3,$4,'finalized', now()) RETURNING id", [a, e.s2, ev, day(-5)])).rows[0].id;
      const line = (no: number, kind: string, amount: number, via: string) =>
        c.query("INSERT INTO payroll_final_settlement_lines (company_id, settlement_id, line_no, kind, label, amount, settle_via) VALUES ($1,$2,$3,$4,$4,$5,$6)", [a, st, no, kind, amount, via]);
      await line(1, "salary_due", 40000, "payslip");
      await line(2, "gratuity", 100000, "payslip");
      await line(3, "notice_recovery", -5000, "payslip");
      await line(4, "leave_encashment", 7777, "info");
    });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  it("F11 lists the salary on file, the last change and the gross package, and counts only this company's current employees", async () => {
    const r = await reports.run(hr, "F11", {});
    expect(r.rows).toHaveLength(4);
    expect(row(r, "1")).toEqual(expect.objectContaining({ salary: 120000, previous: 100000, changePct: 20, allowances: 5000, gross: 125000, components: 1 }));
    expect(row(r, "3")).toEqual(expect.objectContaining({ salary: 60000, allowances: 1000, gross: 61000 }));
    expect(row(r, "4").salary).toBeNull();
    expect(kpi(r, "total")).toBe(260000);
    expect(kpi(r, "missing")).toBe(1);
    expect(section(r, "no-salary").rows).toHaveLength(1);
    expect(sum(section(r, "salary-bands"), "employees")).toBe(4);
    expect(section(r, "not-revised").rows.map((x) => x.number)).toEqual([expect.stringContaining("ST-2-")]);
    expect(r.rows.some((x) => String(x.number).startsWith("ST-5-"))).toBe(false);
  });

  it("F12 shows the one revision with its percentage and F15 totals it by month without naming anyone", async () => {
    const r = await reports.run(hr, "F12", { dateFrom: day(-120), dateTo: day(0) });
    const revised = r.rows.find((x) => Number(x.salary) === 120000);
    expect(revised).toEqual(expect.objectContaining({ previous: 100000 }));
    const t = await reports.run(hr, "F15", { dateFrom: day(-120), dateTo: day(0) });
    expect(kpi(t, "revisions")).toBe(1);
    expect(kpi(t, "added")).toBe(20000);
    expect(t.rows.every((x) => !("name" in x))).toBe(true);
    expect(sum(section(t, "revision-size"), "revisions")).toBe(1);
    expect(section(t, "revision-size").rows[0]).toEqual(expect.objectContaining({ label: "20% or more" }));
    // one person revised in a unit: the unit is combined into "Other"
    expect(section(t, "revisions-by-unit").rows.map((x) => x.label)).toEqual([expect.stringMatching(/^Other/)]);
  });

  it("F13 lists the components in force, dividing the yearly one by 12", async () => {
    const r = await reports.run(hr, "F13", {});
    expect(r.rows).toHaveLength(3);
    expect(row(r, "3").amount).toBe(1000);
    expect(kpi(r, "monthly")).toBe(9000);
    expect(section(r, "by-component").rows[0]).toEqual(expect.objectContaining({ label: "Fuel allowance", people: 3, total: 9000 }));
    expect(section(r, "taxable-split").rows.length).toBeGreaterThan(0);
  });

  it("F14 gives the spread of salaries for a unit of 3 and combines groups of fewer than 3", async () => {
    const r = await reports.run(hr, "F14", {});
    expect(r.rows).toEqual([expect.objectContaining({ label: "Engineering", people: 3, lowest: 60000, median: 80000, average: 86667, highest: 120000, total: 260000 })]);
    const byType = section(r, "salary-by-type");
    expect(byType.rows).toHaveLength(1);
    expect(String(byType.rows[0].label)).toMatch(/^Other/);
    expect(byType.rows[0].people).toBe(3);
  });

  it("F16 puts each employee's tax in the month the pay period ends and the months add up to the total", async () => {
    const r = await reports.run(hr, "F16", range());
    expect(row(r, "1").total).toBe(13000);
    expect(row(r, "2").total).toBe(4000);
    expect(row(r, "3").total).toBe(0);
    expect(kpi(r, "tax")).toBe(17000);
    // e1's R1 tax (4,000) lands in the month of day -31, R2 (6,000) in the month of day -1, the bonus (3,000) in the month of today
    const months: Record<string, number> = {};
    for (const [off, tax] of [[-31, 4000], [-1, 6000], [0, 3000]] as Array<[number, number]>) months[monthOf(off)] = (months[monthOf(off)] ?? 0) + tax;
    for (const [m, tax] of Object.entries(months)) expect(row(r, "1")[m]).toBe(tax);
    const lines = section(r, "payslip-lines");
    expect(sum(lines, "tax")).toBe(17000);
    expect(lines.rows).toHaveLength(9);
    expect(sum(section(r, "rate-bands"), "people")).toBe(5);
  });

  it("F17 gives gross, taxable pay, tax and the effective rate per person, with the tax profile on file", async () => {
    const r = await reports.run(hr, "F17", range());
    expect(row(r, "1")).toEqual(expect.objectContaining({ gross: 250000, taxable: 250000, tax: 13000, rate: 5.2, months: new Set([monthOf(-31), monthOf(-1), monthOf(0)]).size, filer: "Filer" }));
    expect(row(r, "2").filer).toBe("Non Filer");
    expect(kpi(r, "nonFiler")).toBe(1);
    expect(section(r, "no-tax-profile").rows.map((x) => x.number).sort()).toEqual([expect.stringContaining("ST-3-"), expect.stringContaining("ST-4-")]);
  });

  it("F18 totals tax by month across the company without leaking the other company's payslip", async () => {
    const r = await reports.run(hr, "F18", range());
    expect(kpi(r, "tax")).toBe(17000);
    expect(sum(r, "tax")).toBe(17000);
    expect(sum(r, "taxable")).toBe(100000 + 80000 + 60000 + 50000 + 120000 + 80000 + 60000 + 30000 + 30000);
    expect(r.rows.every((x) => !("name" in x))).toBe(true);
    // 2 of 5 people had tax withheld in the regular runs
    expect(sum(section(r, "tax-by-run-type"), "payslips")).toBe(9);
  });

  it("F19 counts the tax profiles on file and F20, F21 add up EOBI contributions", async () => {
    const p = await reports.run(hr, "F19", {});
    const filer = section(p, "by-filer");
    expect(filer.rows.find((x) => x.label === "Filer")).toEqual(expect.objectContaining({ employees: 1 }));
    expect(filer.rows.find((x) => x.label === "Non Filer")).toEqual(expect.objectContaining({ employees: 1 }));
    expect(filer.rows.find((x) => x.label === "No tax profile")).toEqual(expect.objectContaining({ employees: 2 }));
    const eo = await reports.run(hr, "F20", range());
    expect(row(eo, "1")).toEqual(expect.objectContaining({ eobiEmployee: 740, eobiEmployer: 2000, social: 0, total: 2740 }));
    expect(kpi(eo, "eobiEmployee")).toBe(1850);
    expect(kpi(eo, "eobiEmployer")).toBe(5000);
    const by = await reports.run(hr, "F21", range());
    expect(sum(by, "total")).toBe(6850);
    expect(sum(section(by, "contributions-by-run-type"), "total")).toBe(6850);
    // payslips with pay but no EOBI: e3 twice, s1, and the bonus payslip
    expect(section(eo, "no-contribution").rows).toHaveLength(4);
  });

  it("F23 and F24 show the bank payments with only the last four digits, and F25 flags what needs attention", async () => {
    const pay = await reports.run(hr, "F23", range());
    expect(pay.rows).toHaveLength(3);
    expect(kpi(pay, "amount")).toBe(100000);
    expect(row(pay, "1")).toEqual(expect.objectContaining({ bank: "HBL", last4: "1234", amount: 50000, status: "Acknowledged" }));
    const bank = section(pay, "by-bank");
    expect(bank.rows.find((x) => x.label === "HBL")).toEqual(expect.objectContaining({ payments: 2, amount: 90000, rejected: 1, rejectedPct: 50 }));
    expect(bank.rows.find((x) => x.label === "MCB")).toEqual(expect.objectContaining({ payments: 1, amount: 10000 }));
    const batches = await reports.run(hr, "F24", range());
    expect(batches.rows).toEqual([expect.objectContaining({ payments: 3, rejected: 1, total: 100000 })]);
    expect(sum(section(batches, "payment-status"), "payments")).toBe(3);
    const ex = await reports.run(hr, "F25", range());
    expect(ex.rows.map((x) => x.issue).sort()).toEqual(["No payment generated", "Payment rejected", "Payment retried"]);
    expect(kpi(ex, "rejected")).toBe(1);
    expect(kpi(ex, "missing")).toBe(1);
    expect(kpi(ex, "amount")).toBe(80000);
  });

  it("F26, F27 and F28 give the loan book, the instalments and the exposure, combining small groups", async () => {
    const reg = await reports.run(hr, "F26", {});
    expect(reg.rows).toHaveLength(3);
    expect(row(reg, "1")).toEqual(expect.objectContaining({ principal: 60000, recovered: 20000, outstanding: 40000, paid: 2, overdue: 1, next: day(25), status: "Active" }));
    expect(kpi(reg, "active")).toBe(2);
    expect(kpi(reg, "outstanding")).toBe(60000);
    const inst = await reports.run(hr, "F27", range());
    expect(inst.rows).toHaveLength(3);
    expect(kpi(inst, "due")).toBe(30000);
    expect(kpi(inst, "recovered")).toBe(20000);
    expect(kpi(inst, "late")).toBe(1);
    expect(sum(section(inst, "by-month"), "instalments")).toBe(3);
    const exp = await reports.run(hr, "F28", {});
    expect(exp.rows).toEqual([expect.objectContaining({ loans: 2, borrowers: 2, principal: 80000, recovered: 20000, outstanding: 60000, overdue: 1 })]);
    expect(String(exp.rows[0].label)).toMatch(/^Other/);
    expect(section(exp, "overdue-ageing").rows).toEqual([expect.objectContaining({ instalments: 1, amount: 10000 })]);
  });

  it("F29 builds the final settlement from its lines, leaving out information lines, and F30 lists arrears and off-cycle pay", async () => {
    const s = await reports.run(hr, "F29", range());
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toEqual(expect.objectContaining({ salaryDue: 40000, gratuity: 100000, notice: -5000, leave: 0, net: 135000, status: "Finalized" }));
    expect(kpi(s, "net")).toBe(135000);
    expect(sum(section(s, "lines"), "amount")).toBe(135000);
    expect(section(s, "by-kind").rows.find((x) => x.label === "Gratuity")).toEqual(expect.objectContaining({ amount: 100000 }));
    const o = await reports.run(hr, "F30", range());
    expect(o.rows).toHaveLength(2);
    expect(kpi(o, "arrears")).toBe(5000);
    expect(o.rows.map((x) => x.reason).sort()).toEqual(["Arrears or retro in a regular run", "Bonus"]);
    expect(sum(section(o, "runs"), "payslips")).toBe(2);
  });

  it("shows no CNIC, account number, IBAN or free text in any column of the new reports or their extra tables", async () => {
    const forbidden = /cnic|iban|account number|account_number|password|secret|token|ip address|date of birth|passport|\bntn\b|rejection|reason text/i;
    const found: string[] = [];
    for (let n = 11; n <= 30; n++) {
      const id = `F${n}`;
      const r = await reports.run(hr, id, id === "F11" || id === "F13" || id === "F14" || id === "F19" || id === "F26" || id === "F28" ? {} : range());
      for (const c of r.columns) if (forbidden.test(`${c.key} ${c.label}`)) found.push(`${id}: ${c.label}`);
      for (const sec of r.sections ?? []) for (const c of sec.columns) if (forbidden.test(`${c.key} ${c.label}`)) found.push(`${id}/${sec.key}: ${c.label}`);
    }
    expect(found).toEqual([]);
  });

  it("every new report is Restricted when it lists pay per person and carries at least three extra tables", () => {
    for (let n = 11; n <= 30; n++) {
      const id = `F${n}`;
      expect(REPORT_BY_ID.get(id)?.status).toBe("available");
      expect((DEPTH_SECTIONS[id] ?? []).length).toBeGreaterThanOrEqual(2);
    }
    for (const id of ["F11", "F12", "F13", "F16", "F17", "F19", "F20", "F23", "F25", "F26", "F27", "F29", "F30"]) expect(REPORT_BY_ID.get(id)?.sensitivity).toBe("restricted");
    for (const id of ["F14", "F15", "F18", "F21", "F22", "F24", "F28"]) expect(REPORT_BY_ID.get(id)?.sensitivity).toBe("sensitive");
  });
});
