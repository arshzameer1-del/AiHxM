import { Pool } from "pg";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EmployeesService } from "../employees/employees.service";
import { EmployeeGroupsService } from "../employee-groups/employee-groups.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { RulesEngine } from "../rules-engine/rules-engine.engine";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { PerformanceService } from "./performance.service";
import { KeyResultsService, keyResultProgress, rollUp } from "./key-results.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "keyresults-spec-fixtures" };

/** OKR key results and goal alignment against real Postgres. */
describe("Key results", () => {
  let pool: Pool;
  let db: DatabaseService;
  let rbac: RbacService;
  let entitlements: EntitlementsService;
  let audit: AuditService;
  let employees: EmployeesService;
  let groups: EmployeeGroupsService;
  let performance: PerformanceService;
  let krs: KeyResultsService;

  let companyId: string;
  let hrAdminClaims: RequestClaims;
  let managerClaims: RequestClaims;
  let staffClaims: RequestClaims;
  let outsiderClaims: RequestClaims;

  let managerEmployeeId: string;
  let managerUserId: string;
  let staffEmployeeId: string;
  let staffUserId: string;
  let otherDeptEmployeeId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    rbac = new RbacService(db);
    entitlements = new EntitlementsService(db);
    audit = new AuditService();
    employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
    groups = new EmployeeGroupsService(db, rbac, entitlements, new EffectiveDatingEngine(), new RulesEngine());
    performance = new PerformanceService(db, rbac, entitlements, audit, groups);
    krs = new KeyResultsService(db, rbac, entitlements, audit);

    const stamp = Date.now();

    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `KeyResults Spec Co ${stamp}`,
        `keyresults-spec-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee", "performance"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query(
        "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true), ($1, 'performance', true)",
        [id]
      );
      return id;
    });

    async function makeUser(email: string): Promise<string> {
      return db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
          email,
        ]);
        return result.rows[0].id as string;
      });
    }
    async function assignRole(userAccountId: string, roleKey: string): Promise<void> {
      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
        await client.query(
          "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
          [userAccountId, companyId, role.rows[0].id]
        );
      });
    }

    const hrAdminUserId = await makeUser(`kr-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

    managerUserId = await makeUser(`kr-mgr-${stamp}@example.com`);
    await assignRole(managerUserId, "line_manager");
    await assignRole(managerUserId, "employee_self_service");
    managerClaims = { is_platform_admin: false, company_id: companyId, sub: managerUserId };

    staffUserId = await makeUser(`kr-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service");
    staffClaims = { is_platform_admin: false, company_id: companyId, sub: staffUserId };

    const otherDeptUserId = await makeUser(`kr-other-${stamp}@example.com`);
    await assignRole(otherDeptUserId, "employee_self_service");

    const outsiderUserId = await makeUser(`kr-outsider-${stamp}@example.com`);
    outsiderClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };

    managerEmployeeId = (
      await employees.create(hrAdminClaims, {
        firstName: "Maya",
        lastName: "Manager",
        department: "Engineering",
        userAccountId: managerUserId,
      })
    ).id;
    staffEmployeeId = (
      await employees.create(hrAdminClaims, {
        firstName: "Sam",
        lastName: "Staff",
        department: "Engineering",
        designation: "QA Analyst",
        managerId: managerEmployeeId,
        userAccountId: staffUserId,
      })
    ).id;
    otherDeptEmployeeId = (
      await employees.create(hrAdminClaims, {
        firstName: "Olivia",
        lastName: "Other",
        department: "Sales",
        userAccountId: otherDeptUserId,
      })
    ).id;
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  const num = (v: unknown) => Number(v);

  describe("the arithmetic", () => {
    it("measures progress from the start towards the target, in either direction, within 0-100", () => {
      expect(keyResultProgress(0, 100, 25)).toBe(25);
      expect(keyResultProgress(90, 60, 75)).toBe(50);
      expect(keyResultProgress(0, 100, 150)).toBe(100);
      expect(keyResultProgress(0, 100, -10)).toBe(0);
      expect(keyResultProgress(5, 5, 9)).toBe(0);
    });
    it("rolls up as a weighted average", () => {
      expect(rollUp([{ progress: 100, weight: 1 }, { progress: 0, weight: 3 }])).toBe(25);
      expect(rollUp([])).toBe(0);
    });
  });

  describe("key results on a goal", () => {
    let cycleId: string;
    let goalId: string;
    let parentGoalId: string;
    let otherGoalId: string;

    beforeAll(async () => {
      const cycle = await performance.createCycle(hrAdminClaims, { name: "KR Cycle 2026", periodStart: "2026-01-01", periodEnd: "2026-12-31" });
      cycleId = cycle.id;
      await performance.launchCycle(hrAdminClaims, cycleId);
      parentGoalId = (await performance.createGoal(managerClaims, { reviewCycleId: cycleId, employeeId: managerEmployeeId, title: "Department: cut defects" })).id;
      goalId = (await performance.createGoal(staffClaims, { reviewCycleId: cycleId, employeeId: staffEmployeeId, parentGoalId, title: "Fix recurring bugs", weight: 100 })).id;
      otherGoalId = (await performance.createGoal(hrAdminClaims, { reviewCycleId: cycleId, employeeId: otherDeptEmployeeId, title: "Grow pipeline" })).id;
    });

    it("the owner adds key results and a check-in moves the goal by weight", async () => {
      const a = await krs.create(staffClaims, goalId, { title: "Close recurring bugs", targetValue: 10, unit: "bugs" });
      expect(a.keyResults).toHaveLength(1);
      const b = await krs.create(staffClaims, goalId, { title: "Cut average fix time", startValue: 8, targetValue: 4, unit: "days", weight: 3 });
      const [bugs, days] = b.keyResults;

      const r1 = await krs.checkIn(staffClaims, bugs!.id, { currentValue: 10, note: "all closed" });
      expect(r1.goalProgressPct).toBe(25); // 100% of weight 1 out of 4
      expect(r1.goalStatus).toBe("in_progress");
      const r2 = await krs.checkIn(staffClaims, days!.id, { currentValue: 6 });
      expect(r2.keyResults.find((k) => k.id === days!.id)?.progressPct).toBe(50);
      expect(r2.goalProgressPct).toBe(62.5);

      const goal = (await performance.listGoals(hrAdminClaims, { reviewCycleId: cycleId, employeeId: staffEmployeeId })).find((g) => g.id === goalId)!;
      expect(goal.progressPct).toBe(62.5);
      const history = await db.withClaims(FIXTURE_CLAIMS, (c) => c.query("SELECT update_type, progress_pct, note FROM goal_updates WHERE goal_id = $1 ORDER BY created_at", [goalId]));
      expect(history.rows.some((h) => h.update_type === "progress" && num(h.progress_pct) === 25 && h.note === "all closed")).toBe(true);
    });

    it("the goal's own progress can't be typed over while key results drive it", async () => {
      await expect(performance.updateGoal(staffClaims, goalId, { progressPct: 90 })).rejects.toThrow(/key results/);
      await expect(performance.updateGoal(staffClaims, goalId, { currentValue: 3 })).rejects.toThrow(/key results/);
    });

    it("a manager can check in for a direct report; others cannot see or touch them", async () => {
      const list = await krs.list(managerClaims, goalId);
      expect(list.keyResults.length).toBe(2);
      const first = list.keyResults[0]!;
      await krs.checkIn(managerClaims, first.id, { currentValue: 9 });
      await expect(krs.list(outsiderClaims, goalId)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(krs.list(managerClaims, otherGoalId)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(krs.checkIn(outsiderClaims, first.id, { currentValue: 1 })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(krs.create(outsiderClaims, goalId, { title: "x", targetValue: 5 })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(krs.list(hrAdminClaims, "00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("validates the numbers, the title and the cap of ten", async () => {
      await expect(krs.create(staffClaims, goalId, { title: "", targetValue: 5 })).rejects.toThrow(/title/);
      await expect(krs.create(staffClaims, goalId, { title: "Same", startValue: 5, targetValue: 5 })).rejects.toThrow(/different/);
      await expect(krs.create(staffClaims, goalId, { title: "Weighty", targetValue: 5, weight: 0 })).rejects.toThrow(/Weight/);
      await expect(krs.create(staffClaims, goalId, { title: "Unit", targetValue: 5, unit: "x".repeat(41) })).rejects.toThrow(/Unit/);
      await expect(krs.create(staffClaims, goalId, { title: "NaN", targetValue: Number.NaN })).rejects.toThrow(/numbers/);
      const cur = (await krs.list(staffClaims, goalId)).keyResults.length;
      for (let i = cur; i < 10; i++) await krs.create(staffClaims, goalId, { title: `Filler ${i}`, targetValue: 100 });
      await expect(krs.create(staffClaims, goalId, { title: "Eleventh", targetValue: 5 })).rejects.toThrow(/up to 10/);
    });

    it("editing the target recomputes progress, removing one re-rolls the goal", async () => {
      const list = (await krs.list(staffClaims, goalId)).keyResults;
      const fillers = list.filter((k) => k.title.startsWith("Filler"));
      for (const f of fillers) await krs.remove(staffClaims, f.id);
      const after = await krs.list(staffClaims, goalId);
      expect(after.keyResults).toHaveLength(2);
      const bugs = after.keyResults.find((k) => k.title === "Close recurring bugs")!;
      const edited = await krs.update(staffClaims, bugs.id, { targetValue: 20 });
      expect(edited.keyResults.find((k) => k.id === bugs.id)?.progressPct).toBe(45); // 9 of 20
      const kept = after.keyResults.find((k) => k.title !== "Close recurring bugs")!;
      const removed = await krs.remove(staffClaims, bugs.id);
      expect(removed.keyResults).toHaveLength(1);
      expect(removed.goalProgressPct).toBe(kept.progressPct);
    });

    it("a finalised plan locks the shape for the owner but not check-ins; HR can still add", async () => {
      await performance.finaliseGoalPlan(staffClaims, { reviewCycleId: cycleId, employeeId: staffEmployeeId });
      await expect(krs.create(staffClaims, goalId, { title: "Late", targetValue: 5 })).rejects.toThrow(/finalised/);
      const only = (await krs.list(staffClaims, goalId)).keyResults[0]!;
      await expect(krs.update(staffClaims, only.id, { weight: 2 })).rejects.toThrow(/finalised/);
      await expect(krs.remove(staffClaims, only.id)).rejects.toThrow(/finalised/);
      const ok = await krs.checkIn(staffClaims, only.id, { currentValue: 5 });
      expect(ok.keyResults[0]!.currentValue).toBe(5);
      const hrAdd = await krs.create(hrAdminClaims, goalId, { title: "HR added", targetValue: 50 });
      expect(hrAdd.keyResults).toHaveLength(2);
    });

    it("reaching every target completes the goal, and a completed goal's key results are frozen", async () => {
      const list = (await krs.list(staffClaims, goalId)).keyResults;
      let last = await krs.list(staffClaims, goalId);
      for (const k of list) last = await krs.checkIn(staffClaims, k.id, { currentValue: k.targetValue });
      expect(last.goalProgressPct).toBe(100);
      expect(last.goalStatus).toBe("completed");
      await expect(krs.checkIn(staffClaims, list[0]!.id, { currentValue: 1 })).rejects.toThrow(/completed/);
    });

    it("staff and managers can see the cycles that have started (to know where to set goals), never drafts; outsiders cannot", async () => {
      const draft = await performance.createCycle(hrAdminClaims, { name: "Draft only", periodStart: "2027-01-01", periodEnd: "2027-12-31" });
      const staffSees = await performance.listCycles(staffClaims);
      expect(staffSees.some((c) => c.id === cycleId)).toBe(true);
      expect(staffSees.some((c) => c.id === draft.id)).toBe(false);
      expect((await performance.listCycles(managerClaims)).some((c) => c.id === cycleId)).toBe(true);
      expect((await performance.listCycles(hrAdminClaims)).some((c) => c.id === draft.id)).toBe(true);
      await expect(performance.listCycles(outsiderClaims)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("the alignment tree shows what the reader may open, plus parents as context", async () => {
      const staffView = await krs.alignment(staffClaims, cycleId);
      const mine = staffView.find((n) => n.goalId === goalId)!;
      expect(mine).toMatchObject({ parentGoalId, isContext: false });
      expect(mine.keyResultCount).toBe(2);
      expect(staffView.find((n) => n.goalId === parentGoalId)).toMatchObject({ isContext: true, employeeName: "Maya Manager" });
      expect(staffView.some((n) => n.goalId === otherGoalId)).toBe(false);

      const hrView = await krs.alignment(hrAdminClaims, cycleId);
      expect(hrView.map((n) => n.goalId)).toEqual(expect.arrayContaining([goalId, parentGoalId, otherGoalId]));
      expect(hrView.every((n) => !n.isContext)).toBe(true);
      expect(await krs.alignment(outsiderClaims, cycleId)).toEqual([]);
    });
  });
});
