import { Pool } from "pg";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { EmployeesService } from "./employees.service";
import { EmployeePaymentAccountsService } from "./employee-payment-accounts.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "payacct-step4-fixtures" };

/**
 * Gap Register EMP-07 / EMP-08 (Step 4D): payment accounts are the single
 * source of bank details; changes to an approved primary account need a
 * second person; splits/priorities/validity are enforced in the database.
 */
describe("Payment accounts single source and maker-checker (EMP-07/08)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let employees: EmployeesService;
  let accounts: EmployeePaymentAccountsService;
  let companyId: string;
  let maker: RequestClaims;
  let checker: RequestClaims;
  const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    db.withClaims(FIXTURE, async (c) => (await c.query(text, params)).rows as T[]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    employees = new EmployeesService(db, rbac, ent, audit, new LocalFileStorageService());
    accounts = new EmployeePaymentAccountsService(db, rbac, ent, audit);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await db.withClaims(FIXTURE, async (c) => {
      companyId = (await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Pay ${stamp}`, `pay-${stamp}`])).rows[0].id;
      await c.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format) VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [companyId]
      );
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true)", [companyId]);
      const mk = async (label: string): Promise<RequestClaims> => {
        const id = (await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`pay-${label}-${stamp}@example.com`])).rows[0].id;
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE key='hr_admin'))", [id, companyId]);
        return { sub: id, company_id: companyId, is_platform_admin: false };
      };
      maker = await mk("maker");
      checker = await mk("checker");
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  const hire = (first: string, extra: Record<string, unknown> = {}) => employees.create(maker, { firstName: first, lastName: "Payee", ...extra });

  it("EMP-07: the flat bankAccountNumber input becomes the primary payment account, and the legacy column mirrors it", async () => {
    const e = await hire("Ali", { bankAccountNumber: "PK-ACC-1001" });
    expect(e.bankAccountNumber).toBe("PK-ACC-1001");
    const list = await accounts.list(maker, e.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ isPrimary: true, approvalStatus: "approved", accountNumber: "PK-ACC-1001", priority: 1, currency: "PKR", bankCountry: "PK" });
    expect((await employees.get(maker, e.id)).bankAccountNumber).toBe("PK-ACC-1001");
  });

  it("EMP-07: a bank number change on an existing employee is held as a pending replacement; the live account and payroll value stay unchanged", async () => {
    const e = await hire("Bilal", { bankAccountNumber: "OLD-111" });
    const upd = await employees.update(maker, e.id, { bankAccountNumber: "NEW-222" });
    expect(upd.bankAccountNumber).toBe("OLD-111");
    const list = await accounts.list(maker, e.id);
    const pending = list.find((a) => a.approvalStatus === "pending")!;
    expect(pending).toMatchObject({ accountNumber: "NEW-222", isPrimary: false, submittedByUserAccountId: maker.sub });
    expect(pending.replacesAccountId).toBe(list.find((a) => a.isPrimary)!.id);
    expect((await employees.get(maker, e.id)).bankAccountNumber).toBe("OLD-111");

    await expect(accounts.approve(maker, pending.id)).rejects.toBeInstanceOf(ForbiddenException); // maker-checker
    const approved = await accounts.approve(checker, pending.id);
    expect(approved).toMatchObject({ approvalStatus: "approved", isPrimary: true, approvedByUserAccountId: checker.sub, priority: 1 });
    expect((await employees.get(maker, e.id)).bankAccountNumber).toBe("NEW-222");
    const all = await accounts.list(maker, e.id, true);
    const old = all.find((a) => a.accountNumber === "OLD-111")!;
    expect(old).toMatchObject({ status: "ended", isPrimary: false });
    expect(old.validTo).toBeTruthy();
    await expect(accounts.approve(checker, pending.id)).rejects.toBeInstanceOf(BadRequestException); // not pending any more
  });

  it("EMP-08: editing the bank details of an approved primary account never edits it in place; rejection keeps the old account", async () => {
    const e = await hire("Chand", { bankAccountNumber: "ACC-9" });
    const primary = (await accounts.list(maker, e.id))[0];
    const req = await accounts.update(maker, primary.id, { iban: "PK36SCBL0000001123456702", bankName: "SCB" });
    expect(req).toMatchObject({ approvalStatus: "pending", replacesAccountId: primary.id, iban: "PK36SCBL0000001123456702", accountNumber: "ACC-9" });
    const [still] = await sql<{ bank_name: string | null }>("SELECT bank_name FROM employee_payment_accounts WHERE id = $1", [primary.id]);
    expect(still.bank_name).toBeNull();
    await expect(accounts.reject(checker, req.id, "")).rejects.toBeInstanceOf(BadRequestException);
    const rejected = await accounts.reject(checker, req.id, "IBAN does not match the cheque");
    expect(rejected).toMatchObject({ approvalStatus: "rejected", status: "ended", rejectionReason: "IBAN does not match the cheque" });
    expect((await accounts.list(maker, e.id)).map((a) => a.id)).toEqual([primary.id]);
    expect((await employees.get(maker, e.id)).bankAccountNumber).toBe("ACC-9");
  });

  it("EMP-08: the database refuses a pending primary, a self-approval and splits above 100%", async () => {
    const e = await hire("Danish", { bankAccountNumber: "SPLIT-1" });
    const primary = (await accounts.list(maker, e.id))[0];
    await expect(
      sql("UPDATE employee_payment_accounts SET approval_status = 'pending' WHERE id = $1", [primary.id])
    ).rejects.toThrow(/payment_accounts_pending_not_primary/);
    await expect(
      sql("UPDATE employee_payment_accounts SET submitted_by_user_account_id = $2, approved_by_user_account_id = $2 WHERE id = $1", [primary.id, maker.sub])
    ).rejects.toThrow(/payment_accounts_maker_checker/);

    await accounts.update(maker, primary.id, { splitPercent: 70 });
    await accounts.create(maker, { employeeId: e.id, paymentMethod: "bank_transfer", accountNumber: "SPLIT-2", splitPercent: 30 });
    await expect(
      accounts.create(maker, { employeeId: e.id, paymentMethod: "bank_transfer", accountNumber: "SPLIT-3", splitPercent: 10 })
    ).rejects.toThrow(/cannot exceed 100/);
  });

  it("EMP-08: priorities are unique per employee among live accounts; validity window must be ordered", async () => {
    const e = await hire("Eman", { bankAccountNumber: "PRI-1" });
    const second = await accounts.create(maker, { employeeId: e.id, paymentMethod: "bank_transfer", accountNumber: "PRI-2" });
    expect(second.priority).toBe(2);
    await expect(accounts.update(maker, second.id, { priority: 1 })).rejects.toThrow();
    await expect(accounts.update(maker, second.id, { validFrom: "2026-12-01", validTo: "2026-01-01" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("EMP-08: verification status is recorded and reset when the account details change", async () => {
    const e = await hire("Faraz", { bankAccountNumber: "VER-1" });
    const second = await accounts.create(maker, { employeeId: e.id, paymentMethod: "bank_transfer", accountNumber: "VER-2" });
    const v = await accounts.verify(checker, second.id, "verified");
    expect(v).toMatchObject({ verificationStatus: "verified" });
    expect(v.verifiedAt).toBeTruthy();
    const changed = await accounts.update(maker, second.id, { accountNumber: "VER-2B" }); // non-primary: edited in place
    expect(changed).toMatchObject({ verificationStatus: "unverified", verifiedAt: null, approvalStatus: "approved" });
  });

  it("EMP-08: promoting an existing account to primary is a new, approved-by-another change, never a direct flip", async () => {
    const e = await hire("Gul", { bankAccountNumber: "PRO-1" });
    const second = await accounts.create(maker, { employeeId: e.id, paymentMethod: "bank_transfer", accountNumber: "PRO-2" });
    await expect(accounts.update(maker, second.id, { isPrimary: true })).rejects.toBeInstanceOf(BadRequestException);
    const newPrimary = await accounts.create(maker, { employeeId: e.id, paymentMethod: "bank_transfer", accountNumber: "PRO-3", isPrimary: true });
    expect(newPrimary.approvalStatus).toBe("pending");
    expect((await employees.get(maker, e.id)).bankAccountNumber).toBe("PRO-1");
    await accounts.approve(checker, newPrimary.id);
    expect((await employees.get(maker, e.id)).bankAccountNumber).toBe("PRO-3");
    const live = (await accounts.list(maker, e.id)).filter((a) => a.isPrimary);
    expect(live).toHaveLength(1);
  });

  it("EMP-07: account numbers and IBANs stay encrypted at rest on the new rows, and the audit trail records the workflow", async () => {
    const e = await hire("Hina", { bankAccountNumber: "ENC-1" });
    const [row] = await sql<{ account_number: string; account_number_bidx: string | null }>(
      "SELECT account_number, account_number_bidx FROM employee_payment_accounts WHERE employee_id = $1",
      [e.id]
    );
    expect(row.account_number).not.toBe("ENC-1");
    expect(row.account_number_bidx).not.toBeNull();
    await employees.update(maker, e.id, { bankAccountNumber: "ENC-2" });
    const actions = await sql<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'employee_payment_account.%' AND company_id = $1", [companyId]);
    expect(actions.map((a) => a.action)).toContain("employee_payment_account.change_requested");
  });
});
