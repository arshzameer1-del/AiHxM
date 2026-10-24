import { Pool, type PoolClient } from "pg";
import { ForbiddenException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { sensitive } from "../crypto/sensitive-fields";
import { fieldCrypto } from "../crypto/field-crypto";
import { EmployeeContactsService } from "./employee-contacts.service";
import { EmployeeAddressesService } from "./employee-addresses.service";
import { EmployeeFamilyMembersService } from "./employee-family-members.service";
import { EmployeeEducationService } from "./employee-education.service";
import { EmployeeQualificationsService } from "./employee-qualifications.service";
import { EmployeePaymentAccountsService } from "./employee-payment-accounts.service";
import { EmployeeImportantDatesService } from "./employee-important-dates.service";
import { EmployeeAssetsService } from "./employee-assets.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "employee-self-read-spec" };

/**
 * BACKLOG47: an employee can read THEIR OWN contacts, addresses, family, education, qualifications, bank accounts,
 * important dates and assets - and nobody else's. HR keeps the full view. Bank account numbers are masked for the owner.
 */
describe("Employees read their own sub-records", () => {
  let pool: Pool;
  let db: DatabaseService;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let a: string;
  let b: string;
  let me: string;
  let colleague: string;
  let foreign: string;
  let ess: RequestClaims;
  let hr: RequestClaims;
  let otherCompanyEss: RequestClaims;
  const fx = <T>(fn: (c: PoolClient) => Promise<T>) => db.withClaims(FIXTURE, fn);
  let svc: {
    contacts: EmployeeContactsService;
    addresses: EmployeeAddressesService;
    family: EmployeeFamilyMembersService;
    education: EmployeeEducationService;
    qualifications: EmployeeQualificationsService;
    bank: EmployeePaymentAccountsService;
    dates: EmployeeImportantDatesService;
    assets: EmployeeAssetsService;
  };
  let n = 0;

  async function makeEmployee(c: PoolClient, companyId: string, userId: string | null) {
    n += 1;
    const p = await c.query("INSERT INTO persons (company_id, full_name) VALUES ($1, $2) RETURNING id", [companyId, `P ${n}`]);
    const r = await c.query(
      "INSERT INTO employees (company_id, employee_number, first_name, last_name, person_id, user_account_id) VALUES ($1,$2,'S',$3,$4,$5) RETURNING id",
      [companyId, `SR-${n}-${stamp}`.slice(0, 30), `E${n}`, p.rows[0].id, userId]
    );
    return r.rows[0].id as string;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    const cat = { validateActiveCode: async () => undefined } as never;
    svc = {
      contacts: new EmployeeContactsService(db, rbac, ent, audit, cat),
      addresses: new EmployeeAddressesService(db, rbac, ent, audit, cat),
      family: new EmployeeFamilyMembersService(db, rbac, ent, audit, cat),
      education: new EmployeeEducationService(db, rbac, ent, audit),
      qualifications: new EmployeeQualificationsService(db, rbac, ent, audit, cat),
      bank: new EmployeePaymentAccountsService(db, rbac, ent, audit),
      dates: new EmployeeImportantDatesService(db, rbac, ent, audit),
      assets: new EmployeeAssetsService(db, rbac, ent, audit),
    };
    await fx(async (c) => {
      const mk = async (label: string) => {
        const r = await c.query("INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, 'Asia/Karachi') RETURNING id", [`SR ${label} ${stamp}`, `sr-${label}-${stamp}`.toLowerCase()]);
        await c.query("INSERT INTO company_config (company_id, enabled_modules) VALUES ($1, $2::jsonb)", [r.rows[0].id, JSON.stringify(["employee"])]);
        await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [r.rows[0].id]);
        return r.rows[0].id as string;
      };
      a = await mk("a");
      b = await mk("b");
      const mkUser = async (tag: string, roleKey: string, company: string) => {
        const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`sr-${tag}-${stamp}@example.com`]);
        const role = await c.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, company, role.rows[0].id]);
        return { is_platform_admin: false, company_id: company, sub: u.rows[0].id as string } as RequestClaims;
      };
      await fieldCrypto.warm(c, a);
      hr = await mkUser("hr", "hr_admin", a);
      ess = await mkUser("ess", "employee_self_service", a);
      otherCompanyEss = await mkUser("ess-b", "employee_self_service", b);
      me = await makeEmployee(c, a, ess.sub as string);
      colleague = await makeEmployee(c, a, null);
      foreign = await makeEmployee(c, b, otherCompanyEss.sub as string);
      for (const emp of [me, colleague]) {
        await c.query("INSERT INTO employee_contacts (company_id, employee_id, contact_type, value, is_primary) VALUES ($1,$2,'personal_phone','0300-5551234',true)", [a, emp]);
        await c.query("INSERT INTO employee_addresses (company_id, employee_id, address_type, line1) VALUES ($1,$2,'home','12 Garden Road')", [a, emp]);
        await c.query("INSERT INTO employee_family_members (company_id, employee_id, relationship, full_name) VALUES ($1,$2,'spouse','Sana')", [a, emp]);
        await c.query("INSERT INTO employee_education (company_id, employee_id, degree_title) VALUES ($1,$2,'BS Computer Science')", [a, emp]);
        await c.query("INSERT INTO employee_qualifications (company_id, employee_id, qualification_type, title) VALUES ($1,$2,'certification','PMP')", [a, emp]);
        await c.query(
          "INSERT INTO employee_payment_accounts (company_id, employee_id, payment_method, bank_name, account_number, iban, is_primary) VALUES ($1,$2,'bank_transfer','HBL',$3,$4,true)",
          [a, emp, sensitive.encrypt(a, "0123456789012"), sensitive.encrypt(a, "PK36SCBL0000001123456702")]
        );
        await c.query("INSERT INTO employee_important_dates (company_id, employee_id, date_type, date_value) VALUES ($1,$2,'confirmation','2026-01-01')", [a, emp]);
        await c.query("INSERT INTO employee_assets (company_id, employee_id, asset_type) VALUES ($1,$2,'laptop')", [a, emp]);
      }
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("the employee sees every kind of their own record", async () => {
    expect(await svc.contacts.list(ess, me)).toHaveLength(1);
    expect(await svc.addresses.list(ess, me)).toHaveLength(1);
    expect(await svc.family.list(ess, me)).toHaveLength(1);
    expect(await svc.education.list(ess, me)).toHaveLength(1);
    expect(await svc.qualifications.list(ess, me)).toHaveLength(1);
    expect(await svc.bank.list(ess, me)).toHaveLength(1);
    expect(await svc.dates.list(ess, me)).toHaveLength(1);
    expect(await svc.assets.list(ess, me)).toHaveLength(1);
  });

  it("the employee cannot read a colleague's records, in their own company or another", async () => {
    const lists = [svc.contacts, svc.addresses, svc.family, svc.education, svc.qualifications, svc.bank, svc.dates, svc.assets];
    for (const s of lists) {
      await expect(s.list(ess, colleague)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(s.list(ess, foreign)).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it("someone else's login cannot read this employee's records either", async () => {
    await expect(svc.contacts.list(otherCompanyEss, me)).rejects.toThrow();
    await expect(svc.bank.list(otherCompanyEss, me)).rejects.toThrow();
  });

  it("the employee sees only the last four digits of their bank account and IBAN; HR sees them in full", async () => {
    const [mine] = await svc.bank.list(ess, me);
    expect(mine.accountNumber).toBe("••••9012");
    expect(mine.iban).toBe("••••6702");
    const [full] = await svc.bank.list(hr, me);
    expect(full.accountNumber).toBe("0123456789012");
    expect(full.iban).toBe("PK36SCBL0000001123456702");
    const [others] = await svc.bank.list(hr, colleague);
    expect(others.accountNumber).toBe("0123456789012");
  });

  it("HR can still list anyone's records", async () => {
    expect(await svc.contacts.list(hr, colleague)).toHaveLength(1);
    expect(await svc.family.list(hr, me)).toHaveLength(1);
  });

  it("the employee still cannot change anything, even their own", async () => {
    await expect(svc.contacts.create(ess, { employeeId: me, contactType: "personal_phone", value: "0300-0", isPrimary: false })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.assets.list(ess, me)).resolves.toHaveLength(1);
  });
});
