import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { EmployeesService } from "./employees.service";

/** The employee list is cut into pages in the database, and what each caller may see is part of that query. */
describe("Employee list paging", () => {
  let f: PayrollFixture;
  let svc: EmployeesService;
  let ids: string[] = [];
  let mine: string;

  beforeAll(async () => {
    f = await buildPayrollFixture("emppage");
    svc = new EmployeesService(f.db, f.rbac, f.entitlements, f.audit, new LocalFileStorageService());
    for (let i = 0; i < 7; i++) ids.push((await f.createEmployee({ monthlySalary: null, userAccountId: i === 3 ? f.staff.sub : null })).id);
    mine = ids[3];
  }, 120000);
  afterAll(async () => {
    await f.cleanup();
  }, 60000);

  it("without a page it returns every visible employee, as before", async () => {
    const all = await svc.list(f.hr);
    expect(all.map((e) => e.id)).toEqual(expect.arrayContaining(ids));
    const withPage = await svc.listPage(f.hr);
    expect(withPage.items.length).toBe(withPage.total);
    expect(withPage.items.map((e) => e.id)).toEqual(all.map((e) => e.id));
  });

  it("pages are slices of the same ordered list, with the full total each time", async () => {
    const all = (await svc.listPage(f.hr)).items.map((e) => e.id);
    const p1 = await svc.listPage(f.hr, { limit: 3, offset: 0 });
    const p2 = await svc.listPage(f.hr, { limit: 3, offset: 3 });
    const p3 = await svc.listPage(f.hr, { limit: 3, offset: 6 });
    expect(p1.items.map((e) => e.id)).toEqual(all.slice(0, 3));
    expect(p2.items.map((e) => e.id)).toEqual(all.slice(3, 6));
    expect(p3.items.map((e) => e.id)).toEqual(all.slice(6, 9));
    for (const p of [p1, p2, p3]) expect(p.total).toBe(all.length);
    // no overlap, nothing missing
    expect([...p1.items, ...p2.items, ...p3.items].map((e) => e.id)).toEqual(all.slice(0, 9));
  });

  it("a page past the end is empty but still reports the real total", async () => {
    const all = (await svc.listPage(f.hr)).items.length;
    const past = await svc.listPage(f.hr, { limit: 10, offset: 500 });
    expect(past.items).toEqual([]);
    expect(past.total).toBe(all);
  });

  it("a person who may only see their own record gets just that record, and the total says 1", async () => {
    const page = await svc.listPage(f.staff, { limit: 2, offset: 0 });
    expect(page.items.map((e) => e.id)).toEqual([mine]);
    expect(page.total).toBe(1);
    const second = await svc.listPage(f.staff, { limit: 2, offset: 1 });
    expect(second.items).toEqual([]);
    expect(second.total).toBe(1);
  });
});
