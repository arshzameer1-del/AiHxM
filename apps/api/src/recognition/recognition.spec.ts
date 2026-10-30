import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { MailerService } from "../mailer/mailer.service";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { RecognitionService } from "./recognition.service";

describe("Recognition feed", () => {
  let f: PayrollFixture;
  let other: PayrollFixture;
  let svc: RecognitionService;
  let a: Awaited<ReturnType<PayrollFixture["makeUser"]>>;
  let b: Awaited<ReturnType<PayrollFixture["makeUser"]>>;
  let aEmp: { id: string };
  let bEmp: { id: string };

  beforeAll(async () => {
    f = await buildPayrollFixture("rec1");
    other = await buildPayrollFixture("rec2");
    svc = new RecognitionService(f.db, f.rbac, f.entitlements, f.audit, new UserNotificationsService(f.db, new MailerService()));
    a = await f.makeUser("reca", ["employee_self_service"]);
    b = await f.makeUser("recb", ["employee_self_service"]);
    aEmp = await f.createEmployee({ userAccountId: a.uid, monthlySalary: null });
    bEmp = await f.createEmployee({ userAccountId: b.uid, monthlySalary: null });
    await f.sql("UPDATE employees SET first_name = 'Amna', last_name = 'Giver' WHERE id = $1", [aEmp.id]);
    await f.sql("UPDATE employees SET first_name = 'Bilal', last_name = 'Receiver' WHERE id = $1", [bEmp.id]);
  }, 120000);
  afterAll(async () => {
    await f.cleanup();
    await other.cleanup();
  }, 60000);

  it("finds colleagues by name, not yourself, and needs two letters", async () => {
    expect(await svc.colleagues(a, "B")).toEqual([]);
    expect((await svc.colleagues(a, "bil")).map((x) => x.name)).toEqual(["Bilal Receiver"]);
    expect(await svc.colleagues(a, "amna")).toEqual([]);
  });

  it("a thank-you reaches the feed and tells the colleague", async () => {
    await svc.give(a, { toEmployeeId: bEmp.id, message: "Thanks for covering my shift", valueTag: "Teamwork" });
    const feed = await svc.feed(b);
    expect(feed[0]).toMatchObject({ fromName: "Amna Giver", toName: "Bilal Receiver", message: "Thanks for covering my shift", valueTag: "Teamwork", mine: true });
    const note = await f.sql<{ title: string }>("SELECT title FROM user_notifications WHERE user_account_id = $1", [b.uid]);
    expect(note.map((n) => n.title)).toContain("Amna Giver thanked you");
  });

  it("refuses yourself, an empty message, a stranger and more than ten a day", async () => {
    await expect(svc.give(a, { toEmployeeId: aEmp.id, message: "me" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.give(a, { toEmployeeId: bEmp.id, message: "  " })).rejects.toBeInstanceOf(BadRequestException);
    const otherEmp = await other.createEmployee({ monthlySalary: null });
    await expect(svc.give(a, { toEmployeeId: otherEmp.id, message: "hi" })).rejects.toBeInstanceOf(NotFoundException);
    for (let i = 0; i < 9; i++) await svc.give(a, { toEmployeeId: bEmp.id, message: `thanks ${i}` });
    await expect(svc.give(a, { toEmployeeId: bEmp.id, message: "one too many" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("only HR hides a thank-you, and a hidden one leaves the feed", async () => {
    const feed = await svc.feed(b);
    await expect(svc.hide(b, feed[0].id)).rejects.toBeInstanceOf(ForbiddenException);
    await svc.hide(f.hr, feed[0].id);
    expect((await svc.feed(b)).find((x) => x.id === feed[0].id)).toBeUndefined();
    await expect(svc.hide(f.hr, feed[0].id)).rejects.toBeInstanceOf(NotFoundException);
    expect(await svc.canModerate(f.hr)).toBe(true);
    expect(await svc.canModerate(b)).toBe(false);
  });

  it("another company never sees the feed", async () => {
    const o = new RecognitionService(other.db, other.rbac, other.entitlements, other.audit, new UserNotificationsService(other.db, new MailerService()));
    const u = await other.makeUser("recx", ["employee_self_service"]);
    await other.createEmployee({ userAccountId: u.uid, monthlySalary: null });
    expect(await o.feed(u)).toEqual([]);
  });
});
