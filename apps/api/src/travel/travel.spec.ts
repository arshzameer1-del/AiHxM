import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { localToday } from "../common/local-date";
import { MailerService } from "../mailer/mailer.service";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { TravelService, computeSettlement, tripDays } from "./travel.service";

const plus = (days: number) => new Date(Date.parse(`${localToday()}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

describe("Travel arithmetic", () => {
  it("counts both end days", () => {
    expect(tripDays("2026-03-01", "2026-03-01")).toBe(1);
    expect(tripDays("2026-03-01", "2026-03-04")).toBe(4);
  });
  it("per diem + mileage + other, less the advance", () => {
    expect(computeSettlement({ days: 3, km: 200, otherCost: 5000, advance: 20000, perDiemRate: 6000, mileageRate: 40 })).toMatchObject({ perDiemAmount: 18000, mileageAmount: 8000, totalCost: 31000, netAmount: 11000 });
    expect(computeSettlement({ days: 2, km: 0, otherCost: 0, advance: 15000, perDiemRate: 5000, mileageRate: null })).toMatchObject({ totalCost: 10000, netAmount: -5000 });
    expect(computeSettlement({ days: 1, km: 10, otherCost: 0, advance: 0, perDiemRate: null, mileageRate: null }).totalCost).toBe(0);
  });
});

/** Business travel against real Postgres. */
describe("Business travel", () => {
  let f: PayrollFixture;
  let svc: TravelService;
  let boss: Awaited<ReturnType<PayrollFixture["makeUser"]>>;
  let bossEmp: string;
  let worker: Awaited<ReturnType<PayrollFixture["makeUser"]>>;
  let workerEmp: string;
  let stranger: Awaited<ReturnType<PayrollFixture["makeUser"]>>;

  const submit = (over: Record<string, unknown> = {}, as = worker, emp = workerEmp) =>
    svc.submit(as, { employeeId: emp, destination: "Karachi", purpose: "Client workshop", startDate: plus(3), endDate: plus(5), advanceRequested: 20000, ...over } as never);
  const payments = (label: string) => f.sql<{ payment_type: string; amount: string; status: string }>("SELECT payment_type, amount, status FROM employee_additional_payments WHERE company_id = $1 AND label LIKE $2 ORDER BY created_at", [f.companyId, label]);
  const startNow = (id: string) => f.sql("UPDATE travel_requests SET start_date = $2, end_date = $3 WHERE id = $1", [id, plus(-3), plus(-1)]);

  beforeAll(async () => {
    f = await buildPayrollFixture("trv1");
    await f.sql("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'expense',true) ON CONFLICT DO NOTHING", [f.companyId]);
    svc = new TravelService(f.db, f.rbac, f.entitlements, f.audit, f.additionalPayments, undefined, new UserNotificationsService(f.db, new MailerService()));
    boss = await f.makeUser("travel-boss", ["line_manager"]);
    bossEmp = (await f.createEmployee({ userAccountId: boss.uid, monthlySalary: null })).id;
    worker = await f.makeUser("travel-worker", ["employee_self_service"]);
    workerEmp = (await f.createEmployee({ userAccountId: worker.uid, monthlySalary: null })).id;
    await f.sql("UPDATE employees SET manager_id = $2 WHERE id = $1", [workerEmp, bossEmp]);
    stranger = await f.makeUser("travel-stranger", ["employee_self_service"]);
    await f.createEmployee({ userAccountId: stranger.uid, monthlySalary: null });
  }, 120000);

  afterAll(async () => {
    await f.cleanup();
  }, 60000);

  it("only HR manages rates; staff can read them; rates validate", async () => {
    await expect(svc.saveRate(worker, null, { name: "x", rateKind: "per_diem", tripType: "domestic", amount: 1 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.saveRate(f.hr, null, { name: "", rateKind: "per_diem", tripType: "domestic", amount: 1 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.saveRate(f.hr, null, { name: "Bad", rateKind: "per_diem", tripType: "domestic", amount: 0 })).rejects.toThrow(/more than zero/);
    const pd = await svc.saveRate(f.hr, null, { name: "Domestic per diem", rateKind: "per_diem", tripType: "domestic", amount: 6000 });
    await svc.saveRate(f.hr, null, { name: "Car mileage", rateKind: "mileage", tripType: "domestic", amount: 40 });
    await expect(svc.saveRate(f.hr, null, { name: "domestic PER diem", rateKind: "per_diem", tripType: "domestic", amount: 1 })).rejects.toBeInstanceOf(ConflictException);
    expect((await svc.saveRate(f.hr, pd.id, { name: "Domestic per diem", rateKind: "per_diem", tripType: "domestic", amount: 6500 })).amount).toBe(6500);
    expect((await svc.listRates(worker)).map((r) => r.name)).toContain("Car mileage");
    await svc.saveRate(f.hr, pd.id, { name: "Domestic per diem", rateKind: "per_diem", tripType: "domestic", amount: 6000 });
  });

  it("validates a request and shows an estimate from the company's rates", async () => {
    await expect(submit({ destination: " " })).rejects.toBeInstanceOf(BadRequestException);
    await expect(submit({ endDate: plus(1), startDate: plus(3) })).rejects.toThrow(/cannot end before/);
    await expect(submit({ startDate: plus(-2), endDate: plus(-1) })).rejects.toThrow(/before the trip starts/);
    await expect(submit({ advanceRequested: -1 })).rejects.toThrow(/negative/);
    await expect(submit({}, stranger, workerEmp)).rejects.toBeInstanceOf(ForbiddenException);
    const t = await submit({ estDistanceKm: 100, estOtherCost: 2000 });
    expect(t.status).toBe("pending");
    expect(t.estimatedCost).toBe(3 * 6000 + 100 * 40 + 2000);
    await expect(submit({ startDate: plus(4), endDate: plus(6) })).rejects.toThrow(/already has a travel request/);
    await svc.cancel(worker, t.id);
  });

  it("the manager decides a report's trip; strangers and the traveller themselves cannot", async () => {
    const t = await submit({ startDate: plus(10), endDate: plus(12) });
    expect((await svc.listPending(boss)).map((x) => x.id)).toContain(t.id);
    expect(await svc.listPending(stranger)).toEqual([]);
    await expect(svc.decide(worker, t.id, { decision: "approved" })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.decide(stranger, t.id, { decision: "approved" })).rejects.toBeInstanceOf(ForbiddenException);
    const d = await svc.decide(boss, t.id, { decision: "approved", comment: "Go ahead" });
    expect(d.status).toBe("approved");
    expect(d.decisionComment).toBe("Go ahead");
    await expect(svc.decide(boss, t.id, { decision: "rejected" })).rejects.toBeInstanceOf(ConflictException);
    const notes = await f.sql<{ title: string }>("SELECT title FROM user_notifications WHERE user_account_id = $1 AND title LIKE 'Travel request approved%'", [worker.uid]);
    expect(notes.length).toBeGreaterThan(0);
    const r = await submit({ startDate: plus(20), endDate: plus(21) });
    expect((await svc.decide(f.hr, r.id, { decision: "rejected", comment: "Budget" })).status).toBe("rejected");
  });

  it("advance: HR only, approved trips only, once, never more than asked, and it lands in payroll", async () => {
    const t = await submit({ startDate: plus(30), endDate: plus(32), advanceRequested: 20000 });
    await expect(svc.issueAdvance(f.hr, t.id, { amount: 10000 })).rejects.toThrow(/approved trip/);
    await svc.decide(boss, t.id, { decision: "approved" });
    await expect(svc.issueAdvance(worker, t.id, { amount: 10000 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.issueAdvance(f.hr, t.id, { amount: 25000 })).rejects.toThrow(/up to 20000/);
    await expect(svc.issueAdvance(f.hr, t.id, { amount: 0 })).rejects.toThrow(/more than zero/);
    const v = await svc.issueAdvance(f.hr, t.id, { amount: 15000 });
    expect(v.advanceAmount).toBe(15000);
    expect(await payments("Travel advance: Karachi")).toEqual([{ payment_type: "earning", amount: "15000.00", status: "pending" }]);
    await expect(svc.issueAdvance(f.hr, t.id, { amount: 1000 })).rejects.toThrow(/already issued/);
    // withdrawing the trip before payroll takes the advance back out
    await svc.cancel(worker, t.id);
    expect((await payments("Travel advance: Karachi")).map((p) => p.status)).toEqual(["cancelled"]);
    await expect(svc.cancel(worker, t.id)).rejects.toThrow(/closed/);
  });

  it("no advance asked, no advance paid", async () => {
    const t = await submit({ startDate: plus(40), endDate: plus(41), advanceRequested: 0 });
    await svc.decide(boss, t.id, { decision: "approved" });
    await expect(svc.issueAdvance(f.hr, t.id, { amount: 100 })).rejects.toThrow(/did not ask/);
    await svc.cancel(f.hr, t.id);
  });

  it("settlement owed to the employee is paid through payroll, from rates, less the advance", async () => {
    const t = await submit({ startDate: plus(50), endDate: plus(52), advanceRequested: 10000 });
    await svc.decide(boss, t.id, { decision: "approved" });
    await svc.issueAdvance(f.hr, t.id, { amount: 10000 });
    await expect(svc.settle(f.hr, t.id, { actualDays: 3 })).rejects.toThrow(/not started/);
    await startNow(t.id);
    await expect(svc.settle(worker, t.id, { actualDays: 3 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.settle(f.hr, t.id, { actualDays: 0 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.settle(f.hr, t.id, { actualDays: 3, otherCost: -5 })).rejects.toThrow(/negative/);
    const preview = await svc.previewSettlement(f.hr, t.id, { actualDays: 3, actualKm: 200, otherCost: 4000, otherCostNote: "Taxi" });
    expect(preview).toMatchObject({ perDiemAmount: 18000, mileageAmount: 8000, totalCost: 30000, advanceAmount: 10000, netAmount: 20000 });
    expect((await svc.listAll(f.hr, "approved")).find((x) => x.id === t.id)?.status).toBe("approved"); // preview saved nothing
    const s = await svc.settle(f.hr, t.id, { actualDays: 3, actualKm: 200, otherCost: 4000, otherCostNote: "Taxi" });
    expect(s.status).toBe("settled");
    expect(s.settlement).toMatchObject({ totalCost: 30000, netAmount: 20000, settlementPaymentCreated: true, otherCostNote: "Taxi" });
    expect(await payments("Travel reimbursement: Karachi")).toEqual([{ payment_type: "earning", amount: "20000.00", status: "pending" }]);
    await expect(svc.settle(f.hr, t.id, { actualDays: 3 })).rejects.toThrow(/already settled/);
    await expect(svc.cancel(f.hr, t.id)).rejects.toThrow(/settled/);
  });

  it("an advance larger than the cost is recovered from salary, and an exact match creates no payment", async () => {
    const a = await submit({ destination: "Multan", startDate: plus(60), endDate: plus(61), advanceRequested: 30000 });
    await svc.decide(boss, a.id, { decision: "approved" });
    await svc.issueAdvance(f.hr, a.id, { amount: 30000 });
    await startNow(a.id);
    const s = await svc.settle(f.hr, a.id, { actualDays: 2 });
    expect(s.settlement?.netAmount).toBe(-18000);
    expect(await payments("Travel advance recovery: Multan")).toEqual([{ payment_type: "deduction", amount: "18000.00", status: "pending" }]);

    const b = await submit({ destination: "Quetta", startDate: plus(70), endDate: plus(71), advanceRequested: 12000 });
    await svc.decide(boss, b.id, { decision: "approved" });
    await svc.issueAdvance(f.hr, b.id, { amount: 12000 });
    await startNow(b.id);
    const sb = await svc.settle(f.hr, b.id, { actualDays: 2 });
    expect(sb.settlement).toMatchObject({ netAmount: 0, settlementPaymentCreated: false });
    expect(await payments("Travel %: Quetta")).toHaveLength(1); // only the advance
  });

  it("an employee sees only their own trips, HR sees all", async () => {
    expect((await svc.listMine(worker)).length).toBeGreaterThan(3);
    expect(await svc.listMine(stranger)).toEqual([]);
    await expect(svc.listAll(worker)).rejects.toBeInstanceOf(ForbiddenException);
    expect((await svc.listAll(f.hr)).length).toBeGreaterThan(3);
  });

  it("the module is invisible when expense is not licensed", async () => {
    await f.sql("UPDATE tenant_module_entitlement SET enabled = false WHERE company_id = $1 AND module_key = 'expense'", [f.companyId]);
    await expect(svc.listMine(worker)).rejects.toBeInstanceOf(NotFoundException);
    await f.sql("UPDATE tenant_module_entitlement SET enabled = true WHERE company_id = $1 AND module_key = 'expense'", [f.companyId]);
  });
});
