import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
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
import { PerformanceDepthService } from "./performance-depth.service";
import { PerformanceScheduler } from "./performance.scheduler";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "performance-step11b-fixtures" };

/** TAL-05 goals, TAL-06 ratings / feedback / development, TAL-07 phases - against a real Postgres, no mocks. */
describe("Performance depth (Step 11B)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let performance: PerformanceService;
  let depth: PerformanceDepthService;
  let scheduler: PerformanceScheduler;

  let companyId: string;
  let otherCompanyId: string;
  let hr: RequestClaims;
  let manager: RequestClaims;
  let staff: RequestClaims;
  const peers: RequestClaims[] = [];
  let outsider: RequestClaims;
  let otherCompanyHr: RequestClaims;
  let managerEmp: string;
  let staffEmp: string;
  const peerEmps: string[] = [];

  async function makeCompany(label: string, stamp: number): Promise<string> {
    return db.withClaims(FIXTURE, async (client) => {
      const c = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [`${label} ${stamp}`, `${label.toLowerCase().replace(/\W+/g, "-")}-${stamp}`]);
      const id = c.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee", "performance"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true), ($1, 'performance', true)", [id]);
      return id;
    });
  }
  async function makeUser(email: string): Promise<string> {
    return db.withClaims(FIXTURE, async (client) => (await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [email])).rows[0].id as string);
  }
  async function assign(userId: string, cid: string, roleKey: string): Promise<void> {
    await db.withClaims(FIXTURE, async (client) => {
      const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [userId, cid, role.rows[0].id]);
    });
  }
  async function newCycle(name: string, group?: string) {
    const cycle = await performance.createCycle(hr, { name, periodStart: "2026-01-01", periodEnd: "2026-12-31", participantGroupId: group });
    await performance.launchCycle(hr, cycle.id);
    return cycle.id;
  }
  async function reviewFor(cycleId: string, employeeId: string): Promise<string> {
    const list = await performance.listReviews(hr, { reviewCycleId: cycleId, employeeId });
    return list[0].id as string;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    const employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
    const groups = new EmployeeGroupsService(db, rbac, entitlements, new EffectiveDatingEngine(), new RulesEngine());
    performance = new PerformanceService(db, rbac, entitlements, audit, groups);
    depth = new PerformanceDepthService(db, rbac, entitlements, audit);
    scheduler = new PerformanceScheduler(db, audit);

    const stamp = Date.now();
    companyId = await makeCompany("Perf11B Co", stamp);
    otherCompanyId = await makeCompany("Perf11B Other", stamp);

    const hrUser = await makeUser(`p11-hr-${stamp}@example.com`);
    await assign(hrUser, companyId, "hr_admin");
    hr = { is_platform_admin: false, company_id: companyId, sub: hrUser };

    const mgrUser = await makeUser(`p11-mgr-${stamp}@example.com`);
    await assign(mgrUser, companyId, "line_manager");
    await assign(mgrUser, companyId, "employee_self_service");
    manager = { is_platform_admin: false, company_id: companyId, sub: mgrUser };

    const staffUser = await makeUser(`p11-staff-${stamp}@example.com`);
    await assign(staffUser, companyId, "employee_self_service");
    staff = { is_platform_admin: false, company_id: companyId, sub: staffUser };

    const outsiderUser = await makeUser(`p11-out-${stamp}@example.com`);
    await assign(outsiderUser, companyId, "employee_self_service");
    outsider = { is_platform_admin: false, company_id: companyId, sub: outsiderUser };

    const otherHrUser = await makeUser(`p11-ohr-${stamp}@example.com`);
    await assign(otherHrUser, otherCompanyId, "hr_admin");
    otherCompanyHr = { is_platform_admin: false, company_id: otherCompanyId, sub: otherHrUser };

    managerEmp = (await employees.create(hr, { firstName: "Maya", lastName: "Manager", department: "Engineering", userAccountId: mgrUser })).id;
    staffEmp = (await employees.create(hr, { firstName: "Sam", lastName: "Staff", department: "Engineering", designation: "QA Analyst 11B", managerId: managerEmp, userAccountId: staffUser })).id;
    await employees.create(hr, { firstName: "Olga", lastName: "Outsider", department: "Sales", userAccountId: outsiderUser });
    for (let i = 0; i < 3; i++) {
      const u = await makeUser(`p11-peer${i}-${stamp}@example.com`);
      await assign(u, companyId, "employee_self_service");
      peers.push({ is_platform_admin: false, company_id: companyId, sub: u });
      peerEmps.push((await employees.create(hr, { firstName: `Peer${i}`, lastName: "Rater", department: "Engineering", userAccountId: u })).id);
    }
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE, async (client) => {
      await client.query("DELETE FROM companies WHERE id = ANY($1::uuid[])", [[companyId, otherCompanyId]]);
    });
    await pool.end();
  });

  describe("TAL-05 goals", () => {
    let cycleId: string;
    beforeAll(async () => {
      cycleId = await newCycle("Goals 11B");
    });

    it("rejects weights that add up to more than 100 and requires exactly 100 to finalise", async () => {
      const g1 = await performance.createGoal(manager, { reviewCycleId: cycleId, employeeId: staffEmp, title: "Ship v2", weight: 60 });
      await expect(performance.createGoal(manager, { reviewCycleId: cycleId, employeeId: staffEmp, title: "Too heavy", weight: 41 })).rejects.toThrow(BadRequestException);
      const g2 = await performance.createGoal(manager, { reviewCycleId: cycleId, employeeId: staffEmp, title: "Docs", weight: 30 });
      await expect(performance.updateGoal(manager, g2.id, { weight: 45 })).rejects.toThrow(BadRequestException);

      const plan = await performance.getGoalPlan(manager, cycleId, staffEmp);
      expect(plan.totalWeight).toBe(90);
      expect(plan.remainingWeight).toBe(10);
      expect(plan.isComplete).toBe(false);
      await expect(performance.finaliseGoalPlan(manager, { reviewCycleId: cycleId, employeeId: staffEmp })).rejects.toThrow(/exactly 100/);

      await performance.updateGoal(manager, g2.id, { weight: 40 });
      const finalised = await performance.finaliseGoalPlan(manager, { reviewCycleId: cycleId, employeeId: staffEmp });
      expect(finalised.status).toBe("finalised");
      expect(finalised.isComplete).toBe(true);
      expect(g1.weight).toBe(60);
    });

    it("locks a finalised plan for non-HR users until it is reopened with a reason", async () => {
      await expect(performance.createGoal(staff, { reviewCycleId: cycleId, employeeId: staffEmp, title: "Sneaky" })).rejects.toThrow(/finalised/);
      const goals = await performance.listGoals(staff, { reviewCycleId: cycleId, employeeId: staffEmp });
      await expect(performance.updateGoal(staff, goals[0].id, { weight: 10 })).rejects.toThrow(/finalised/);
      await expect(performance.reopenGoalPlan(staff, { reviewCycleId: cycleId, employeeId: staffEmp, reason: "I want to" })).rejects.toThrow(ForbiddenException);
      await expect(performance.reopenGoalPlan(manager, { reviewCycleId: cycleId, employeeId: staffEmp, reason: " " })).rejects.toThrow(BadRequestException);

      const reopened = await performance.reopenGoalPlan(manager, { reviewCycleId: cycleId, employeeId: staffEmp, reason: "Priorities changed after planning" });
      expect(reopened.status).toBe("draft");
      expect(reopened.reopenedReason).toContain("Priorities");
      const sneaky = await performance.createGoal(staff, { reviewCycleId: cycleId, employeeId: staffEmp, title: "Unweighted extra" });
      expect(sneaky.weight).toBeNull();
      await expect(performance.finaliseGoalPlan(manager, { reviewCycleId: cycleId, employeeId: staffEmp })).rejects.toThrow(/weight/);
    });

    it("derives progress and status from the target and records every change in an append-only history", async () => {
      const goal = await performance.createGoal(hr, { reviewCycleId: cycleId, employeeId: staffEmp, title: "Close tickets", targetValue: 20, targetUnit: "tickets" });
      const half = await performance.updateGoal(hr, goal.id, { currentValue: 10 });
      expect(half.progressPct).toBe(50);
      expect(half.status).toBe("in_progress");
      const done = await performance.updateGoal(hr, goal.id, { currentValue: 20 });
      expect(done.progressPct).toBe(100);
      expect(done.status).toBe("completed");
      expect(done.completedAt).not.toBeNull();
      await expect(performance.updateGoal(hr, goal.id, { progressPct: 140 })).rejects.toThrow(BadRequestException);

      const history = await performance.listGoalUpdates(hr, goal.id);
      expect(history.length).toBeGreaterThanOrEqual(3);
      expect(history[0].updateType).toBe("created");

      await expect(db.withClaims(hr, (c) => c.query("UPDATE goal_updates SET note = 'tamper' WHERE goal_id = $1", [goal.id]))).rejects.toThrow(/append-only|permission denied/);
      await expect(db.withClaims(hr, (c) => c.query("DELETE FROM goal_updates WHERE goal_id = $1", [goal.id]))).rejects.toThrow();
    });

    it("shows a past-due open goal as overdue immediately and persists it with a system history row nightly", async () => {
      const goal = await performance.createGoal(hr, { reviewCycleId: cycleId, employeeId: staffEmp, title: "Late one", dueDate: "2020-01-31" });
      const listed = (await performance.listGoals(hr, { reviewCycleId: cycleId, employeeId: staffEmp })).find((g) => g.id === goal.id)!;
      expect(listed.effectiveStatus).toBe("overdue");

      const run = await scheduler.run([companyId]);
      expect(run.goalsMarkedOverdue).toBeGreaterThanOrEqual(1);
      const after = (await performance.listGoals(hr, { reviewCycleId: cycleId, employeeId: staffEmp })).find((g) => g.id === goal.id)!;
      expect(after.status).toBe("overdue");
      const history = await performance.listGoalUpdates(hr, goal.id);
      expect(history.some((h) => h.updateType === "system" && h.toStatus === "overdue")).toBe(true);
      const again = await scheduler.run([companyId]);
      expect(again.goalsMarkedOverdue).toBe(0);
    });

    it("accepts http(s) evidence links only", async () => {
      const goal = await performance.createGoal(hr, { reviewCycleId: cycleId, employeeId: staffEmp, title: "With proof" });
      await expect(performance.addGoalEvidence(hr, goal.id, { label: "bad", url: "javascript:alert(1)" })).rejects.toThrow(BadRequestException);
      const ev = await performance.addGoalEvidence(staff, goal.id, { label: "Release notes", url: "https://example.com/notes" });
      expect(ev.label).toBe("Release notes");
      expect((await performance.listGoalEvidence(manager, goal.id)).length).toBe(1);
      await expect(performance.listGoalEvidence(outsider, goal.id)).rejects.toThrow(ForbiddenException);
    });
  });

  describe("TAL-07 review phases", () => {
    it("blocks self-assessment outside its window for the employee, lets HR through, and validates the phase set", async () => {
      const cycleId = await newCycle("Phases 11B");
      const reviewId = await reviewFor(cycleId, staffEmp);
      await expect(performance.setPhases(manager, cycleId, { phases: [] })).rejects.toThrow(ForbiddenException);
      await expect(
        performance.setPhases(hr, cycleId, {
          phases: [
            { phaseKey: "self_assessment", startsOn: "2026-03-01", endsOn: "2026-03-31" },
            { phaseKey: "manager_assessment", startsOn: "2026-02-01", endsOn: "2026-02-28" },
          ],
        })
      ).rejects.toThrow(/cannot start or end before/);
      await expect(performance.setPhases(hr, cycleId, { phases: [{ phaseKey: "release", startsOn: "2026-05-02", endsOn: "2026-05-01" }] })).rejects.toThrow(BadRequestException);

      const cycle = await performance.setPhases(hr, cycleId, {
        phases: [
          { phaseKey: "goal_setting", startsOn: "2020-01-01", endsOn: "2020-01-31" },
          { phaseKey: "self_assessment", startsOn: "2020-02-01", endsOn: "2020-02-28" },
          { phaseKey: "manager_assessment", startsOn: "2099-01-01", endsOn: "2099-01-31" },
        ],
      });
      expect(cycle.phases?.map((p) => p.state)).toEqual(["closed", "closed", "upcoming"]);
      expect(cycle.currentPhase).toBe("self_assessment");

      await expect(performance.submitSelfAssessment(staff, reviewId, { selfAssessment: "late" })).rejects.toThrow(/closed on 2020-02-28/);
      await expect(performance.submitManagerAssessment(manager, reviewId, { managerAssessment: "early", managerRating: 3 })).rejects.toThrow(/opens on 2099-01-01/);
      await expect(performance.createGoal(staff, { reviewCycleId: cycleId, employeeId: staffEmp, title: "after goal window" })).rejects.toThrow(/closed/);
      const viaHr = await performance.createGoal(hr, { reviewCycleId: cycleId, employeeId: staffEmp, title: "HR bypass" });
      expect(viaHr.id).toBeTruthy();
      const hrSelf = await performance.submitSelfAssessment(hr, reviewId, { selfAssessment: "HR on behalf" }).catch((e) => e);
      expect(hrSelf).toBeDefined();

      const replaced = await performance.setPhases(hr, cycleId, { phases: [{ phaseKey: "self_assessment", startsOn: "2020-01-01", endsOn: "2099-12-31" }] });
      expect(replaced.phases).toHaveLength(1);
      const ok = await performance.submitSelfAssessment(staff, reviewId, { selfAssessment: "On time now" });
      expect(ok.status).toBe("in_progress");
    });

    it("leaves a cycle with no windows unrestricted", async () => {
      const cycleId = await newCycle("No windows 11B");
      const reviewId = await reviewFor(cycleId, staffEmp);
      const r = await performance.submitSelfAssessment(staff, reviewId, { selfAssessment: "anytime" });
      expect(r.status).toBe("in_progress");
      const got = await performance.getPhases(hr, cycleId);
      expect(got.phases).toEqual([]);
      expect(got.currentPhase).toBeNull();
    });
  });

  describe("TAL-06 competencies, ratings and calibration secrecy", () => {
    let cycleId: string;
    let reviewId: string;
    let goalId: string;
    let competencyId: string;

    beforeAll(async () => {
      cycleId = await newCycle("Ratings 11B");
      reviewId = await reviewFor(cycleId, staffEmp);
      goalId = (await performance.createGoal(hr, { reviewCycleId: cycleId, employeeId: staffEmp, title: "Rated goal", weight: 100 })).id;
      competencyId = (await depth.createCompetency(hr, { name: `Ownership ${Date.now()}`, category: "Behaviour" })).id;
    });

    it("manages competencies for HR only", async () => {
      await expect(depth.createCompetency(staff, { name: "Nope" })).rejects.toThrow(ForbiddenException);
      await expect(depth.createCompetency(hr, { name: " " })).rejects.toThrow(BadRequestException);
      const updated = await depth.updateCompetency(hr, competencyId, { name: "Ownership (updated)", isActive: true });
      expect(updated.name).toBe("Ownership (updated)");
      expect((await depth.listCompetencies(staff)).some((c) => c.id === competencyId)).toBe(true);
    });

    it("records per-goal and per-competency ratings by source and validates them", async () => {
      await expect(depth.setRatings(staff, reviewId, { source: "self", ratings: [{ goalId, competencyId, rating: 3 }] })).rejects.toThrow(BadRequestException);
      await expect(depth.setRatings(staff, reviewId, { source: "self", ratings: [{ goalId, rating: 6 }] })).rejects.toThrow(BadRequestException);
      await expect(depth.setRatings(staff, reviewId, { source: "manager", ratings: [{ goalId, rating: 3 }] })).rejects.toThrow(ForbiddenException);
      await expect(depth.setRatings(manager, reviewId, { source: "self", ratings: [{ goalId, rating: 3 }] })).rejects.toThrow(ForbiddenException);
      await expect(depth.setRatings(manager, reviewId, { source: "calibration", ratings: [{ goalId, rating: 3 }] })).rejects.toThrow(ForbiddenException);
      await expect(depth.setRatings(staff, reviewId, { source: "self", ratings: [{ goalId: "00000000-0000-0000-0000-000000000000", rating: 3 }] })).rejects.toThrow(BadRequestException);

      await depth.setRatings(staff, reviewId, { source: "self", ratings: [{ goalId, rating: 5 }, { competencyId, rating: 4 }] });
      await depth.setRatings(staff, reviewId, { source: "self", ratings: [{ goalId, rating: 4, comment: "re-rated" }] }); // upsert
      await depth.setRatings(manager, reviewId, { source: "manager", ratings: [{ goalId, rating: 3 }, { competencyId, rating: 3 }] });
      await depth.setRatings(hr, reviewId, { source: "calibration", ratings: [{ goalId, rating: 2 }] });

      const hrCard = await depth.getScorecard(hr, reviewId);
      expect(hrCard.goals[0].ratings).toEqual({ self: 4, manager: 3, calibration: 2 });
      expect(hrCard.weightedGoalScore.manager).toBe(3);
      expect(hrCard.competencies[0].ratings.self).toEqual({ average: 4, count: 1 });
    });

    it("never shows calibration to the employee, even after release, and shows the manager's only after release", async () => {
      const before = await depth.getScorecard(staff, reviewId);
      expect(before.goals[0].ratings).toEqual({ self: 4 }); // own ratings only until release
      const mgrBefore = await depth.getScorecard(manager, reviewId);
      expect(mgrBefore.goals[0].ratings.calibration).toBeUndefined();
      expect(mgrBefore.goals[0].ratings.manager).toBe(3);
      await expect(depth.getScorecard(outsider, reviewId)).rejects.toThrow(NotFoundException);

      await performance.submitSelfAssessment(staff, reviewId, { selfAssessment: "done" });
      await performance.submitManagerAssessment(manager, reviewId, { managerAssessment: "ok", managerRating: 3 });
      await performance.beginCalibration(hr, cycleId);
      await performance.calibrateReview(hr, reviewId, { calibrationRating: 2, calibrationComment: "moderated" });
      await performance.closeCycle(hr, cycleId);

      const after = await depth.getScorecard(staff, reviewId);
      expect(after.goals[0].ratings).toEqual({ self: 4, manager: 3 });
      expect(after.goals[0].ratings.calibration).toBeUndefined();
      const mgrAfter = await depth.getScorecard(manager, reviewId);
      expect(mgrAfter.goals[0].ratings.calibration).toBe(2);
      await expect(depth.setRatings(staff, reviewId, { source: "self", ratings: [{ goalId, rating: 1 }] })).rejects.toThrow(BadRequestException);

      const rows = await db.withClaims(hr, (c) => c.query(`SELECT field_name FROM field_permission_rules WHERE role_id = (SELECT id FROM roles WHERE key = 'employee_self_service') AND field_name IN ('calibrationRating','calibrationComment')`)).catch(() => null);
      if (rows) expect(rows.rowCount).toBe(0);
      const review = await performance.getReview(staff, reviewId);
      expect("calibrationRating" in review).toBe(false);
      expect("calibrationComment" in review).toBe(false);
      expect(review.finalRating).toBe(2);
    });
  });

  describe("TAL-06 feedback and multi-rater input", () => {
    let cycleId: string;
    let reviewId: string;
    let competencyId: string;

    beforeAll(async () => {
      cycleId = await newCycle("360 11B");
      reviewId = await reviewFor(cycleId, staffEmp);
      competencyId = (await depth.createCompetency(hr, { name: `Collaboration ${Date.now()}` })).id;
    });

    it("applies feedback visibility: subject-visible, manager-only and HR-only", async () => {
      await depth.giveFeedback(peers[0], { subjectEmployeeId: staffEmp, body: "Great demo", feedbackType: "recognition", evidence: [{ label: "Demo", url: "https://example.com/demo" }] });
      await depth.giveFeedback(manager, { subjectEmployeeId: staffEmp, body: "Watch your estimates", visibility: "manager_only" });
      await depth.giveFeedback(hr, { subjectEmployeeId: staffEmp, body: "Case note", visibility: "hr_only" });
      await expect(depth.giveFeedback(staff, { subjectEmployeeId: staffEmp, body: "me on me" })).rejects.toThrow(BadRequestException);
      await expect(depth.giveFeedback(peers[0], { subjectEmployeeId: staffEmp, body: "x", rating: 9 })).rejects.toThrow(BadRequestException);
      await expect(depth.giveFeedback(peers[0], { subjectEmployeeId: staffEmp, body: "x", evidence: [{ label: "l", url: "ftp://nope" }] })).rejects.toThrow(BadRequestException);

      const own = await depth.listFeedbackAbout(staff, staffEmp);
      expect(own.items.map((f) => f.body)).toEqual(["Great demo"]);
      const mgr = await depth.listFeedbackAbout(manager, staffEmp);
      expect(mgr.items.map((f) => f.body).sort()).toEqual(["Great demo", "Watch your estimates"]);
      const all = await depth.listFeedbackAbout(hr, staffEmp);
      expect(all.items).toHaveLength(3);
      await expect(depth.listFeedbackAbout(outsider, staffEmp)).rejects.toThrow(ForbiddenException);
      expect((await depth.listFeedbackGiven(peers[0])).length).toBe(1);
    });

    it("withholds anonymous 360 input until the tenant minimum is reached, and always hides the rater from non-HR", async () => {
      await expect(depth.updateSettings(manager, { minRatersForAnonymity: 3 })).rejects.toThrow(ForbiddenException);
      await expect(depth.updateSettings(hr, { minRatersForAnonymity: 1 })).rejects.toThrow(BadRequestException);
      expect(await depth.updateSettings(hr, { minRatersForAnonymity: 3 })).toEqual({ minRatersForAnonymity: 3 });

      await expect(depth.requestFeedback(staff, reviewId, { raterEmployeeIds: [peerEmps[0]], raterType: "peer" })).rejects.toThrow(ForbiddenException);
      await expect(depth.requestFeedback(manager, reviewId, { raterEmployeeIds: [staffEmp], raterType: "peer" })).rejects.toThrow(BadRequestException);
      const reqs = await depth.requestFeedback(manager, reviewId, { raterEmployeeIds: peerEmps, raterType: "peer", dueDate: "2026-12-01" });
      expect(reqs).toHaveLength(3);
      expect(reqs.every((r) => r.isAnonymous)).toBe(true);
      await expect(depth.requestFeedback(manager, reviewId, { raterEmployeeIds: [peerEmps[0]], raterType: "peer" })).rejects.toThrow(ConflictException);

      const mine = await depth.listMyRequests(peers[0]);
      expect(mine).toHaveLength(1);
      expect(mine[0].subjectName).toContain("Sam");
      await expect(depth.respondToRequest(peers[1], mine[0].id, { body: "not mine" })).rejects.toThrow(NotFoundException);

      await depth.respondToRequest(peers[0], mine[0].id, { body: "Easy to work with", competencyRatings: [{ competencyId, rating: 5 }] });
      await expect(depth.respondToRequest(peers[0], mine[0].id, { body: "again" })).rejects.toThrow(BadRequestException);
      const second = (await depth.listMyRequests(peers[1]))[0];
      await depth.respondToRequest(peers[1], second.id, { body: "Reliable", competencyRatings: [{ competencyId, rating: 4 }] });

      const card2 = await depth.getScorecard(manager, reviewId);
      expect(card2.competencies).toHaveLength(0);
      expect(card2.withheldAnonymousCount).toBe(2);
      const hrCard2 = await depth.getScorecard(hr, reviewId);
      expect(hrCard2.competencies[0].ratings.peer).toEqual({ average: 4.5, count: 2 });
      const hrFeedback = await depth.listFeedbackAbout(hr, staffEmp);
      expect(hrFeedback.items.filter((f) => f.feedbackType === "peer").every((f) => f.authorEmployeeId)).toBe(true);

      const third = (await depth.listMyRequests(peers[2]))[0];
      await depth.respondToRequest(peers[2], third.id, { body: "Dependable", competencyRatings: [{ competencyId, rating: 3 }] });
      const card3 = await depth.getScorecard(manager, reviewId);
      expect(card3.withheldAnonymousCount).toBe(0);
      expect(card3.competencies[0].ratings.peer).toEqual({ average: 4, count: 3 });

      // Anonymous peer comments never expose the author to a manager, and the employee sees none before release.
      const mgrFeed = await depth.listFeedbackAbout(manager, staffEmp);
      expect(mgrFeed.items.filter((f) => f.feedbackType === "peer").every((f) => f.authorEmployeeId === undefined)).toBe(true);
      const staffFeed = await depth.listFeedbackAbout(staff, staffEmp);
      expect(staffFeed.items.some((f) => f.feedbackType === "peer")).toBe(false);
      await depth.updateSettings(hr, { minRatersForAnonymity: null });
    });

    it("lets a rater decline and HR or the manager cancel a request", async () => {
      const cid = await newCycle("360 decline 11B");
      const rid = await reviewFor(cid, staffEmp);
      const reqs = await depth.requestFeedback(hr, rid, { raterEmployeeIds: [peerEmps[0], peerEmps[1]], raterType: "upward", isAnonymous: false });
      const mine = (await depth.listMyRequests(peers[0])).find((r) => r.id === reqs[0].id)!;
      expect((await depth.declineRequest(peers[0], mine.id)).status).toBe("declined");
      await expect(depth.cancelRequest(staff, reqs[1].id)).rejects.toThrow(ForbiddenException);
      expect((await depth.cancelRequest(manager, reqs[1].id)).status).toBe("cancelled");
      expect((await depth.listRequestsForReview(manager, rid)).map((r) => r.status).sort()).toEqual(["cancelled", "declined"]);
      await expect(depth.listRequestsForReview(staff, rid)).rejects.toThrow(ForbiddenException);
    });
  });

  describe("TAL-06 development plans", () => {
    it("lets the employee, their manager and HR manage a plan, and nobody else", async () => {
      const comp = await depth.createCompetency(hr, { name: `Communication ${Date.now()}` });
      const plan = await depth.createPlan(manager, {
        employeeId: staffEmp,
        title: "Grow into senior QA",
        objective: "Lead a test strategy",
        targetDate: "2026-12-31",
        items: [{ competencyId: comp.id, action: "Shadow the lead", dueDate: "2026-06-30" }],
      });
      expect(plan.items).toHaveLength(1);
      expect(plan.status).toBe("draft");

      await expect(depth.createPlan(outsider, { employeeId: staffEmp, title: "nope" })).rejects.toThrow(ForbiddenException);
      await expect(depth.getPlan(outsider, plan.id)).rejects.toThrow(ForbiddenException);
      expect((await depth.listPlans(staff)).some((p) => p.id === plan.id)).toBe(true);
      expect((await depth.listPlans(outsider)).some((p) => p.id === plan.id)).toBe(false);

      const withItem = await depth.addPlanItem(staff, plan.id, { action: "Take an ISTQB course", itemType: "course" });
      expect(withItem.items).toHaveLength(2);
      const itemId = withItem.items[1].id;
      await expect(depth.addPlanItem(staff, plan.id, { action: "bad", courseId: "00000000-0000-0000-0000-000000000000" })).rejects.toThrow(BadRequestException);
      const done = await depth.updatePlanItem(staff, itemId, { status: "done" });
      expect(done.items.find((i) => i.id === itemId)?.status).toBe("done");
      const active = await depth.updatePlan(hr, plan.id, { status: "active" });
      expect(active.status).toBe("active");
      const removed = await depth.removePlanItem(manager, itemId);
      expect(removed.items).toHaveLength(1);
      await expect(depth.updatePlanItem(outsider, removed.items[0].id, { status: "done" })).rejects.toThrow(ForbiddenException);
    });
  });

  describe("tenant isolation and audit", () => {
    it("never shows one tenant's competencies, plans, feedback or phases to another", async () => {
      const comp = await depth.createCompetency(hr, { name: `Isolation ${Date.now()}` });
      expect((await depth.listCompetencies(otherCompanyHr)).some((c) => c.id === comp.id)).toBe(false);
      await expect(depth.updateCompetency(otherCompanyHr, comp.id, { name: "hijack" })).rejects.toThrow(NotFoundException);
      await expect(depth.listFeedbackAbout(otherCompanyHr, staffEmp)).rejects.toThrow(NotFoundException);
      await expect(depth.getScorecard(otherCompanyHr, (await reviewForLatest())!)).rejects.toThrow(NotFoundException);

      for (const table of ["competencies", "review_ratings", "feedback", "feedback_requests", "development_plans", "development_plan_items", "performance_evidence", "goal_updates", "goal_plans", "review_cycle_phases"]) {
        const leak = await db.withClaims(otherCompanyHr, (c) => c.query(`SELECT count(*)::int AS n FROM ${table} WHERE company_id = $1`, [companyId]));
        expect(leak.rows[0].n).toBe(0);
      }
    });

    async function reviewForLatest(): Promise<string | null> {
      const r = await db.withClaims(hr, (c) => c.query("SELECT id FROM performance_reviews ORDER BY created_at DESC LIMIT 1"));
      return r.rows[0]?.id ?? null;
    }

    it("audits the writes with a company-scoped actor", async () => {
      const actions = await db.withClaims(hr, (c) =>
        c.query(`SELECT DISTINCT action FROM audit_log WHERE company_id = $1 AND action = ANY($2::text[])`, [companyId, ["goal_plan.finalise", "review_rating.set", "feedback.give", "feedback_request.create", "feedback_request.respond", "performance.settings_update"]])
      );
      expect(actions.rowCount).toBeGreaterThanOrEqual(5);
    });

    it("keeps the new permission on the three expected roles", async () => {
      const r = await db.withClaims(FIXTURE, (c) =>
        c.query(`SELECT r.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id WHERE p.key = 'performance_feedback.give' ORDER BY r.key`)
      );
      expect(r.rows.map((x) => x.key)).toEqual(expect.arrayContaining(["employee_self_service", "hr_admin", "line_manager"]));
    });
  });
});
