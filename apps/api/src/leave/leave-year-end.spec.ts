import { Pool } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EmployeesService } from "../employees/employees.service";
import { EmployeeGroupsService } from "../employee-groups/employee-groups.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { RulesEngine } from "../rules-engine/rules-engine.engine";
import { LeaveLedgerService } from "./leave-ledger.service";
import { LeaveYearEndService } from "./leave-year-end.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "leave-year-end-fixtures" };

/** R2: carry-forward and expiry settings are applied at year end, against real Postgres. */
describe("Leave year end (carry-forward and expiry)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let ledger: LeaveLedgerService;
  let yearEnd: LeaveYearEndService;
  let companyId: string;
  let hr: RequestClaims;
  let a: string; // 9 days left at year end, none used in the new year
  let b: string; // 9 days left at year end, 3 used in January
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const sql = <T = Record<string, unknown>>(q: string, p: unknown[] = []) => db.withClaims(FIXTURE, async (c) => (await c.query(q, p)).rows as T[]);
  const bal = async (emp: string, type: string, year: number) => {
    const [r] = await sql<{ entitled_days: string; used_days: string; carried_forward_days: string; expired_days: string }>(
      "SELECT entitled_days, used_days, carried_forward_days, expired_days FROM leave_balances WHERE employee_id=$1 AND leave_type=$2 AND year=$3", [emp, type, year]);
    return r ? { entitled: Number(r.entitled_days), used: Number(r.used_days), carried: Number(r.carried_forward_days), expired: Number(r.expired_days), remaining: Number(r.entitled_days) - Number(r.used_days) } : null;
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    const employees = new EmployeesService(db, rbac, ent, audit, new LocalFileStorageService());
    const groups = new EmployeeGroupsService(db, rbac, ent, new EffectiveDatingEngine(), new RulesEngine());
    ledger = new LeaveLedgerService(db, rbac, ent, audit);
    yearEnd = new LeaveYearEndService(db, groups, ledger);

    companyId = await db.withClaims(FIXTURE, async (c) => {
      const co = await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`YearEnd ${stamp}`, `yearend-${stamp}`]);
      await c.query(`INSERT INTO company_config (company_id, enabled_modules, employee_number_format) VALUES ($1, '["employee","leave"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`, [co.rows[0].id]);
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true),($1,'leave',true)", [co.rows[0].id]);
      return co.rows[0].id as string;
    });
    const u = await db.withClaims(FIXTURE, async (c) => {
      const r = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`ye-hr-${stamp}@example.com`]);
      for (const role of ["hr_admin", "rbac_demo_full_access"]) await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE key=$3))", [r.rows[0].id, companyId, role]);
      return r.rows[0].id as string;
    });
    hr = { is_platform_admin: false, company_id: companyId, sub: u };
    a = (await employees.create(hr, { firstName: "Ayesha", lastName: "A" })).id;
    b = (await employees.create(hr, { firstName: "Bilal", lastName: "B" })).id;
    await groups.createLeavePolicy(hr, { name: "Default", annualLeaveDays: 14, casualLeaveDays: 10, sickLeaveDays: 8, isDefault: true });
    // annual: carry up to 5 days, for 3 months; casual keeps the default (no carry-forward)
    await sql("UPDATE leave_types SET carry_forward_allowed = true, carry_forward_cap_days = 5, carry_forward_expiry_months = 3, encashable = false WHERE company_id = $1 AND code = 'annual'", [companyId]);
    await sql("UPDATE leave_types SET carry_forward_allowed = false, encashable = false WHERE company_id = $1 AND code = 'casual'", [companyId]);
    for (const emp of [a, b]) {
      await db.withClaims(FIXTURE, async (c) => {
        for (const type of ["annual", "casual"]) {
          await ledger.post(c, { companyId, employeeId: emp, leaveType: type, year: 2026, entryType: "opening", days: 14, effectiveDate: "2026-01-01", sourceType: "policy", sourceKey: "policy:2026" });
          await ledger.post(c, { companyId, employeeId: emp, leaveType: type, year: 2026, entryType: "deduction", days: -5, effectiveDate: "2026-06-01", sourceType: "test", sourceKey: "used-2026" });
        }
      });
    }
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  it("carries the unused balance up to the cap, forfeits the rest, and zeroes the closed year", async () => {
    const r = await yearEnd.runCompany(companyId, "2027-01-02");
    expect(r.carried).toBe(2);
    const closed = await bal(a, "annual", 2026);
    expect(closed!.remaining).toBe(0);
    expect(closed!.expired).toBe(4); // 9 left, 5 carried, 4 forfeited
    const next = await bal(a, "annual", 2027);
    expect(next!.carried).toBe(5);
    const [opening] = await sql<{ days: string }>("SELECT days FROM leave_ledger WHERE employee_id=$1 AND leave_type='annual' AND year=2027 AND entry_type='opening'", [a]);
    expect(Number(opening.days)).toBeGreaterThan(0); // the year's own entitlement is posted beside the carried days
    expect(next!.entitled).toBe(Number(opening.days) + 5);
    const [cf] = await sql<{ expires_on: Date }>("SELECT expires_on FROM leave_ledger WHERE employee_id=$1 AND leave_type='annual' AND entry_type='carry_forward'", [a]);
    expect(cf.expires_on.toISOString().slice(0, 10)).toBe("2027-04-01");
  });

  it("forfeits everything for a type that does not allow carry-forward", async () => {
    const closed = await bal(a, "casual", 2026);
    expect(closed!.remaining).toBe(0);
    expect(closed!.expired).toBe(9);
    expect((await bal(a, "casual", 2027))?.carried ?? 0).toBe(0);
  });

  it("never forfeits the balance of an encashable type (it stays for encashment)", async () => {
    const [sick] = await sql<{ code: string }>("SELECT code FROM leave_types WHERE company_id=$1 AND code='sick'", [companyId]);
    expect(sick.code).toBe("sick");
    await sql("UPDATE leave_types SET carry_forward_allowed = false, encashable = true WHERE company_id=$1 AND code='sick'", [companyId]);
    await db.withClaims(FIXTURE, (c) => ledger.post(c, { companyId, employeeId: a, leaveType: "sick", year: 2026, entryType: "opening", days: 8, effectiveDate: "2026-01-01", sourceType: "policy", sourceKey: "policy:2026" }));
    await yearEnd.runCompany(companyId, "2027-01-03");
    expect((await bal(a, "sick", 2026))!.remaining).toBe(8);
  });

  it("is idempotent: running again posts nothing new", async () => {
    const before = await sql<{ n: string }>("SELECT count(*) n FROM leave_ledger WHERE company_id=$1", [companyId]);
    const r = await yearEnd.runCompany(companyId, "2027-01-05");
    expect(r.carried + r.forfeited).toBe(0);
    const after = await sql<{ n: string }>("SELECT count(*) n FROM leave_ledger WHERE company_id=$1", [companyId]);
    expect(after[0].n).toBe(before[0].n);
  });

  it("expires carried days still unused on the expiry date, counting leave taken first from the carried days", async () => {
    // b took 3 days in January 2027
    await db.withClaims(FIXTURE, (c) => ledger.post(c, { companyId, employeeId: b, leaveType: "annual", year: 2027, entryType: "deduction", days: -3, effectiveDate: "2027-01-15", sourceType: "test", sourceKey: "used-2027" }));
    const early = await yearEnd.runCompany(companyId, "2027-03-31");
    expect(early.expired).toBe(0); // not yet
    const r = await yearEnd.runCompany(companyId, "2027-04-02");
    expect(r.expired).toBe(2); // a: nothing used -> 5 expire. b: 3 of the 5 were used first -> 2 expire
    const a27 = await bal(a, "annual", 2027);
    const [op] = await sql<{ days: string }>("SELECT days FROM leave_ledger WHERE employee_id=$1 AND leave_type='annual' AND year=2027 AND entry_type='opening'", [a]);
    const own = Number(op.days);
    expect(a27!.remaining).toBe(own); // carried 5 expired, own entitlement untouched
    const b27 = await bal(b, "annual", 2027);
    expect(b27!.remaining).toBe(own + 5 - 3 - 2);
    // and again: nothing more
    expect((await yearEnd.runCompany(companyId, "2027-04-03")).expired).toBe(0);
  });
});
