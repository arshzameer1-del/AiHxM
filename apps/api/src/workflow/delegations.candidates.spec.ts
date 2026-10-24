import { AuditService } from "../audit/audit.service";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { DelegationsService } from "./delegations.service";

/** BACKLOG53: choosing who covers my approvals - search colleagues, and names on the delegations list. */
describe("Delegation candidates and names", () => {
  let f: PayrollFixture;
  let other: PayrollFixture;
  let svc: DelegationsService;
  let boss: Awaited<ReturnType<PayrollFixture["makeUser"]>>;
  let cover: Awaited<ReturnType<PayrollFixture["makeUser"]>>;
  let coverEmp: { id: string; employeeNumber: string };

  beforeAll(async () => {
    f = await buildPayrollFixture("dlg53");
    other = await buildPayrollFixture("dlg54");
    svc = new DelegationsService(f.db, f.rbac, new AuditService());
    boss = await f.makeUser("boss", ["employee_self_service"]);
    cover = await f.makeUser("cover", ["employee_self_service"]);
    await f.createEmployee({ userAccountId: boss.uid, monthlySalary: null });
    coverEmp = await f.createEmployee({ userAccountId: cover.uid, monthlySalary: null });
    await f.sql("UPDATE employees SET first_name = 'Zubair', last_name = 'Quraishi' WHERE id = $1", [coverEmp.id]);
    await f.createEmployee({ monthlySalary: null }); // no login: cannot be a delegate
    const o = await other.makeUser("x", ["employee_self_service"]);
    const oe = await other.createEmployee({ userAccountId: o.uid, monthlySalary: null });
    await other.sql("UPDATE employees SET first_name = 'Zubair', last_name = 'Elsewhere' WHERE id = $1", [oe.id]);
  }, 120000);

  afterAll(async () => {
    await f.cleanup();
    await other.cleanup();
  }, 60000);

  it("needs two letters, finds colleagues by name or number, and only from my own company", async () => {
    expect(await svc.candidates(boss, "z")).toEqual([]);
    const byName = await svc.candidates(boss, "zubair");
    expect(byName).toHaveLength(1);
    expect(byName[0]).toMatchObject({ userAccountId: cover.uid, name: "Zubair Quraishi", employeeNumber: coverEmp.employeeNumber });
    expect((await svc.candidates(boss, coverEmp.employeeNumber)).map((c) => c.userAccountId)).toEqual([cover.uid]);
  });

  it("never offers myself or someone with no login", async () => {
    const all = await svc.candidates(boss, "Test");
    expect(all.map((c) => c.userAccountId)).not.toContain(boss.uid);
    expect(all.every((c) => !!c.userAccountId)).toBe(true);
    expect((await svc.candidates(boss, "%%")).length).toBe(0);
  });

  it("the delegation list shows who covers whom by name", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const end = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const created = await svc.create(boss, { delegateUserAccountId: cover.uid, validTo: end, reason: "On leave" });
    expect(created.delegateName).toBe("Zubair Quraishi");
    expect(created.delegatorName).toContain("Test");
    const mine = await svc.list(cover);
    expect(mine.find((d) => d.id === created.id)).toMatchObject({ delegateName: "Zubair Quraishi", validFrom: today, status: "active" });
    const revoked = await svc.revoke(boss, created.id);
    expect(revoked.status).toBe("revoked");
    expect(revoked.delegateName).toBe("Zubair Quraishi");
  });
});
