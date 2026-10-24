import { Pool, type PoolClient } from "pg";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { fieldCrypto } from "../crypto/field-crypto";
import { EmployeeStatutoryIdsService } from "./employee-statutory-ids.service";
import { EmployeeFamilyMembersService } from "./employee-family-members.service";
import { EmployeeDataConsistencyService } from "./employee-data-consistency.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "employee-statutory-ids-spec" };

/** BACKLOG49 against real Postgres: statutory identifiers, CNIC / permit expiry, nominee shares. */
describe("Employee statutory IDs", () => {
  let pool: Pool;
  let db: DatabaseService;
  let svc: EmployeeStatutoryIdsService;
  let family: EmployeeFamilyMembersService;
  let consistency: EmployeeDataConsistencyService;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let a: string;
  let hr: RequestClaims;
  let ess: RequestClaims;
  let other: RequestClaims;
  let me: string;
  let colleague: string;
  const fx = <T>(fn: (c: PoolClient) => Promise<T>) => db.withClaims(FIXTURE, fn);
  const row = async (sql: string, args: unknown[]) => (await fx((c) => c.query(sql, args))).rows;
  const dayOffset = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  let n = 0;

  async function makeEmployee(c: PoolClient, userId: string | null) {
    n += 1;
    const p = await c.query("INSERT INTO persons (company_id, full_name) VALUES ($1, $2) RETURNING id", [a, `P ${n}`]);
    return (
      await c.query(
        "INSERT INTO employees (company_id, employee_number, first_name, last_name, person_id, user_account_id) VALUES ($1,$2,'S',$3,$4,$5) RETURNING id",
        [a, `SI-${n}-${stamp}`.slice(0, 30), `E${n}`, p.rows[0].id, userId]
      )
    ).rows[0].id as string;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    svc = new EmployeeStatutoryIdsService(db, rbac, ent, audit);
    family = new EmployeeFamilyMembersService(db, rbac, ent, audit, { validateActiveCode: async () => undefined } as never);
    consistency = new EmployeeDataConsistencyService(db, ent, rbac, audit);
    await fx(async (c) => {
      const r = await c.query("INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, 'Asia/Karachi') RETURNING id", [`SI ${stamp}`, `si-${stamp}`]);
      a = r.rows[0].id;
      await c.query("INSERT INTO company_config (company_id, enabled_modules) VALUES ($1, $2::jsonb)", [a, JSON.stringify(["employee"])]);
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [a]);
      await fieldCrypto.warm(c, a);
      const mkUser = async (tag: string, roleKey: string) => {
        const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`si-${tag}-${stamp}@example.com`]);
        const role = await c.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, a, role.rows[0].id]);
        return { is_platform_admin: false, company_id: a, sub: u.rows[0].id as string } as RequestClaims;
      };
      hr = await mkUser("hr", "hr_admin");
      ess = await mkUser("ess", "employee_self_service");
      other = await mkUser("other", "employee_self_service");
      me = await makeEmployee(c, ess.sub as string);
      colleague = await makeEmployee(c, other.sub as string);
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("an employee with nothing recorded gets an empty record, not an error", async () => {
    const v = await svc.get(hr, me);
    expect(v.eobiNumber).toBeNull();
    expect(v.cnicLifetime).toBe(false);
  });

  it("HR saves the numbers; they are encrypted in the database and readable through the API", async () => {
    const saved = await svc.upsert(hr, {
      employeeId: me,
      eobiNumber: "  E-12345678  ",
      eobiRegistrationDate: "2020-02-01",
      socialSecurityScheme: "sessi",
      socialSecurityNumber: "SS-998877",
      providentFundNumber: "PF-221",
      cnicIssueDate: "2019-05-01",
      cnicExpiryDate: dayOffset(30),
    });
    expect(saved.eobiNumber).toBe("E-12345678");
    expect(saved.socialSecurityScheme).toBe("sessi");
    const raw = (await row("SELECT eobi_number, social_security_number, provident_fund_number FROM employee_statutory_ids WHERE employee_id = $1", [me]))[0];
    expect(raw.eobi_number).not.toContain("E-12345678");
    expect(raw.social_security_number).not.toContain("SS-998877");
    expect(raw.provident_fund_number).toBe("PF-221");
    expect((await svc.get(hr, me)).eobiNumber).toBe("E-12345678");
  });

  it("a later save changes only what it sends; null clears; a lifetime CNIC drops its expiry", async () => {
    await svc.upsert(hr, { employeeId: me, providentFundNumber: "PF-300" });
    let v = await svc.get(hr, me);
    expect(v.providentFundNumber).toBe("PF-300");
    expect(v.eobiNumber).toBe("E-12345678");
    expect(v.cnicExpiryDate).not.toBeNull();

    await svc.upsert(hr, { employeeId: me, providentFundNumber: null });
    expect((await svc.get(hr, me)).providentFundNumber).toBeNull();

    v = await svc.upsert(hr, { employeeId: me, cnicLifetime: true });
    expect(v.cnicLifetime).toBe(true);
    expect(v.cnicExpiryDate).toBeNull();
  });

  it("an expiry before the issue date is refused", async () => {
    await expect(svc.upsert(hr, { employeeId: colleague, cnicIssueDate: "2024-01-01", cnicExpiryDate: "2023-01-01" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("the employee sees their own numbers but cannot change them or see a colleague's", async () => {
    expect((await svc.get(ess, me)).eobiNumber).toBe("E-12345678");
    await expect(svc.get(ess, colleague)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.upsert(ess, { employeeId: me, eobiNumber: "X" })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.get(other, me)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("the audit entry names the fields that changed, never the numbers", async () => {
    await svc.upsert(hr, { employeeId: colleague, eobiNumber: "SECRET-777" });
    const logs = await row("SELECT metadata::text AS m FROM audit_log WHERE action = 'employee_statutory_ids.update' AND target = $1 ORDER BY created_at DESC LIMIT 1", [colleague]);
    expect(logs[0].m).toContain("eobiNumber");
    expect(logs[0].m).not.toContain("SECRET-777");
  });

  it("nominee shares per employee cannot pass 100%", async () => {
    const wife = await family.create(hr, { employeeId: me, relationship: "spouse", fullName: "Amna", isBeneficiary: true, beneficiarySharePercent: 60 });
    expect(wife.beneficiarySharePercent).toBe(60);
    await expect(family.create(hr, { employeeId: me, relationship: "child", fullName: "Ali", isBeneficiary: true, beneficiarySharePercent: 50 })).rejects.toBeInstanceOf(BadRequestException);
    const son = await family.create(hr, { employeeId: me, relationship: "child", fullName: "Ali", isBeneficiary: true, beneficiarySharePercent: 40 });
    await expect(family.update(hr, son.id, { beneficiarySharePercent: 45 })).rejects.toBeInstanceOf(BadRequestException);
    const cleared = await family.update(hr, son.id, { isBeneficiary: false });
    expect(cleared.beneficiarySharePercent).toBeNull();
  });

  it("the consistency screen flags expired IDs and nominee totals", async () => {
    // colleague: an expired CNIC and a visa that lapsed
    await svc.upsert(hr, { employeeId: colleague, eobiNumber: null, cnicExpiryDate: dayOffset(-5), visaExpiryDate: dayOffset(-1) });
    const report = await consistency.getReport(hr);
    const ids = (id: string) => report.checks.find((x) => x.id === id)!.samples.map((s) => s.employeeId);
    expect(ids("cnic_expired")).toContain(colleague);
    expect(ids("visa_or_permit_expired")).toContain(colleague);
    // `me` has a 60% beneficiary (the 40% one was turned off): total is not 100
    expect(ids("nominee_shares_not_100")).toContain(me);
    expect(ids("cnic_expired")).not.toContain(me); // lifetime
  });
});
