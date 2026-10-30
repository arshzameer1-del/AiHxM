import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { HeadcountService } from "./headcount.service";

describe("Headcount plans", () => {
  let f: PayrollFixture;
  let svc: HeadcountService;
  let unit: string;
  let ess: Awaited<ReturnType<PayrollFixture["makeUser"]>>;

  beforeAll(async () => {
    f = await buildPayrollFixture("hcp1");
    svc = new HeadcountService(f.db, f.rbac, f.entitlements, f.audit);
    ess = await f.makeUser("hcpe", ["employee_self_service"]);
    unit = (await f.sql<{ id: string }>("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1,'department','Sales') RETURNING id", [f.companyId]))[0].id;
    for (let i = 0; i < 3; i++) {
      const e = await f.createEmployee({ monthlySalary: null });
      await f.sql("UPDATE employees SET org_unit_id = $2 WHERE id = $1", [e.id, unit]);
    }
    await f.sql("INSERT INTO job_requisitions (company_id, title, department, headcount, status, created_by_user_account_id) VALUES ($1,'Rep','sales',2,'approved',$2)", [f.companyId, f.hr.uid]);
    await f.sql("INSERT INTO job_requisitions (company_id, title, department, headcount, status, created_by_user_account_id) VALUES ($1,'Draft rep','Sales',5,'draft',$2)", [f.companyId, f.hr.uid]);
  }, 120000);
  afterAll(async () => {
    await f.cleanup();
  }, 60000);

  it("is HR only", async () => {
    await expect(svc.list(ess)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("sets the plan beside today's real headcount and the approved open positions", async () => {
    const p = await svc.create(f.hr, { name: "Budget 2026-27", fiscalYear: "2026-27", lines: [{ orgUnitId: unit, plannedCount: 8, note: "Expansion" }] });
    expect(p.lines[0]).toMatchObject({ orgUnitName: "Sales", plannedCount: 8, actualCount: 3, difference: 5, openRequisitionPositions: 2, note: "Expansion" });
    expect(p).toMatchObject({ totalPlanned: 8, totalActual: 3 });
    expect(await svc.list(f.hr)).toHaveLength(1);
    await svc.remove(f.hr, p.id);
    expect(await svc.list(f.hr)).toEqual([]);
  });

  it("refuses an empty plan, a repeated or unknown department and a bad number", async () => {
    await expect(svc.create(f.hr, { name: "x", fiscalYear: "2026", lines: [] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create(f.hr, { name: "x", fiscalYear: "2026", lines: [{ orgUnitId: unit, plannedCount: 1 }, { orgUnitId: unit, plannedCount: 2 }] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create(f.hr, { name: "x", fiscalYear: "2026", lines: [{ orgUnitId: "00000000-0000-4000-8000-000000000000", plannedCount: 1 }] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create(f.hr, { name: "x", fiscalYear: "2026", lines: [{ orgUnitId: unit, plannedCount: -1 }] })).rejects.toBeInstanceOf(BadRequestException);
  });
});
