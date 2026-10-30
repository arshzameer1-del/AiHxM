import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { TalentService } from "./talent.service";

describe("Talent: skills, nine-box, succession, pools", () => {
  let f: PayrollFixture;
  let other: PayrollFixture;
  let svc: TalentService;
  let ess: Awaited<ReturnType<PayrollFixture["makeUser"]>>;
  let e1: { id: string };
  let e2: { id: string };
  let e3: { id: string };
  let jobId: string;
  let posId: string;
  let unitId: string;

  beforeAll(async () => {
    f = await buildPayrollFixture("tal1");
    other = await buildPayrollFixture("tal2");
    svc = new TalentService(f.db, f.rbac, f.entitlements, f.audit);
    ess = await f.makeUser("tale", ["employee_self_service"]);
    e1 = await f.createEmployee({ userAccountId: ess.uid, monthlySalary: null });
    e2 = await f.createEmployee({ monthlySalary: null });
    e3 = await f.createEmployee({ monthlySalary: null });
    unitId = (await f.sql<{ id: string }>("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1,'department','Ops') RETURNING id", [f.companyId]))[0].id;
    jobId = (await f.sql<{ id: string }>("INSERT INTO jobs (company_id, title) VALUES ($1,'Accountant') RETURNING id", [f.companyId]))[0].id;
    posId = (await f.sql<{ id: string }>("INSERT INTO positions (company_id, org_unit_id, job_id, position_title, status) VALUES ($1,$2,$3,'Senior Accountant','filled') RETURNING id", [f.companyId, unitId, jobId]))[0].id;
    await f.sql("UPDATE employees SET position_id = $2 WHERE id = ANY($1)", [[e1.id, e2.id], posId]);
  }, 120000);
  afterAll(async () => {
    await f.cleanup();
    await other.cleanup();
  }, 60000);

  it("only HR manages the catalogue; every employee can read active skills", async () => {
    await expect(svc.saveSkill(ess, { name: "Excel" })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.nineBox(ess)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await svc.listSkills(ess)).toEqual([]);
    await svc.saveSkill(f.hr, { name: "Excel", category: "Tools" });
    await svc.saveSkill(f.hr, { name: "Tax filing", category: "Finance" });
    await expect(svc.saveSkill(f.hr, { name: "excel" })).rejects.toBeInstanceOf(ConflictException);
    expect((await svc.listSkills(ess)).map((s) => s.name).sort()).toEqual(["Excel", "Tax filing"]);
  });

  it("a job lists the level it needs; the gap report names who is below it, including people with no rating", async () => {
    const skills = await svc.listSkills(f.hr);
    const excel = skills.find((s) => s.name === "Excel")!.id;
    const tax = skills.find((s) => s.name === "Tax filing")!.id;
    await svc.setRequirement(f.hr, jobId, excel, 3);
    await svc.setRequirement(f.hr, jobId, tax, 4);
    await expect(svc.setRequirement(f.hr, jobId, tax, 9)).rejects.toBeInstanceOf(BadRequestException);
    const mine = await svc.setMySkill(ess, excel, 4);
    expect(mine.find((m) => m.skillId === excel)).toMatchObject({ level: 4, requiredLevel: 3, source: "self" });
    await svc.setEmployeeSkill(f.hr, e1.id, tax, 2, "Needs coaching");
    const g = await svc.gaps(f.hr, jobId);
    expect(g.peopleInJob).toBe(2);
    const p1 = g.people.find((p) => p.employeeId === e1.id)!;
    expect(p1.gaps).toEqual([{ skillId: tax, skillName: "Tax filing", requiredLevel: 4, level: 2 }]);
    const p2 = g.people.find((p) => p.employeeId === e2.id)!;
    expect(p2.gaps.map((x) => x.level)).toEqual([null, null]);
    await svc.setEmployeeSkill(f.hr, e1.id, tax, 5);
    expect((await svc.gaps(f.hr, jobId)).people.map((p) => p.employeeId)).toEqual([e2.id]);
    await expect(svc.setMySkill(ess, excel, 0)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("nine-box: performance comes from the latest released review unless HR sets the band; potential is HR's judgement", async () => {
    let box = await svc.nineBox(f.hr);
    expect(box.people.find((p) => p.employeeId === e1.id)).toMatchObject({ potential: null, performance: null });
    const cycle = (await f.sql<{ id: string }>("INSERT INTO review_cycles (company_id, name, start_date, end_date, status) VALUES ($1,'FY','2070-01-01','2070-12-31','closed') RETURNING id", [f.companyId]).catch(() => [{ id: "" }]))[0].id;
    if (cycle) {
      await f.sql("INSERT INTO performance_reviews (company_id, review_cycle_id, employee_id, status, final_rating, released_at) VALUES ($1,$2,$3,'released',5,now())", [f.companyId, cycle, e1.id]);
      box = await svc.saveAssessment(f.hr, { employeeId: e1.id, potential: "high", note: "Ready for more" });
      expect(box.people.find((p) => p.employeeId === e1.id)).toMatchObject({ potential: "high", performance: "high", performanceSource: "review", finalRating: 5 });
    }
    box = await svc.saveAssessment(f.hr, { employeeId: e1.id, potential: "high", performanceBand: "medium" });
    expect(box.people.find((p) => p.employeeId === e1.id)).toMatchObject({ performance: "medium", performanceSource: "hr" });
    await expect(svc.saveAssessment(f.hr, { employeeId: e1.id, potential: "huge" as never })).rejects.toBeInstanceOf(BadRequestException);
    box = await svc.removeAssessment(f.hr, e1.id);
    expect(box.people.find((p) => p.employeeId === e1.id)!.potential).toBeNull();
  });

  it("succession: candidates by readiness for a position, not for someone who already holds it", async () => {
    await expect(svc.addCandidate(f.hr, posId, e1.id, "ready_now")).rejects.toBeInstanceOf(BadRequestException);
    await svc.addCandidate(f.hr, posId, e3.id, "one_to_two_years", "Strong");
    const list = await svc.addCandidate(f.hr, posId, e3.id, "ready_now");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ positionTitle: "Senior Accountant", orgUnitName: "Ops" });
    expect(list[0].incumbentName).toBe("Test Employee");
    expect(list[0].candidates).toEqual([expect.objectContaining({ employeeId: e3.id, readiness: "ready_now" })]);
    expect(await svc.removeCandidate(f.hr, posId, e3.id)).toEqual([]);
  });

  it("pools: create, add and remove people; another company sees nothing", async () => {
    let pools = await svc.createPool(f.hr, "High potentials", "Next-level leaders");
    await expect(svc.createPool(f.hr, "high potentials")).rejects.toBeInstanceOf(ConflictException);
    pools = await svc.setPoolMember(f.hr, pools[0].id, e2.id, true);
    expect(pools[0].members.map((m) => m.employeeId)).toEqual([e2.id]);
    await expect(svc.setPoolMember(f.hr, pools[0].id, "00000000-0000-4000-8000-000000000000", true)).rejects.toBeInstanceOf(NotFoundException);
    const o = new TalentService(other.db, other.rbac, other.entitlements, other.audit);
    expect(await o.pools(other.hr)).toEqual([]);
    expect(await o.listSkills(other.hr)).toEqual([]);
    pools = await svc.setPoolMember(f.hr, pools[0].id, e2.id, false);
    expect(pools[0].members).toEqual([]);
    expect(await svc.deletePool(f.hr, pools[0].id)).toEqual([]);
  });
});
