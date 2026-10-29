import { Pool, type PoolClient } from "pg";
import { BadRequestException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeChangeRequestsService } from "../employees/employee-change-requests.service";
import { EmployeeContactsService } from "../employees/employee-contacts.service";
import { EmployeeAddressesService } from "../employees/employee-addresses.service";
import { EmployeeFamilyMembersService } from "../employees/employee-family-members.service";
import { EmployeePaymentAccountsService } from "../employees/employee-payment-accounts.service";
import { EmployeeDocumentComplianceService } from "../employees/employee-document-compliance.service";
import { EmployeesService } from "../employees/employees.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { HrBusinessPolicyService } from "../hr-administration/hr-business-policy.service";
import { RbacService } from "../rbac/rbac.service";
import { UserNotificationsService } from "./user-notifications.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "user-notifications-spec" };
const pdf = { originalname: "cnic.pdf", mimetype: "application/pdf", buffer: Buffer.from("%PDF-1.4 x"), size: 10 };

/** BACKLOG51 against real Postgres: the bell, the preferences, and the events that feed them. */
describe("In-app notifications and preferences", () => {
  let pool: Pool;
  let db: DatabaseService;
  let inbox: UserNotificationsService;
  let requests: EmployeeChangeRequestsService;
  let compliance: EmployeeDocumentComplianceService;
  const sendMail = jest.fn(async () => undefined);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let a: string;
  let hr: RequestClaims;
  let ess: RequestClaims;
  let other: RequestClaims;
  let me: string;
  const fx = <T>(fn: (c: PoolClient) => Promise<T>) => db.withClaims(FIXTURE, fn);
  const rows = async (sql: string, args: unknown[]) => (await fx((c) => c.query(sql, args))).rows;
  let n = 0;

  async function makeEmployee(c: PoolClient, userId: string | null) {
    n += 1;
    const p = await c.query("INSERT INTO persons (company_id, full_name) VALUES ($1, $2) RETURNING id", [a, `P ${n}`]);
    return (
      await c.query(
        "INSERT INTO employees (company_id, employee_number, first_name, last_name, person_id, user_account_id) VALUES ($1,$2,'N',$3,$4,$5) RETURNING id",
        [a, `UN-${n}-${stamp}`.slice(0, 30), `E${n}`, p.rows[0].id, userId]
      )
    ).rows[0].id as string;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    const cat = { validateActiveCode: async () => undefined } as never;
    inbox = new UserNotificationsService(db, { isConfigured: () => true, sendMail } as never);
    const employees = new EmployeesService(db, rbac, ent, audit, new LocalFileStorageService(), undefined, undefined, undefined, undefined, undefined, cat);
    requests = new EmployeeChangeRequestsService(
      db, rbac, ent, audit, cat,
      new EmployeeContactsService(db, rbac, ent, audit, cat),
      new EmployeeAddressesService(db, rbac, ent, audit, cat),
      new EmployeeFamilyMembersService(db, rbac, ent, audit, cat),
      new EmployeePaymentAccountsService(db, rbac, ent, audit),
      employees,
      inbox
    );
    compliance = new EmployeeDocumentComplianceService(db, rbac, ent, audit, employees, cat, new HrBusinessPolicyService(db, rbac, ent, audit), inbox);
    await fx(async (c) => {
      const r = await c.query("INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, 'Asia/Karachi') RETURNING id", [`UN ${stamp}`, `un-${stamp}`]);
      a = r.rows[0].id;
      await c.query("INSERT INTO company_config (company_id, enabled_modules) VALUES ($1, $2::jsonb)", [a, JSON.stringify(["employee"])]);
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [a]);
      const mkUser = async (tag: string, roleKey: string) => {
        const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`un-${tag}-${stamp}@example.com`]);
        const role = await c.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, a, role.rows[0].id]);
        return { is_platform_admin: false, company_id: a, sub: u.rows[0].id as string } as RequestClaims;
      };
      hr = await mkUser("hr", "hr_admin");
      ess = await mkUser("ess", "employee_self_service");
      other = await mkUser("other", "employee_self_service");
      me = await makeEmployee(c, ess.sub as string);
      await makeEmployee(c, other.sub as string);
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("an employee's request tells HR; HR's decision tells the employee", async () => {
    const req = await requests.submit(ess, { requestType: "contact", action: "add", payload: { contactType: "personal_phone", value: "0300-1112223" } });
    let hrBell = await inbox.inbox(hr);
    expect(hrBell.unreadCount).toBe(1);
    expect(hrBell.items[0]).toMatchObject({ category: "hr_inbox", link: "/app/employees/change-requests", readAt: null });
    expect(hrBell.items[0].title).toContain("sent a change request");
    expect((await inbox.inbox(ess)).unreadCount).toBe(0);
    expect((await inbox.inbox(other)).unreadCount).toBe(0);

    await requests.approve(hr, req.id, "Thanks");
    const mine = await inbox.inbox(ess);
    expect(mine.items[0]).toMatchObject({ category: "request_decisions", title: "HR approved your request" });
    expect(mine.items[0].body).toContain("Thanks");

    const req2 = await requests.submit(ess, { requestType: "marital_status", action: "update", payload: { maritalStatus: "married" } });
    await requests.reject(hr, req2.id, "Please attach the certificate");
    const after = await inbox.inbox(ess);
    expect(after.items[0].title).toBe("HR did not approve your request");
    expect(after.items[0].body).toContain("Please attach the certificate");
    expect(after.unreadCount).toBe(2);
    hrBell = await inbox.inbox(hr);
    expect(hrBell.unreadCount).toBe(2);
  });

  it("a document upload and its review notify the right people", async () => {
    const doc = await compliance.uploadOwn(ess, me, "cnic", pdf);
    expect((await inbox.inbox(hr)).items.some((i) => i.title === "A document is waiting for your review")).toBe(true);
    await compliance.review(hr, doc.id, "rejected", "Too blurry");
    const mine = await inbox.inbox(ess);
    expect(mine.items[0]).toMatchObject({ title: "HR did not approve your document", link: "/app/profile?tab=documents" });
    expect(mine.items[0].body).toContain("Too blurry");
  });

  it("a person reads only their own bell and can mark items read", async () => {
    const mine = await inbox.inbox(ess);
    const first = mine.items[0].id;
    expect((await inbox.markRead(other, [first])).unreadCount).toBe(0); // not theirs: nothing changes
    expect((await inbox.inbox(ess)).unreadCount).toBe(mine.unreadCount);
    const one = await inbox.markRead(ess, [first]);
    expect(one.unreadCount).toBe(mine.unreadCount - 1);
    expect((await inbox.markRead(ess)).unreadCount).toBe(0);
    expect((await inbox.inbox(ess)).items.every((i) => i.readAt !== null)).toBe(true);
  });

  it("preferences start at the defaults, can be changed, and are checked", async () => {
    const start = await inbox.getPreferences(ess);
    expect(start.map((p) => p.category)).toEqual(["request_decisions", "hr_inbox", "approval_requests", "request_progress", "document_expiry", "learning_due", "payslip"]);
    expect(start.find((p) => p.category === "request_decisions")).toMatchObject({ email: true, inApp: true });
    expect(start.find((p) => p.category === "payslip")).toMatchObject({ email: true, inApp: false, channels: ["email"] });

    await expect(inbox.savePreferences(ess, [{ category: "nonsense", email: false }])).rejects.toBeInstanceOf(BadRequestException);

    const saved = await inbox.savePreferences(ess, [{ category: "request_decisions", inApp: false }, { category: "payslip", email: false, inApp: true }]);
    expect(saved.find((p) => p.category === "request_decisions")).toMatchObject({ inApp: false, email: true });
    // payslip notices are email only: an in-app switch can never turn on
    expect(saved.find((p) => p.category === "payslip")).toMatchObject({ email: false, inApp: false });
    // someone else's preferences are untouched
    expect((await inbox.getPreferences(other)).find((p) => p.category === "request_decisions")).toMatchObject({ inApp: true });
  });

  it("switched-off channels are honoured by the events", async () => {
    sendMail.mockClear();
    const before = (await inbox.inbox(ess)).items.length;
    const req = await requests.submit(ess, { requestType: "contact", action: "add", payload: { contactType: "personal_email", value: "n@example.com" } });
    await requests.approve(hr, req.id);
    // in-app was switched off -> nothing in the bell; email stayed on -> one mail to the employee
    expect((await inbox.inbox(ess)).items.length).toBe(before);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: `un-ess-${stamp}@example.com`, subject: "HR approved your request" }));
  });

  it("payslip emails can be opted out of", async () => {
    const out = await inbox.emailOptedOut([ess.sub, other.sub, null], "payslip");
    expect([...out]).toEqual([ess.sub]);
    expect((await inbox.emailOptedOut([], "payslip")).size).toBe(0);
  });

  it("notifying never fails the caller", async () => {
    await expect(inbox.notify({ companyId: a, userAccountIds: ["not-a-uuid", null, undefined], category: "hr_inbox", title: "x" })).resolves.toBeUndefined();
    await expect(inbox.notify({ companyId: "bad", userAccountIds: [hr.sub], category: "hr_inbox", title: "x" })).resolves.toBeUndefined();
    expect(await rows("SELECT 1 FROM user_notifications WHERE company_id = $1 AND title = 'x'", [a])).toHaveLength(0);
  });

  it("HR admins of a company are found by role", async () => {
    expect(await inbox.hrAdminUserIds(a)).toEqual([hr.sub]);
  });
});
