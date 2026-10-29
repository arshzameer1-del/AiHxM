import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { MailerService } from "../mailer/mailer.service";
import { MessagingService } from "../messaging/messaging.service";
import { NotificationsService } from "../notifications/notifications.service";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { AnnouncementsService } from "./announcements.service";

/** The notice board against real Postgres: audiences, read receipts, confirmations, the bell, and SMS through a gateway. */
describe("Announcements", () => {
  let f: PayrollFixture;
  let svc: AnnouncementsService;
  let gateway: Server;
  let sent: Array<{ channel: string; to: string; text: string }> = [];
  const saved = { ...process.env };

  let sales: { uid: string; claims: Awaited<ReturnType<PayrollFixture["makeUser"]>>; emp: { id: string } };
  let ops: typeof sales;
  let unit: { sales: string; ops: string };
  const inbox = (uid: string) => f.sql<{ title: string; category: string }>("SELECT title, category FROM user_notifications WHERE user_account_id = $1", [uid]);

  beforeAll(async () => {
    gateway = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        sent.push(JSON.parse(raw));
        res.end("{}");
      });
    });
    await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
    f = await buildPayrollFixture("ann1");
    const mailer = new MailerService();
    const messaging = new MessagingService();
    const inboxSvc = new UserNotificationsService(f.db, mailer);
    svc = new AnnouncementsService(f.db, f.rbac, f.entitlements, f.audit, inboxSvc, mailer, messaging, new NotificationsService(f.db, mailer, messaging));

    unit = {
      sales: (await f.sql<{ id: string }>("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1,'department','Sales') RETURNING id", [f.companyId]))[0].id,
      ops: (await f.sql<{ id: string }>("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1,'department','Operations') RETURNING id", [f.companyId]))[0].id,
    };
    const mk = async (label: string, orgUnit: string, phone: string) => {
      const claims = await f.makeUser(label, ["employee_self_service"]);
      const emp = await f.createEmployee({ userAccountId: claims.uid, monthlySalary: null });
      await f.sql("UPDATE employees SET org_unit_id = $2, phone = $3 WHERE id = $1", [emp.id, orgUnit, phone]);
      return { uid: claims.uid, claims, emp };
    };
    sales = await mk("sales", unit.sales, "0300-1111111");
    ops = await mk("ops", unit.ops, "not a number");
  }, 120000);

  afterAll(async () => {
    process.env = { ...saved };
    await new Promise<void>((r) => gateway.close(() => r()));
    await f.cleanup();
  }, 60000);

  it("only HR can write; an employee cannot", async () => {
    await expect(svc.create(sales.claims, { title: "x", body: "y" })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.listAdmin(sales.claims)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("checks the form and refuses SMS while no provider is set up", async () => {
    await expect(svc.create(f.hr, { title: " ", body: "y" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create(f.hr, { title: "x", body: "" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create(f.hr, { title: "x", body: "y", audienceType: "org_unit", audienceIds: [] })).rejects.toThrow(/at least one/);
    await expect(svc.create(f.hr, { title: "x", body: "y", audienceType: "org_unit", audienceIds: ["00000000-0000-4000-8000-000000000000"] })).rejects.toThrow(/does not exist/);
    await expect(svc.create(f.hr, { title: "x", body: "y", sendSms: true })).rejects.toThrow(/SMS is not set up/);
  });

  it("a draft is invisible; publishing shows it to its audience only, rings the bell and counts people", async () => {
    const draft = await svc.create(f.hr, { title: "Sales kickoff", body: "Monday 9am, boardroom.", audienceType: "org_unit", audienceIds: [unit.sales], requireAck: true });
    expect(draft).toMatchObject({ status: "draft", audienceCount: 1, readCount: 0, audienceNames: ["Sales"] });
    expect(await svc.mine(sales.claims)).toHaveLength(0);

    const pub = await svc.publish(f.hr, draft.id);
    expect(pub).toMatchObject({ status: "published", deliverySummary: { recipients: 1 } });
    await expect(svc.publish(f.hr, draft.id)).rejects.toBeInstanceOf(ConflictException);

    const mineSales = await svc.mine(sales.claims);
    expect(mineSales).toMatchObject([{ title: "Sales kickoff", read: false, requireAck: true, acknowledged: false }]);
    expect(await svc.mine(ops.claims)).toHaveLength(0);
    await expect(svc.markRead(ops.claims, draft.id)).rejects.toBeInstanceOf(NotFoundException);
    expect((await inbox(sales.uid)).some((n) => n.category === "announcements" && n.title === "Sales kickoff")).toBe(true);
    expect(await inbox(ops.uid)).toHaveLength(0);
    expect(await svc.summary(sales.claims)).toEqual({ unread: 1, needsAck: 1 });
  });

  it("reading and confirming are recorded once and show to HR", async () => {
    const id = (await svc.mine(sales.claims))[0].id;
    await svc.markRead(sales.claims, id);
    await svc.markRead(sales.claims, id);
    expect(await svc.summary(sales.claims)).toEqual({ unread: 0, needsAck: 1 });
    await svc.acknowledge(sales.claims, id);
    expect(await svc.summary(sales.claims)).toEqual({ unread: 0, needsAck: 0 });
    const admin = (await svc.listAdmin(f.hr)).find((a) => a.id === id)!;
    expect(admin).toMatchObject({ readCount: 1, acknowledgedCount: 1, audienceCount: 1 });
    const receipts = await svc.receipts(f.hr, id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ employeeId: sales.emp.id });
    expect(receipts[0].acknowledgedAt).toBeTruthy();
  });

  it("an announcement that does not ask for confirmation cannot be confirmed; expired and archived ones disappear", async () => {
    const all = await svc.create(f.hr, { title: "Eid holidays", body: "Office closed.", pinned: true, priority: "important", publish: true });
    expect((await svc.mine(ops.claims)).map((a) => a.title)).toEqual(["Eid holidays"]);
    await expect(svc.acknowledge(ops.claims, all.id)).rejects.toBeInstanceOf(BadRequestException);
    // pinned comes first for the sales person who now has two
    expect((await svc.mine(sales.claims)).map((a) => a.title)).toEqual(["Eid holidays", "Sales kickoff"]);
    await f.sql("UPDATE announcements SET expires_on = '2020-01-01' WHERE id = $1", [all.id]);
    expect(await svc.mine(ops.claims)).toHaveLength(0);
    await f.sql("UPDATE announcements SET expires_on = NULL WHERE id = $1", [all.id]);
    await svc.archive(f.hr, all.id);
    expect(await svc.mine(ops.claims)).toHaveLength(0);
    await expect(svc.update(f.hr, all.id, { title: "x", body: "y" })).rejects.toBeInstanceOf(ConflictException);
  });

  it("once published only the wording can change, not who gets it", async () => {
    const a = await svc.create(f.hr, { title: "Parking", body: "Use gate B.", audienceType: "org_unit", audienceIds: [unit.ops], publish: true });
    const edited = await svc.update(f.hr, a.id, { title: "Parking update", body: "Use gate C.", audienceType: "all" });
    expect(edited).toMatchObject({ title: "Parking update", body: "Use gate C.", audienceType: "org_unit" });
    expect(await svc.mine(sales.claims)).not.toContainEqual(expect.objectContaining({ title: "Parking update" }));
  });

  it("sends by SMS through the gateway to numbers that are valid, and says who had none", async () => {
    process.env.SMS_WEBHOOK_URL = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/sms`;
    sent = [];
    const live = new AnnouncementsService(
      f.db, f.rbac, f.entitlements, f.audit, new UserNotificationsService(f.db, new MailerService()), new MailerService(), new MessagingService(),
      new NotificationsService(f.db, new MailerService(), new MessagingService())
    );
    expect(live.channels().sms).toEqual({ configured: true, provider: "webhook" });
    const a = await live.create(f.hr, { title: "Fire drill", body: "Friday 3pm.", priority: "urgent", sendSms: true, publish: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: "sms", to: "+923001111111" });
    expect(sent[0].text).toContain("Fire drill");
    expect(a.deliverySummary).toMatchObject({ recipients: 2, smsSent: 1, smsFailed: 0, noPhone: 1 });
    const log = await f.sql<{ channel: string; status: string }>("SELECT channel, status FROM notification_log WHERE company_id = $1 AND template_key = 'announcement'", [f.companyId]);
    expect(log).toEqual([{ channel: "sms", status: "sent" }]);
  });
});
