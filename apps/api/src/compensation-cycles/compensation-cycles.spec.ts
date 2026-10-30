import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { EmployeeCompensationService } from "../employees/employee-compensation.service";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { CompensationCyclesService } from "./compensation-cycles.service";

describe("Compensation planning cycles", () => {
  let f: PayrollFixture;
  let svc: CompensationCyclesService;
  let comp: EmployeeCompensationService;
  let ess: Awaited<ReturnType<PayrollFixture["makeUser"]>>;
  let a: { id: string; employeeNumber: string };
  let b: { id: string; employeeNumber: string };
  let noPay: { id: string };

  const basicOf = async (employeeId: string) =>
    Number((await f.sql<{ s: string }>(`SELECT sum(cc.amount) AS s FROM employee_compensation_components cc JOIN compensation_components k ON k.id = cc.component_id WHERE cc.employee_id = $1 AND k.key = 'basic_salary' AND cc.effective_to IS NULL`, [employeeId]))[0].s);

  beforeAll(async () => {
    f = await buildPayrollFixture("cmc1");
    comp = new EmployeeCompensationService(f.db, f.rbac, f.entitlements, f.audit, new EffectiveDatingEngine());
    svc = new CompensationCyclesService(f.db, f.rbac, f.entitlements, f.audit, comp);
    ess = await f.makeUser("cmce", ["employee_self_service"]);
    a = await f.createEmployee({ monthlySalary: 100000 });
    b = await f.createEmployee({ monthlySalary: 50000 });
    noPay = await f.createEmployee({ monthlySalary: null });
  }, 120000);
  afterAll(async () => {
    await f.cleanup();
  }, 60000);

  it("is HR only", async () => {
    await expect(svc.list(ess)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.create(ess, { name: "x", effectiveFrom: "2071-01-01" })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("loads people with a basic salary, proposes, and refuses to submit with nothing changed", async () => {
    const cyc = await svc.create(f.hr, { name: "Annual increments", effectiveFrom: "2071-01-01", budgetAmount: 8000 });
    const loaded = await svc.loadPeople(f.hr, cyc.id);
    expect(loaded.withoutBasic).toBeGreaterThanOrEqual(1);
    expect(loaded.cycle.items.map((i) => i.employeeId)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(loaded.cycle.items.find((i) => i.employeeId === noPay.id)).toBeUndefined();
    await expect(svc.submit(f.hr, cyc.id)).rejects.toBeInstanceOf(BadRequestException);
    const saved = await svc.saveItems(f.hr, cyc.id, { items: [{ employeeId: a.id, proposedBasic: 110000, reason: "Merit" }, { employeeId: b.id, proposedBasic: 52000 }] });
    expect(saved).toMatchObject({ totalMonthlyIncrease: 12000, changedCount: 2 });
    expect(saved.items.find((i) => i.employeeId === a.id)).toMatchObject({ changePercent: 10, reason: "Merit" });
    await expect(svc.saveItems(f.hr, cyc.id, { items: [{ employeeId: a.id, proposedBasic: -1 }] })).rejects.toBeInstanceOf(BadRequestException);
    await svc.submit(f.hr, cyc.id);
    // nothing has reached payroll yet
    expect(await basicOf(a.id)).toBe(100000);
    // over budget: 12,000 > 8,000
    await expect(svc.approve(f.hr, cyc.id, true)).rejects.toBeInstanceOf(ConflictException);
    // back to draft, trim, resubmit; submitter approving needs an explicit confirmation
    await svc.withdraw(f.hr, cyc.id);
    await svc.saveItems(f.hr, cyc.id, { items: [{ employeeId: a.id, proposedBasic: 105000 }, { employeeId: b.id, proposedBasic: 52000 }] });
    await svc.submit(f.hr, cyc.id);
    await expect(svc.approve(f.hr, cyc.id)).rejects.toBeInstanceOf(BadRequestException);
    const approved = await svc.approve(f.hr, cyc.id, true);
    expect(approved.status).toBe("approved");
    expect(await basicOf(a.id)).toBe(100000); // approved is not applied
    await expect(svc.saveItems(f.hr, cyc.id, { items: [] })).rejects.toBeInstanceOf(ConflictException);
    const applied = await svc.apply(f.hr, cyc.id);
    expect(applied.status).toBe("applied");
    expect(await basicOf(a.id)).toBe(105000);
    expect(await basicOf(b.id)).toBe(52000);
    const row = await f.sql<{ effective_from: Date }>(`SELECT cc.effective_from FROM employee_compensation_components cc JOIN compensation_components k ON k.id = cc.component_id WHERE cc.employee_id = $1 AND k.key = 'basic_salary' AND cc.effective_to IS NULL`, [a.id]);
    expect(row[0].effective_from.toISOString().slice(0, 10)).toBe("2071-01-01");
    await expect(svc.apply(f.hr, cyc.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses to apply when a basic salary changed after the cycle started, and a cancelled cycle changes nothing", async () => {
    const cyc = await svc.create(f.hr, { name: "Second", effectiveFrom: "2072-01-01" });
    await svc.loadPeople(f.hr, cyc.id);
    await svc.saveItems(f.hr, cyc.id, { items: [{ employeeId: a.id, proposedBasic: 120000 }] });
    await svc.submit(f.hr, cyc.id);
    await svc.approve(f.hr, cyc.id, true);
    await comp.setCompensation(f.hr, { employeeId: a.id, monthlySalary: 108000, effectiveFrom: "2071-06-01" });
    await expect(svc.apply(f.hr, cyc.id)).rejects.toBeInstanceOf(ConflictException);
    expect(await basicOf(a.id)).toBe(108000);
    const c = await svc.cancel(f.hr, cyc.id);
    expect(c.status).toBe("cancelled");
    await expect(svc.apply(f.hr, cyc.id)).rejects.toBeInstanceOf(ConflictException);
  });
});
