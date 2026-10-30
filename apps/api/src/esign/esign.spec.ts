import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { MailerService } from "../mailer/mailer.service";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { EsignService } from "./esign.service";

describe("Documents to sign", () => {
  let f: PayrollFixture;
  let other: PayrollFixture;
  let svc: EsignService;
  let a: Awaited<ReturnType<PayrollFixture["makeUser"]>>;
  let b: Awaited<ReturnType<PayrollFixture["makeUser"]>>;
  let aEmp: { id: string };
  let bEmp: { id: string };

  beforeAll(async () => {
    f = await buildPayrollFixture("esg1");
    other = await buildPayrollFixture("esg2");
    svc = new EsignService(f.db, f.rbac, f.entitlements, f.audit, new UserNotificationsService(f.db, new MailerService()));
    a = await f.makeUser("esga", ["employee_self_service"]);
    b = await f.makeUser("esgb", ["employee_self_service"]);
    aEmp = await f.createEmployee({ userAccountId: a.uid, monthlySalary: null });
    bEmp = await f.createEmployee({ userAccountId: b.uid, monthlySalary: null });
    await f.sql("UPDATE employees SET first_name = 'Sana', last_name = 'Malik' WHERE id = $1", [aEmp.id]);
    await f.sql("UPDATE employees SET first_name = 'Omar', last_name = 'Khan' WHERE id = $1", [bEmp.id]);
  }, 120000);
  afterAll(async () => {
    await f.cleanup();
    await other.cleanup();
  }, 60000);

  it("only HR sends documents; nobody else can read the list", async () => {
    await expect(svc.create(a, { title: "x", body: "y", employeeIds: [bEmp.id] })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.list(a)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("sends one document to several people and tells them", async () => {
    await expect(svc.create(f.hr, { title: "Code of conduct", body: "I will behave.", employeeIds: [] })).rejects.toBeInstanceOf(BadRequestException);
    const otherEmp = await other.createEmployee({ monthlySalary: null });
    await expect(svc.create(f.hr, { title: "T", body: "B", employeeIds: [otherEmp.id] })).rejects.toBeInstanceOf(BadRequestException);
    const r = await svc.create(f.hr, { title: "Code of conduct", body: "I have read and will follow the code of conduct.", employeeIds: [aEmp.id, bEmp.id] });
    expect(r.created).toBe(2);
    expect((await svc.mine(a))[0]).toMatchObject({ title: "Code of conduct", status: "pending" });
    expect(await svc.count(a)).toEqual({ waiting: 1 });
    expect(await svc.mine(b)).toHaveLength(1);
    const note = await f.sql<{ title: string }>("SELECT title FROM user_notifications WHERE user_account_id = $1", [a.uid]);
    expect(note.some((n) => n.title.startsWith("Please read and sign"))).toBe(true);
  });

  it("signing needs your own full name; the receipt verifies and breaks if the text is altered", async () => {
    const mine = (await svc.mine(a))[0];
    await expect(svc.sign(a, mine.id, "Someone Else")).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.sign(b, mine.id, "Omar Khan")).rejects.toBeInstanceOf(NotFoundException);
    const signed = await svc.sign(a, mine.id, "  sana   MALIK ");
    expect(signed).toMatchObject({ status: "signed", signedName: "sana   MALIK" });
    expect(signed.receipt).toMatch(/^[0-9a-f]{64}$/);
    expect(await svc.verify(f.hr, mine.id)).toEqual({ valid: true });
    await expect(svc.sign(a, mine.id, "Sana Malik")).rejects.toBeInstanceOf(ConflictException);
    await f.sql("UPDATE esign_requests SET body = 'I changed the text afterwards.' WHERE id = $1", [mine.id]);
    expect(await svc.verify(f.hr, mine.id)).toEqual({ valid: false });
  });

  it("declining needs a reason; a cancelled document disappears for the employee; others cannot see yours", async () => {
    const theirs = (await svc.mine(b))[0];
    await expect(svc.decline(b, theirs.id, " ")).rejects.toBeInstanceOf(BadRequestException);
    const d = await svc.decline(b, theirs.id, "I need to discuss clause 2");
    expect(d).toMatchObject({ status: "declined", declineReason: "I need to discuss clause 2" });
    await svc.create(f.hr, { title: "Second", body: "Second text", employeeIds: [bEmp.id] });
    const second = (await svc.list(f.hr, "pending"))[0];
    await svc.cancel(f.hr, second.id);
    expect((await svc.mine(b)).map((x) => x.title)).not.toContain("Second");
    await expect(svc.cancel(f.hr, second.id)).rejects.toBeInstanceOf(ConflictException);
    expect((await svc.list(f.hr)).length).toBeGreaterThanOrEqual(3);
    const o = new EsignService(other.db, other.rbac, other.entitlements, other.audit, new UserNotificationsService(other.db, new MailerService()));
    expect(await o.list(other.hr)).toEqual([]);
  });
});
