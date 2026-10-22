import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { buildPayrollFixture, type PayrollFixture } from "./testing/payroll-fixture";
import { PayrollPayslipNoticesService } from "./payroll-payslip-notices.service";
import { MailerService } from "../mailer/mailer.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PayrollDocumentsService } from "./payroll-documents.service";
import { TestSmtpCatcher } from "../mailer/test-smtp-catcher";

/** Emailing employees that their payslip is ready: once each, no amounts, only when published, only for a finalised run. */
describe("Payslip notices", () => {
  let f: PayrollFixture;
  let other: PayrollFixture;
  let catcher: TestSmtpCatcher;
  let notices: PayrollPayslipNoticesService;
  let otherNotices: PayrollPayslipNoticesService;
  let runId: string;
  const people: Record<string, { id: string; employeeNumber: string }> = {};
  const saved = { ...process.env };

  const build = (fx: PayrollFixture) => {
    const mailer = new MailerService();
    return new PayrollPayslipNoticesService(fx.db, fx.rbac, fx.entitlements, fx.audit, mailer, new NotificationsService(fx.db, mailer));
  };

  beforeAll(async () => {
    f = await buildPayrollFixture("pnt");
    other = await buildPayrollFixture("pnt2");
    notices = build(f);
    otherNotices = build(other);
    for (const [key, salary] of [["amina", 120000], ["bilal", 95000], ["noemail", 80000]] as const) {
      people[key] = await f.createEmployee({ monthlySalary: salary });
    }
    await f.sql("UPDATE employees SET email = 'amina@example.test' WHERE id = $1", [people.amina.id]);
    await f.sql("UPDATE employees SET email = 'bilal@example.test' WHERE id = $1", [people.bilal.id]);
    await f.sql("UPDATE employees SET email = NULL WHERE id = $1", [people.noemail.id]);
    runId = await f.finalizedRun("2072-03-01", "2072-03-31");
    catcher = await TestSmtpCatcher.start();
  }, 90000);

  afterAll(async () => {
    await catcher.stop();
    process.env = { ...saved };
    await f.cleanup();
    await other.cleanup();
  });

  const configure = () => {
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(catcher.port);
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
  };

  it("says plainly that nothing was sent when email is not set up", async () => {
    delete process.env.SMTP_HOST;
    await expect(notices.notifyRun(f.hr, runId)).rejects.toThrow(/not set up/);
  });

  it("emails each person with an address once, never with an amount, and lists those without an address", async () => {
    configure();
    catcher.clear();
    const res = await notices.notifyRun(f.hr, runId);
    expect(res.sent).toBeGreaterThanOrEqual(2);
    expect(res.noEmail).toContain(people.noemail.employeeNumber);
    expect(res.failed).toEqual([]);
    const mails = catcher.all();
    const amina = mails.find((m) => m.to.includes("amina@example.test"))!;
    expect(amina.subject).toBe("Your payslip for 1 Mar 2072 to 31 Mar 2072 is ready");
    expect(amina.text).toContain("/login");
    expect(amina.text).not.toMatch(/\d{2,3},\d{3}|120000|Rs/);
    expect(mails.some((m) => m.to.includes("bilal@example.test"))).toBe(true);
  });

  it("does not tell the same people twice", async () => {
    configure();
    catcher.clear();
    const again = await notices.notifyRun(f.hr, runId);
    expect(again.sent).toBe(0);
    expect(again.alreadySent).toBeGreaterThanOrEqual(2);
    expect(catcher.all()).toHaveLength(0);
  });

  it("leaves out people whose payslip is not published to them when the tenant requires publication", async () => {
    configure();
    const run2 = await f.finalizedRun("2072-04-01", "2072-04-30");
    const documents = new PayrollDocumentsService(f.db, f.rbac, f.entitlements, f.audit);
    await documents.updateSettings(f.hr, { requirePublication: true });
    catcher.clear();
    const res = await notices.notifyRun(f.hr, run2);
    expect(res.sent).toBe(0);
    expect(res.notPublished).toBeGreaterThanOrEqual(2);
    expect(catcher.all()).toHaveLength(0);
    await documents.updateSettings(f.hr, { requirePublication: false });
  });

  it("is refused for a run that is not finalised, for a login without payroll rights, and across tenants", async () => {
    configure();
    const draft = await f.payroll.createRun(f.hr, { periodStart: "2072-05-01", periodEnd: "2072-05-31" });
    await expect(notices.notifyRun(f.hr, draft.id)).rejects.toBeInstanceOf(BadRequestException);
    await expect(notices.notifyRun(f.staff, runId)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(otherNotices.notifyRun(other.hr, runId)).rejects.toBeInstanceOf(NotFoundException);
  });
});
