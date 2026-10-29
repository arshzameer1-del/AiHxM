import { MailerService } from "../mailer/mailer.service";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { PayrollDeadlineRemindersService, deadlineFor } from "./payroll-deadline-reminders.service";

const P = { label: "October 2026", periodEnd: "2026-10-31", payDate: "2026-11-02" };

describe("deadlineFor", () => {
  it("asks to start a run once the period is about to end, not before", () => {
    expect(deadlineFor(P, [], "2026-10-27")).toBeNull();
    expect(deadlineFor(P, [], "2026-10-28")).toMatchObject({ stage: "start" });
    expect(deadlineFor(P, [], "2026-11-05")).toMatchObject({ stage: "start" });
  });
  it("ignores reversed and cancelled runs", () => {
    expect(deadlineFor(P, ["cancelled", "reversed"], "2026-10-30")).toMatchObject({ stage: "start" });
  });
  it("asks to finalise only when the pay date is close", () => {
    expect(deadlineFor(P, ["calculated"], "2026-10-29")).toBeNull();
    expect(deadlineFor(P, ["calculated"], "2026-10-31")).toMatchObject({ stage: "finalise" });
    expect(deadlineFor(P, ["pending_approval"], "2026-11-04")).toMatchObject({ stage: "finalise" });
  });
  it("says nothing once a run is finalised", () => {
    for (const s of ["finalized", "accounting", "payment_released", "closed"]) expect(deadlineFor(P, [s], "2026-11-04")).toBeNull();
  });
});

/** Payroll deadline reminders against real Postgres: only payroll people are told, once per period and stage. */
describe("PayrollDeadlineRemindersService", () => {
  let f: PayrollFixture;
  let svc: PayrollDeadlineRemindersService;
  let calendarId: string;
  let periodId: string;
  let plain: Awaited<ReturnType<PayrollFixture["makeUser"]>>;
  const today = "2026-10-29";
  const inbox = (uid: string) => f.sql<{ title: string }>("SELECT title FROM user_notifications WHERE user_account_id = $1 AND category = 'payroll_deadlines' ORDER BY title", [uid]);

  beforeAll(async () => {
    f = await buildPayrollFixture("pdl1");
    svc = new PayrollDeadlineRemindersService(f.db, new UserNotificationsService(f.db, new MailerService()));
    plain = await f.makeUser("pdl-plain", ["employee_self_service"]);
    calendarId = (await f.sql<{ id: string }>("INSERT INTO payroll_calendars (company_id, code, name) VALUES ($1,'M','Monthly') RETURNING id", [f.companyId]))[0].id;
    periodId = (
      await f.sql<{ id: string }>(
        "INSERT INTO payroll_periods (company_id, calendar_id, label, period_start, period_end, pay_date, cutoff_date) VALUES ($1,$2,'October 2026','2026-10-01','2026-10-31','2026-11-02','2026-10-28') RETURNING id",
        [f.companyId, calendarId]
      )
    )[0].id;
  }, 120000);

  afterAll(async () => {
    await f.cleanup();
  }, 60000);

  it("tells the payroll people, not everyone, that a period has no run, and only once", async () => {
    expect(await svc.run(today, f.companyId)).toBeGreaterThan(0);
    expect((await inbox(f.hr.sub as string)).map((n) => n.title)).toEqual(["Payroll for October 2026 has not been started"]);
    expect(await inbox(plain.uid)).toEqual([]);
    expect(await svc.run(today, f.companyId)).toBe(0);
  });

  it("then reminds to finalise when a run exists and the pay date is close", async () => {
    await f.sql(
      "INSERT INTO payroll_runs (company_id, period_start, period_end, created_by_user_account_id, payroll_period_id, status) VALUES ($1,'2026-10-01','2026-10-31',$2,$3,'calculated')",
      [f.companyId, f.hr.sub, periodId]
    );
    expect(await svc.run("2026-10-31", f.companyId)).toBeGreaterThan(0);
    expect((await inbox(f.hr.sub as string)).map((n) => n.title)).toContain("Payroll for October 2026 is not finalised");
  });

  it("stays quiet once the run is finalised", async () => {
    await f.sql("DELETE FROM payroll_runs WHERE company_id = $1", [f.companyId]);
    await f.sql(
      "INSERT INTO payroll_runs (company_id, period_start, period_end, created_by_user_account_id, payroll_period_id, status) VALUES ($1,'2026-10-01','2026-10-31',$2,$3,'finalized')",
      [f.companyId, f.hr.sub, periodId]
    );
    const before = (await inbox(f.hr.sub as string)).length;
    expect(await svc.run("2026-11-02", f.companyId)).toBe(0);
    expect((await inbox(f.hr.sub as string)).length).toBe(before);
  });
});
