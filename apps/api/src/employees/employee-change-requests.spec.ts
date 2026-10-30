import { Pool, type PoolClient } from "pg";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { EmployeeChangeRequestsService } from "./employee-change-requests.service";
import { EmployeeContactsService } from "./employee-contacts.service";
import { EmployeeAddressesService } from "./employee-addresses.service";
import { EmployeeFamilyMembersService } from "./employee-family-members.service";
import { EmployeePaymentAccountsService } from "./employee-payment-accounts.service";
import { EmployeesService } from "./employees.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "employee-change-requests-spec" };

/** BACKLOG48 against real Postgres: employees ask, HR decides, nothing changes before approval. */
describe("Employee change requests", () => {
  let pool: Pool;
  let db: DatabaseService;
  let svc: EmployeeChangeRequestsService;
  let contacts: EmployeeContactsService;
  let addresses: EmployeeAddressesService;
  let family: EmployeeFamilyMembersService;
  let bank: EmployeePaymentAccountsService;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let a: string;
  let hr: RequestClaims;
  let ess: RequestClaims;
  let other: RequestClaims;
  let me: string;
  let colleague: string;
  const fx = <T>(fn: (c: PoolClient) => Promise<T>) => db.withClaims(FIXTURE, fn);
  let n = 0;

  async function makeEmployee(c: PoolClient, userId: string | null) {
    n += 1;
    const p = await c.query("INSERT INTO persons (company_id, full_name) VALUES ($1, $2) RETURNING id", [a, `P ${n}`]);
    return (
      await c.query(
        "INSERT INTO employees (company_id, employee_number, first_name, last_name, person_id, user_account_id) VALUES ($1,$2,'C',$3,$4,$5) RETURNING id",
        [a, `CR-${n}-${stamp}`.slice(0, 30), `E${n}`, p.rows[0].id, userId]
      )
    ).rows[0].id as string;
  }
  const row = async (sql: string, args: unknown[]) => (await fx((c) => c.query(sql, args))).rows;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    const cat = { validateActiveCode: async () => undefined } as never;
    contacts = new EmployeeContactsService(db, rbac, ent, audit, cat);
    addresses = new EmployeeAddressesService(db, rbac, ent, audit, cat);
    family = new EmployeeFamilyMembersService(db, rbac, ent, audit, cat);
    bank = new EmployeePaymentAccountsService(db, rbac, ent, audit);
    const employees = new EmployeesService(db, rbac, ent, audit, new LocalFileStorageService());
    svc = new EmployeeChangeRequestsService(db, rbac, ent, audit, cat, contacts, addresses, family, bank, employees);
    await fx(async (c) => {
      const r = await c.query("INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, 'Asia/Karachi') RETURNING id", [`CR ${stamp}`, `cr-${stamp}`]);
      a = r.rows[0].id;
      await c.query("INSERT INTO company_config (company_id, enabled_modules) VALUES ($1, $2::jsonb)", [a, JSON.stringify(["employee"])]);
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [a]);
      const mkUser = async (tag: string, roleKey: string) => {
        const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`cr-${tag}-${stamp}@example.com`]);
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

  it("a new contact waits for HR, then appears and updates the employee's phone", async () => {
    const req = await svc.submit(ess, { requestType: "contact", action: "add", payload: { contactType: "personal_phone", value: "0321-9998887", isPrimary: true } });
    expect(req.status).toBe("pending");
    expect(req.summary).toContain("0321-9998887");
    expect(await row("SELECT 1 FROM employee_contacts WHERE employee_id = $1", [me])).toHaveLength(0);

    const done = await svc.approve(hr, req.id, "Looks right");
    expect(done.status).toBe("approved");
    expect(done.decisionNote).toBe("Looks right");
    const contactsNow = await row("SELECT value, is_primary FROM employee_contacts WHERE employee_id = $1", [me]);
    expect(contactsNow).toEqual([{ value: "0321-9998887", is_primary: true }]);
    expect((await row("SELECT phone FROM employees WHERE id = $1", [me]))[0].phone).toBe("0321-9998887");
  });

  it("an address can be changed and removed, one open request per record", async () => {
    const addr = await row("INSERT INTO employee_addresses (company_id, employee_id, address_type, line1, city) VALUES ($1,$2,'permanent','1 Old Road','Lahore') RETURNING id", [a, me]);
    const id = addr[0].id as string;
    const change = await svc.submit(ess, { requestType: "address", action: "update", targetId: id, payload: { line1: "9 New Road", city: "Karachi" } });
    await expect(svc.submit(ess, { requestType: "address", action: "end", targetId: id })).rejects.toBeInstanceOf(BadRequestException);

    const pendingList = await svc.list(hr, "pending");
    const shown = pendingList.find((r) => r.id === change.id)!;
    expect(shown.current).toEqual({ line1: "1 Old Road", city: "Lahore" });
    expect(shown.employeeName).toContain("E");

    await svc.approve(hr, change.id);
    expect((await row("SELECT line1, city FROM employee_addresses WHERE id = $1", [id]))[0]).toEqual({ line1: "9 New Road", city: "Karachi" });

    const remove = await svc.submit(ess, { requestType: "address", action: "end", targetId: id });
    await svc.approve(hr, remove.id);
    expect((await row("SELECT status FROM employee_addresses WHERE id = $1", [id]))[0].status).toBe("ended");
  });

  it("a family member's CNIC is never stored in the clear inside the request", async () => {
    const req = await svc.submit(ess, {
      requestType: "family_member",
      action: "add",
      payload: { relationship: "child", fullName: "Zara Khan", cnic: "35202-1234567-1", dateOfBirth: "2015-05-05", isDependent: true },
    });
    expect(req.payload.cnic).toBe("Provided");
    const stored = JSON.stringify((await row("SELECT payload FROM employee_change_requests WHERE id = $1", [req.id]))[0].payload);
    expect(stored).not.toContain("35202-1234567-1");
    expect(stored).not.toContain("2015-05-05");

    await svc.approve(hr, req.id);
    const listed = await family.list(hr, me);
    const zara = listed.find((f) => f.fullName === "Zara Khan")!;
    expect(zara.isDependent).toBe(true);
    expect(zara.cnic).toBe("35202-1234567-1");
  });

  it("marital status changes the person only after approval", async () => {
    const before = (await row("SELECT marital_status FROM employees WHERE id = $1", [me]))[0].marital_status;
    const req = await svc.submit(ess, { requestType: "marital_status", action: "update", payload: { maritalStatus: "married" } });
    expect((await row("SELECT marital_status FROM employees WHERE id = $1", [me]))[0].marital_status).toBe(before);
    await svc.approve(hr, req.id);
    expect((await row("SELECT marital_status FROM employees WHERE id = $1", [me]))[0].marital_status).toBe("married");
    expect((await row("SELECT p.marital_status FROM persons p JOIN employees e ON e.person_id = p.id WHERE e.id = $1", [me]))[0].marital_status).toBe("married");
  });

  it("a new bank account is pending until HR approves; the first one becomes primary, a later one replaces it", async () => {
    const first = await svc.submit(ess, { requestType: "bank_account", action: "add", payload: { paymentMethod: "bank_transfer", bankName: "HBL", accountTitle: "E1", accountNumber: "1111222233334444" } });
    expect(first.summary).toContain("••••4444");
    expect(JSON.stringify(first.payload)).not.toContain("1111222233334444");
    let accounts = await row("SELECT approval_status, is_primary FROM employee_payment_accounts WHERE employee_id = $1", [me]);
    expect(accounts).toEqual([{ approval_status: "pending", is_primary: false }]);

    await svc.approve(hr, first.id);
    accounts = await row("SELECT approval_status, is_primary, status FROM employee_payment_accounts WHERE employee_id = $1", [me]);
    expect(accounts).toEqual([{ approval_status: "approved", is_primary: true, status: "active" }]);

    const second = await svc.submit(ess, { requestType: "bank_account", action: "add", payload: { paymentMethod: "bank_transfer", bankName: "UBL", accountNumber: "5555666677778888" } });
    // the live primary is untouched while the new one waits
    expect((await row("SELECT count(*)::int AS n FROM employee_payment_accounts WHERE employee_id = $1 AND is_primary AND approval_status = 'approved'", [me]))[0].n).toBe(1);
    await svc.approve(hr, second.id);
    const live = await row("SELECT bank_name FROM employee_payment_accounts WHERE employee_id = $1 AND is_primary AND status = 'active'", [me]);
    expect(live).toEqual([{ bank_name: "UBL" }]);
    const old = await row("SELECT status FROM employee_payment_accounts WHERE employee_id = $1 AND bank_name = 'HBL'", [me]);
    expect(old[0].status).toBe("ended");
  });

  it("rejecting needs a reason; a rejected or cancelled bank request leaves no live account", async () => {
    const req = await svc.submit(ess, { requestType: "bank_account", action: "add", payload: { paymentMethod: "bank_transfer", bankName: "MCB", accountNumber: "9999000011112222" } });
    await expect(svc.reject(hr, req.id, "  ")).rejects.toBeInstanceOf(BadRequestException);
    const rejected = await svc.reject(hr, req.id, "Account title does not match your name");
    expect(rejected.status).toBe("rejected");
    expect(rejected.decisionNote).toBe("Account title does not match your name");
    expect((await row("SELECT status FROM employee_payment_accounts WHERE employee_id = $1 AND bank_name = 'MCB'", [me]))[0].status).toBe("ended");
    await expect(svc.approve(hr, req.id)).rejects.toBeInstanceOf(BadRequestException);

    const second = await svc.submit(ess, { requestType: "bank_account", action: "add", payload: { paymentMethod: "bank_transfer", bankName: "ABL", accountNumber: "1212121212121212" } });
    const cancelled = await svc.cancel(ess, second.id);
    expect(cancelled.status).toBe("cancelled");
    expect((await row("SELECT status FROM employee_payment_accounts WHERE employee_id = $1 AND bank_name = 'ABL'", [me]))[0].status).toBe("ended");
  });

  it("employees only reach their own records and cannot decide anything", async () => {
    const colleagueContact = await row("INSERT INTO employee_contacts (company_id, employee_id, contact_type, value) VALUES ($1,$2,'personal_email','c@example.com') RETURNING id", [a, colleague]);
    await expect(svc.submit(ess, { requestType: "contact", action: "end", targetId: colleagueContact[0].id })).rejects.toBeInstanceOf(NotFoundException);

    const mine = await svc.submit(ess, { requestType: "contact", action: "add", payload: { contactType: "personal_email", value: "me@example.com" } });
    await expect(svc.approve(ess, mine.id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.reject(ess, mine.id, "no")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.list(ess)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.cancel(other, mine.id)).rejects.toBeInstanceOf(NotFoundException);

    expect((await svc.listMine(ess)).some((r) => r.id === mine.id)).toBe(true);
    expect((await svc.listMine(other)).some((r) => r.id === mine.id)).toBe(false);
  });

  it("bad values are refused when submitting, not when HR approves", async () => {
    await expect(svc.submit(ess, { requestType: "contact", action: "add", payload: { contactType: "carrier_pigeon", value: "x" } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.submit(ess, { requestType: "address", action: "add", payload: { addressType: "current" } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.submit(ess, { requestType: "bank_account", action: "add", payload: { paymentMethod: "bank_transfer", bankName: "X" } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.submit(ess, { requestType: "bank_account", action: "update", payload: {} })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.submit(ess, { requestType: "marital_status", action: "update", payload: { maritalStatus: " " } })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("a request that cannot be applied stays open for HR to deal with", async () => {
    const c = await row("INSERT INTO employee_contacts (company_id, employee_id, contact_type, value) VALUES ($1,$2,'personal_email','old@example.com') RETURNING id", [a, me]);
    const req = await svc.submit(ess, { requestType: "contact", action: "update", targetId: c[0].id, payload: { value: "new@example.com" } });
    const spy = jest.spyOn(contacts, "update").mockRejectedValueOnce(new Error("could not save"));
    await expect(svc.approve(hr, req.id)).rejects.toThrow("could not save");
    spy.mockRestore();
    const still = (await svc.list(hr, "pending")).find((r) => r.id === req.id);
    expect(still?.status).toBe("pending");
    // and HR can try again once the cause is fixed
    expect((await svc.approve(hr, req.id)).status).toBe("approved");
    expect((await row("SELECT value FROM employee_contacts WHERE id = $1", [c[0].id]))[0].value).toBe("new@example.com");
  });

  it("nobody approves a change they asked for themselves; another HR person can", async () => {
    // an HR person who is also an employee asks to change their own bank details
    const hr2 = await fx(async (c) => {
      const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`cr-hr2-${stamp}@example.com`]);
      for (const key of ["hr_admin", "employee_self_service"]) {
        const role = await c.query("SELECT id FROM roles WHERE key = $1", [key]);
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, a, role.rows[0].id]);
      }
      await makeEmployee(c, u.rows[0].id as string);
      return { is_platform_admin: false, company_id: a, sub: u.rows[0].id as string } as RequestClaims;
    });
    const req = await svc.submit(hr2, { requestType: "contact", action: "add", payload: { contactType: "personal_email", value: "hr2@example.com" } });
    await expect(svc.approve(hr2, req.id)).rejects.toBeInstanceOf(ForbiddenException);
    // still open, nothing applied
    expect((await row("SELECT status FROM employee_change_requests WHERE id = $1", [req.id]))[0].status).toBe("pending");
    const done = await svc.approve(hr, req.id);
    expect(done.status).toBe("approved");
  });
});
