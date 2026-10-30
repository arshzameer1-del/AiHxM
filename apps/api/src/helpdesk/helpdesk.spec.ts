import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { MailerService } from "../mailer/mailer.service";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { HelpdeskService } from "./helpdesk.service";

describe("HR help desk", () => {
  let f: PayrollFixture;
  let svc: HelpdeskService;
  let a: Awaited<ReturnType<PayrollFixture["makeUser"]>>;
  let b: Awaited<ReturnType<PayrollFixture["makeUser"]>>;
  let payrollCat: string;

  beforeAll(async () => {
    f = await buildPayrollFixture("hdk1");
    svc = new HelpdeskService(f.db, f.rbac, f.entitlements, f.audit, new UserNotificationsService(f.db, new MailerService()));
    a = await f.makeUser("hdka", ["employee_self_service"]);
    b = await f.makeUser("hdkb", ["employee_self_service"]);
    await f.createEmployee({ userAccountId: a.uid, monthlySalary: null });
    await f.createEmployee({ userAccountId: b.uid, monthlySalary: null });
  }, 120000);
  afterAll(async () => {
    await f.cleanup();
  }, 60000);

  it("only HR sets up categories; starter categories carry no target time until HR sets one", async () => {
    await expect(svc.categoriesAdmin(a)).rejects.toBeInstanceOf(ForbiddenException);
    const list = await svc.addStarterCategories(f.hr);
    expect(list.length).toBeGreaterThanOrEqual(5);
    expect(list.every((c) => c.slaHours === null)).toBe(true);
    const payroll = list.find((c) => c.name.startsWith("Payroll"))!;
    const saved = await svc.saveCategory(f.hr, { id: payroll.id, name: payroll.name, slaHours: 24 });
    payrollCat = payroll.id;
    expect(saved.find((c) => c.id === payrollCat)!.slaHours).toBe(24);
    await expect(svc.saveCategory(f.hr, { name: "x", slaHours: 0 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.saveCategory(f.hr, { name: payroll.name })).rejects.toBeInstanceOf(ConflictException);
  });

  it("a question starts the clock from the category target; HR's first reply stops it", async () => {
    const t = await svc.raise(a, { categoryId: payrollCat, subject: "Where is my bonus?", body: "It was not in March payslip." });
    expect(t).toMatchObject({ status: "open", slaHours: 24, responseOverdue: false, categoryName: expect.stringContaining("Payroll") });
    expect(t.messages).toHaveLength(1);
    expect(new Date(t.respondBy!).getTime() - new Date(t.createdAt).getTime()).toBeCloseTo(24 * 3600 * 1000, -3);
    await f.sql("UPDATE helpdesk_tickets SET respond_by = now() - interval '1 hour' WHERE id = $1", [t.id]);
    const queue = await svc.queue(f.hr);
    expect(queue.find((x) => x.id === t.id)!.responseOverdue).toBe(true);
    expect((await svc.summary(f.hr)).overdue).toBe(1);
    expect((await svc.queue(f.hr, "overdue")).map((x) => x.id)).toEqual([t.id]);
    const after = await svc.reply(f.hr, t.id, "Bonus is paid with April salary.");
    expect(after).toMatchObject({ status: "waiting_on_employee", responseOverdue: false });
    expect(after.firstResponseAt).not.toBeNull();
    expect(after.messages!.map((m) => m.fromHr)).toEqual([false, true]);
    const inbox = await f.sql<{ title: string }>("SELECT title FROM user_notifications WHERE user_account_id = $1", [a.uid]);
    expect(inbox.map((n) => n.title).some((x) => x.startsWith("HR replied"))).toBe(true);
    expect((await svc.summary(f.hr)).overdue).toBe(0);
  });

  it("a person sees only their own questions; the employee reply reopens, resolve and reopen work", async () => {
    const mine = await svc.mine(a);
    expect(mine).toHaveLength(1);
    expect(await svc.mine(b)).toEqual([]);
    await expect(svc.getMine(b, mine[0].id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.reply(b, mine[0].id, "hello")).rejects.toBeInstanceOf(NotFoundException);
    const re = await svc.reply(a, mine[0].id, "Thanks, understood.");
    expect(re.status).toBe("open");
    const res = await svc.resolve(f.hr, mine[0].id);
    expect(res.status).toBe("resolved");
    await expect(svc.resolve(a, mine[0].id)).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.reply(f.hr, mine[0].id, "late")).rejects.toBeInstanceOf(ConflictException);
    const reopened = await svc.reply(a, mine[0].id, "Actually one more thing");
    expect(reopened.status).toBe("open");
    expect(reopened.resolvedAt).toBeNull();
  });

  it("a question without a category has no clock, and the queue/ summary are HR only", async () => {
    const t = await svc.raise(b, { subject: "General", body: "Hello" });
    expect(t).toMatchObject({ slaHours: null, respondBy: null, responseOverdue: false });
    await expect(svc.queue(b)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.summary(a)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.raise(b, { subject: "", body: "x" })).rejects.toBeInstanceOf(BadRequestException);
    const s = await svc.summary(f.hr);
    expect(s.open).toBeGreaterThanOrEqual(2);
  });
});
