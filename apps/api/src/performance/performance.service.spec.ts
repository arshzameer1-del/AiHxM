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

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "performance-spec-fixtures" };

/**
 * Phase 11's own exit criterion (plan doc Section 12): a review cycle
 * created and launched for a real employee group, a goal set and
 * cascaded, a self-assessment and a manager-assessment submitted, HR
 * Admin viewing and adjusting the cycle's rating distribution during
 * calibration, and the final rating visible only to the employee, their
 * manager, and HR Admin — proven the same way every prior phase's was:
 * real Postgres, no mocks, real employee hierarchy from Phase 7.
 */
describe("PerformanceService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let rbac: RbacService;
  let entitlements: EntitlementsService;
  let audit: AuditService;
  let employees: EmployeesService;
  let groups: EmployeeGroupsService;
  let performance: PerformanceService;

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

    const stamp = Date.now();

    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Performance Spec Co ${stamp}`,
        `performance-spec-${stamp}`,
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

    const hrAdminUserId = await makeUser(`perf-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

    managerUserId = await makeUser(`perf-mgr-${stamp}@example.com`);
    await assignRole(managerUserId, "line_manager");
    await assignRole(managerUserId, "employee_self_service");
    managerClaims = { is_platform_admin: false, company_id: companyId, sub: managerUserId };

    staffUserId = await makeUser(`perf-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service");
    staffClaims = { is_platform_admin: false, company_id: companyId, sub: staffUserId };

    const otherDeptUserId = await makeUser(`perf-other-${stamp}@example.com`);
    await assignRole(otherDeptUserId, "employee_self_service");

    const outsiderUserId = await makeUser(`perf-outsider-${stamp}@example.com`);
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

  describe("review cycle lifecycle", () => {
    it("launches with no participant group against every active employee", async () => {
      const cycle = await performance.createCycle(hrAdminClaims, {
        name: "All-Hands 2026",
        periodStart: "2026-01-01",
        periodEnd: "2026-06-30",
      });
      expect(cycle.status).toBe("draft");

      const launched = await performance.launchCycle(hrAdminClaims, cycle.id);
      expect(launched.cycle.status).toBe("active");
      expect(launched.participantCount).toBe(3); // Maya, Sam, Olivia

      const reviews = await performance.listReviews(hrAdminClaims, { reviewCycleId: cycle.id });
      expect(reviews).toHaveLength(3);
    });

    it("launches scoped to an employee group, excluding non-matching employees", async () => {
      const group = await groups.createGroup(hrAdminClaims, {
        name: "Engineering Dept (Perf)",
        conditions: [{ field: "department", equals: "Engineering" }],
      });
      const cycle = await performance.createCycle(hrAdminClaims, {
        name: "Engineering Review 2026",
        periodStart: "2026-01-01",
        periodEnd: "2026-06-30",
        participantGroupId: group.id,
      });

      const launched = await performance.launchCycle(hrAdminClaims, cycle.id);
      expect(launched.participantCount).toBe(2); // Maya + Sam, not Olivia (Sales)

      const reviews = await performance.listReviews(hrAdminClaims, { reviewCycleId: cycle.id });
      const employeeIds = reviews.map((r) => r.employeeId);
      expect(employeeIds).toContain(managerEmployeeId);
      expect(employeeIds).toContain(staffEmployeeId);
      expect(employeeIds).not.toContain(otherDeptEmployeeId);
    });

    it("refuses to launch an already-active cycle, and refuses calibration/close out of order", async () => {
      const cycle = await performance.createCycle(hrAdminClaims, {
        name: "Order Check 2026",
        periodStart: "2026-01-01",
        periodEnd: "2026-06-30",
      });
      await performance.launchCycle(hrAdminClaims, cycle.id);

      await expect(performance.launchCycle(hrAdminClaims, cycle.id)).rejects.toThrow(BadRequestException);
      await expect(performance.closeCycle(hrAdminClaims, cycle.id)).rejects.toThrow(BadRequestException);

      const calibrating = await performance.beginCalibration(hrAdminClaims, cycle.id);
      expect(calibrating.status).toBe("calibration");
      await expect(performance.beginCalibration(hrAdminClaims, cycle.id)).rejects.toThrow(BadRequestException);
    });

    it("denies cycle management to a non-hr_admin caller", async () => {
      await expect(
        performance.createCycle(managerClaims, { name: "Nope", periodStart: "2026-01-01", periodEnd: "2026-06-30" })
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("goals", () => {
    let cycleId: string;

    beforeAll(async () => {
      const cycle = await performance.createCycle(hrAdminClaims, {
        name: "Goals Cycle 2026",
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
      });
      cycleId = cycle.id;
      await performance.launchCycle(hrAdminClaims, cycleId);
    });

    it("lets an employee create their own goal (self scope)", async () => {
      const goal = await performance.createGoal(staffClaims, {
        reviewCycleId: cycleId,
        employeeId: staffEmployeeId,
        title: "Ship the Q2 release",
      });
      expect(goal.employeeId).toBe(staffEmployeeId);
      expect(goal.status).toBe("active");
    });

    it("lets a manager create a goal for a direct report (team scope), cascaded from their own parent goal", async () => {
      const parentGoal = await performance.createGoal(managerClaims, {
        reviewCycleId: cycleId,
        employeeId: managerEmployeeId,
        title: "Department: reduce defect rate 20%",
      });

      const childGoal = await performance.createGoal(managerClaims, {
        reviewCycleId: cycleId,
        employeeId: staffEmployeeId,
        parentGoalId: parentGoal.id,
        title: "Fix the top 5 recurring bugs",
        weight: 40,
      });
      expect(childGoal.parentGoalId).toBe(parentGoal.id);
      expect(childGoal.weight).toBe(40);
    });

    it("denies a manager creating a goal for someone outside their team", async () => {
      await expect(
        performance.createGoal(managerClaims, { reviewCycleId: cycleId, employeeId: otherDeptEmployeeId, title: "Nope" })
      ).rejects.toThrow(ForbiddenException);
    });

    it("denies an outsider with no employee record entirely", async () => {
      await expect(
        performance.createGoal(outsiderClaims, { reviewCycleId: cycleId, employeeId: staffEmployeeId, title: "Nope" })
      ).rejects.toThrow(ForbiddenException);
    });

    it("lets hr_admin update any goal's status", async () => {
      const goal = await performance.createGoal(hrAdminClaims, {
        reviewCycleId: cycleId,
        employeeId: staffEmployeeId,
        title: "Complete onboarding certification",
      });
      const updated = await performance.updateGoal(hrAdminClaims, goal.id, { status: "completed" });
      expect(updated.status).toBe("completed");
    });
  });

  describe("assessments, visibility, calibration, and release", () => {
    let cycleId: string;
    let reviewId: string;

    beforeAll(async () => {
      // Scoped to Sam alone (matched on the unique designation set in
      // beforeAll) so the rating distribution and close-cycle assertions
      // below aren't muddied by Maya's own, never-assessed review.
      const group = await groups.createGroup(hrAdminClaims, {
        name: "QA Analysts Only",
        conditions: [{ field: "designation", equals: "QA Analyst" }],
      });
      const cycle = await performance.createCycle(hrAdminClaims, {
        name: "Sam Solo Cycle 2026",
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        participantGroupId: group.id,
      });
      cycleId = cycle.id;
      const launched = await performance.launchCycle(hrAdminClaims, cycleId);
      expect(launched.participantCount).toBe(1);

      const reviews = await performance.listReviews(hrAdminClaims, { reviewCycleId: cycleId });
      reviewId = reviews[0].id as string;
    });

    it("denies a manager submitting a self-assessment, and an employee submitting a manager-assessment", async () => {
      await expect(performance.submitSelfAssessment(managerClaims, reviewId, { selfAssessment: "n/a" })).rejects.toThrow(
        ForbiddenException
      );
      await expect(
        performance.submitManagerAssessment(staffClaims, reviewId, { managerAssessment: "n/a", managerRating: 3 })
      ).rejects.toThrow(ForbiddenException);
    });

    it("walks the review from pending -> in_progress -> completed as each assessment lands", async () => {
      const afterSelf = await performance.submitSelfAssessment(staffClaims, reviewId, {
        selfAssessment: "Shipped the QA automation suite, closed 30 tickets.",
      });
      expect(afterSelf.status).toBe("in_progress");

      const afterManager = await performance.submitManagerAssessment(managerClaims, reviewId, {
        managerAssessment: "Strong quarter, exceeded expectations on automation coverage.",
        managerRating: 4,
      });
      expect(afterManager.status).toBe("completed");
    });

    it("hides manager/final/calibration fields from the employee until release, but shows them to the manager and hr_admin", async () => {
      const selfView = await performance.getReview(staffClaims, reviewId);
      expect(selfView.status).toBe("completed");
      expect("managerRating" in selfView).toBe(false);
      expect("managerAssessment" in selfView).toBe(false);
      expect("finalRating" in selfView).toBe(false);

      const managerView = await performance.getReview(managerClaims, reviewId);
      expect(managerView.managerRating).toBe(4);
      expect("finalRating" in managerView).toBe(false); // not released yet, even for the manager

      const hrView = await performance.getReview(hrAdminClaims, reviewId);
      expect(hrView.managerRating).toBe(4);
    });

    it("denies calibrating a review that hasn't reached completed yet", async () => {
      const otherCycle = await performance.createCycle(hrAdminClaims, {
        name: "Not Ready Cycle",
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
      });
      await performance.launchCycle(hrAdminClaims, otherCycle.id);
      const stillPending = (await performance.listReviews(hrAdminClaims, { reviewCycleId: otherCycle.id }))[0];
      await expect(performance.calibrateReview(hrAdminClaims, stillPending.id as string, { calibrationRating: 5 })).rejects.toThrow(
        BadRequestException
      );
    });

    it("shows the rating distribution HR uses to calibrate", async () => {
      const distribution = await performance.getRatingDistribution(hrAdminClaims, cycleId);
      expect(distribution.distribution).toEqual({ "4": 1 });
      expect(distribution.totalReviews).toBe(1);
      expect(distribution.pendingCalibration).toBe(1);
    });

    it("lets hr_admin adjust the rating during calibration — still hidden from the employee", async () => {
      const calibrated = await performance.calibrateReview(hrAdminClaims, reviewId, {
        calibrationRating: 5,
        calibrationComment: "Cross-team calibration bumped this up — exceptional automation impact.",
      });
      expect(calibrated.status).toBe("calibrated");
      expect(calibrated.calibrationRating).toBe(5);

      const selfView = await performance.getReview(staffClaims, reviewId);
      expect("calibrationRating" in selfView).toBe(false);
      expect("finalRating" in selfView).toBe(false);
    });

    it("releases the calibrated rating as final only once the cycle closes, then it becomes visible to the employee", async () => {
      await performance.beginCalibration(hrAdminClaims, cycleId);
      const closed = await performance.closeCycle(hrAdminClaims, cycleId);
      expect(closed.cycle.status).toBe("closed");
      expect(closed.releasedCount).toBe(1);

      const selfView = await performance.getReview(staffClaims, reviewId);
      expect(selfView.status).toBe("released");
      expect(selfView.finalRating).toBe(5); // calibration_rating overrides manager_rating
      expect(selfView.managerRating).toBe(4);
    });

    it("leaves a review that never reached completed alone when its cycle closes", async () => {
      const otherCycle = await performance.createCycle(hrAdminClaims, {
        name: "Never Completed Cycle",
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
      });
      await performance.launchCycle(hrAdminClaims, otherCycle.id);
      const untouched = (await performance.listReviews(hrAdminClaims, { reviewCycleId: otherCycle.id }))[0];

      await performance.beginCalibration(hrAdminClaims, otherCycle.id);
      const closed = await performance.closeCycle(hrAdminClaims, otherCycle.id);
      expect(closed.releasedCount).toBe(0);

      const stillPending = await performance.getReview(hrAdminClaims, untouched.id as string);
      expect(stillPending.status).toBe("pending");
      expect(stillPending.finalRating).toBeNull();
    });
  });

  it("404s the entire module for a tenant that hasn't licensed it", async () => {
    const stamp = Date.now();
    const unlicensedCompanyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `No Performance Co ${stamp}`,
        `no-performance-${stamp}`,
      ]);
      return company.rows[0].id as string;
    });
    const unlicensedClaims: RequestClaims = { is_platform_admin: false, company_id: unlicensedCompanyId, sub: "no-such-user" };
    await expect(performance.listCycles(unlicensedClaims)).rejects.toThrow(NotFoundException);
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [unlicensedCompanyId]));
  });
});
