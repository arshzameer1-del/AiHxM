import { BadRequestException, ConflictException } from "@nestjs/common";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { EmployeesService } from "../employees/employees.service";
import { LeaveLedgerService } from "../leave/leave-ledger.service";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { PayrollDocumentsService } from "../payroll/payroll-documents.service";
import { PayrollSchemesService } from "../payroll/payroll-schemes.service";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { EmployeeRequestsService } from "./employee-requests.service";

/** Leave encashment request against real Postgres: ask, HR approves, a payslip payment is queued and the balance drops. */
describe("Leave encashment requests", () => {
  let f: PayrollFixture;
  let svc: EmployeeRequestsService;
  let ledger: LeaveLedgerService;
  let ess: Awaited<ReturnType<PayrollFixture["makeUser"]>>;
  let me: { id: string };
  const year = new Date().getFullYear();

  const balance = async () =>
    (await f.sql<{ entitled_days: string; used_days: string }>("SELECT entitled_days, used_days FROM leave_balances WHERE employee_id = $1 AND leave_type = 'enc_req' AND year = $2", [me.id, year]))[0];

  beforeAll(async () => {
    f = await buildPayrollFixture("enc1");
    const employees = new EmployeesService(f.db, f.rbac, f.entitlements, f.audit, new LocalFileStorageService());
    ledger = new LeaveLedgerService(f.db, f.rbac, f.entitlements, f.audit);
    const mailer = { isConfigured: () => false, sendMail: async () => undefined } as never;
    svc = new EmployeeRequestsService(
      f.db, f.rbac, f.entitlements, f.audit, f.loans, employees,
      new PayrollDocumentsService(f.db, f.rbac, f.entitlements, f.audit),
      new UserNotificationsService(f.db, mailer),
      f.additionalPayments,
      ledger
    );
    ess = await f.makeUser("ess", ["employee_self_service"]);
    me = await f.createEmployee({ userAccountId: ess.uid, monthlySalary: 75000 });
    await f.sql("INSERT INTO leave_types (company_id, code, name, encashable) VALUES ($1, 'enc_req', 'Annual leave', true) ON CONFLICT DO NOTHING", [f.companyId]);
    await f.db.withClaims(f.hr, (c) => ledger.post(c, { companyId: f.companyId, employeeId: me.id, leaveType: "enc_req", year, entryType: "opening", days: 10, sourceType: "test" }));
  }, 120000);

  afterAll(async () => {
    await f.cleanup();
  }, 60000);

  it("is closed until the company switches encashment on", async () => {
    const opts = await svc.encashableLeave(ess);
    expect(opts.enabled).toBe(false);
    await expect(svc.submit(ess, { kind: "leave_encashment", purpose: "Cash needed", leaveType: "enc_req", leaveDays: 2 })).rejects.toBeInstanceOf(BadRequestException);
  });

  describe("once switched on", () => {
    beforeAll(async () => {
      const schemes = new PayrollSchemesService(f.db, f.rbac, f.entitlements, f.audit);
      await schemes.updateSettlementSettings(f.hr, { leaveEncashmentEnabled: true, leaveEncashmentTaxable: true, dailyRateBase: "basic_salary", dailyRateDivisor: 30 } as never);
    });

    it("lists the encashable leave with days left and rejects what cannot be asked", async () => {
      const opts = await svc.encashableLeave(ess);
      expect(opts).toMatchObject({ enabled: true, items: [{ code: "enc_req", remainingDays: 10 }] });
      await expect(svc.submit(ess, { kind: "leave_encashment", purpose: "x", leaveType: "enc_req", leaveDays: 11 })).rejects.toThrow(/at most 10/);
      await expect(svc.submit(ess, { kind: "leave_encashment", purpose: "x", leaveType: "enc_req", leaveDays: 0.3 })).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.submit(ess, { kind: "leave_encashment", purpose: "x", leaveType: "nope", leaveDays: 1 })).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.submit(ess, { kind: "leave_encashment", purpose: "x", leaveDays: 1 })).rejects.toBeInstanceOf(BadRequestException);
    });

    it("counts days already requested, and HR can reject with a reason", async () => {
      const a = await svc.submit(ess, { kind: "leave_encashment", purpose: "Eid expenses", leaveType: "enc_req", leaveDays: 8 });
      expect(a).toMatchObject({ status: "pending", leaveDays: 8, leaveType: "enc_req", leaveTypeName: "Annual leave" });
      await expect(svc.submit(ess, { kind: "leave_encashment", purpose: "More", leaveType: "enc_req", leaveDays: 3 })).rejects.toThrow(/at most 2/);
      await expect(svc.approveLoan(f.hr, a.id)).rejects.toThrow(/leave encashment/);
      const rejected = await svc.reject(f.hr, a.id, "Peak season");
      expect(rejected.status).toBe("rejected");
      expect(Number((await balance()).used_days)).toBe(0);
    });

    it("approving queues a payslip payment at days x daily rate and takes the days off the balance", async () => {
      const req = await svc.submit(ess, { kind: "leave_encashment", purpose: "Eid expenses", leaveType: "enc_req", leaveDays: 4 });
      const done = await svc.approveEncashment(f.hr, req.id, { note: "Paid with salary" });
      // 75000 / 30 = 2500 a day, 4 days
      expect(done).toMatchObject({ status: "fulfilled", amount: 10000, decisionNote: "Paid with salary" });
      expect(done.additionalPaymentId).toBeTruthy();
      const pay = (await f.sql<{ payment_type: string; amount: string; is_taxable: boolean; status: string; label: string }>("SELECT payment_type, amount, is_taxable, status, label FROM employee_additional_payments WHERE id = $1", [done.additionalPaymentId]))[0];
      expect(pay).toMatchObject({ payment_type: "earning", amount: "10000.00", is_taxable: true, status: "pending", label: "Leave encashment (4 days)" });
      const b = await balance();
      expect(Number(b.entitled_days) - Number(b.used_days)).toBe(6);
      const ledgerRow = await f.sql<{ entry_type: string; days: string }>("SELECT entry_type, days FROM leave_ledger WHERE employee_id = $1 AND source_type = 'leave_encashment_request'", [me.id]);
      expect(ledgerRow).toEqual([{ entry_type: "encashment", days: "-4.0000" }]);
      await expect(svc.approveEncashment(f.hr, req.id, {})).rejects.toBeInstanceOf(ConflictException);
    });

    it("HR can type the amount, and approval is refused when the balance has since dropped", async () => {
      const req = await svc.submit(ess, { kind: "leave_encashment", purpose: "Fees", leaveType: "enc_req", leaveDays: 5 });
      // the balance falls while the request waits
      await f.db.withClaims(f.hr, (c) => ledger.post(c, { companyId: f.companyId, employeeId: me.id, leaveType: "enc_req", year, entryType: "adjustment", days: -4, sourceType: "test", sourceKey: "drop" }));
      await expect(svc.approveEncashment(f.hr, req.id, { amount: 12000 })).rejects.toThrow(/only 2/);
      await f.db.withClaims(f.hr, (c) => ledger.post(c, { companyId: f.companyId, employeeId: me.id, leaveType: "enc_req", year, entryType: "adjustment", days: 4, sourceType: "test", sourceKey: "restore" }));
      const done = await svc.approveEncashment(f.hr, req.id, { amount: 12000 });
      expect(done.amount).toBe(12000);
      const b = await balance();
      expect(Number(b.entitled_days) - Number(b.used_days)).toBe(1);
    });

    it("the employee cannot approve and a non-HR user is refused", async () => {
      const req = await svc.submit(ess, { kind: "leave_encashment", purpose: "Try", leaveType: "enc_req", leaveDays: 1 });
      await expect(svc.approveEncashment(ess, req.id, { amount: 1 })).rejects.toThrow();
      await svc.cancel(ess, req.id);
    });
  });
});
