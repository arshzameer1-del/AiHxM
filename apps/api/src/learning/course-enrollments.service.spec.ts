import { Pool } from "pg";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EmployeesService } from "../employees/employees.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { CoursesService } from "./courses.service";
import { CourseEnrollmentsService } from "./course-enrollments.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "learning-spec-fixtures" };

/**
 * Learning & Development (Part 2 category 7) — same real-Postgres,
 * no-mocks posture as every other module's spec. Unlike Leave/Expense
 * Management, there is no workflow template fixture to set up here —
 * this module deliberately doesn't route through WorkflowService
 * (course-enrollments.service.ts's own doc comment).
 */
describe("CoursesService + CourseEnrollmentsService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let rbac: RbacService;
  let entitlements: EntitlementsService;
  let audit: AuditService;
  let employees: EmployeesService;
  let courses: CoursesService;
  let enrollments: CourseEnrollmentsService;

  let companyId: string;
  let hrAdminClaims: RequestClaims;
  let managerClaims: RequestClaims;
  let staffClaims: RequestClaims;
  let outsiderClaims: RequestClaims;

  let managerEmployeeId: string;
  let staffEmployeeId: string;
  let staffUserId: string;
  let activeCourseId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    rbac = new RbacService(db);
    entitlements = new EntitlementsService(db);
    audit = new AuditService();
    employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
    courses = new CoursesService(db, rbac, entitlements, audit);
    enrollments = new CourseEnrollmentsService(db, rbac, entitlements, audit);

    const stamp = Date.now();

    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Learning Spec Co ${stamp}`,
        `learning-spec-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee", "learning"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query(
        "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true), ($1, 'learning', true)",
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

    const hrAdminUserId = await makeUser(`learning-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

    const managerUserId = await makeUser(`learning-mgr-${stamp}@example.com`);
    await assignRole(managerUserId, "line_manager");
    await assignRole(managerUserId, "employee_self_service");
    managerClaims = { is_platform_admin: false, company_id: companyId, sub: managerUserId };

    staffUserId = await makeUser(`learning-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service");
    staffClaims = { is_platform_admin: false, company_id: companyId, sub: staffUserId };

    const outsiderUserId = await makeUser(`learning-outsider-${stamp}@example.com`);
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
        managerId: managerEmployeeId,
        userAccountId: staffUserId,
      })
    ).id;

    activeCourseId = (
      await courses.create(hrAdminClaims, {
        title: "Workplace Safety 101",
        category: "compliance",
        durationMinutes: 45,
      })
    ).id;
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  describe("CoursesService", () => {
    it("lists only active courses to a non-manager caller, and lets manage.all deactivate one", async () => {
      const inactiveCandidate = await courses.create(hrAdminClaims, {
        title: "Deprecated Course",
        category: "other",
        durationMinutes: 10,
      });
      await courses.setActive(hrAdminClaims, inactiveCandidate.id, false);

      const staffView = await courses.list(staffClaims);
      expect(staffView.some((c) => c.id === inactiveCandidate.id)).toBe(false);
      expect(staffView.some((c) => c.id === activeCourseId)).toBe(true);
    });

    it("denies catalog management to a non-hr_admin", async () => {
      await expect(
        courses.create(staffClaims, { title: "Unauthorized", category: "other", durationMinutes: 5 })
      ).rejects.toThrow(ForbiddenException);
    });

    it("404s when the learning module is disabled for the tenant", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = false WHERE company_id = $1 AND module_key = 'learning'", [
          companyId,
        ])
      );
      await expect(courses.list(staffClaims)).rejects.toThrow(NotFoundException);
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = true WHERE company_id = $1 AND module_key = 'learning'", [
          companyId,
        ])
      );
    });
  });

  describe("CourseEnrollmentsService.enroll()", () => {
    it("lets an employee self-enroll, not flagged as On-Behalf", async () => {
      const enrollment = await enrollments.enroll(staffClaims, { employeeId: staffEmployeeId, courseId: activeCourseId });
      expect(enrollment.status).toBe("assigned");
      expect(enrollment.progressPercent).toBe(0);
      expect(enrollment.isOnBehalf).toBe(false);
      expect(enrollment.course.title).toBe("Workplace Safety 101");
    });

    it("refuses a duplicate enrollment in the same course", async () => {
      await expect(
        enrollments.enroll(staffClaims, { employeeId: staffEmployeeId, courseId: activeCourseId })
      ).rejects.toThrow(BadRequestException);
    });

    it("supports an HR On-Behalf assignment, correctly flagged", async () => {
      const course = await courses.create(hrAdminClaims, { title: "Code of Conduct", category: "compliance", durationMinutes: 20 });
      const enrollment = await enrollments.enroll(hrAdminClaims, { employeeId: staffEmployeeId, courseId: course.id });
      expect(enrollment.isOnBehalf).toBe(true);
    });

    it("denies a caller with neither manage.self (for someone else) nor manage.all", async () => {
      const course = await courses.create(hrAdminClaims, { title: "Outsider Target", category: "other", durationMinutes: 5 });
      await expect(enrollments.enroll(outsiderClaims, { employeeId: staffEmployeeId, courseId: course.id })).rejects.toThrow(
        ForbiddenException
      );
    });

    it("refuses enrollment in an inactive course", async () => {
      const course = await courses.create(hrAdminClaims, { title: "About To Retire", category: "other", durationMinutes: 5 });
      await courses.setActive(hrAdminClaims, course.id, false);
      await expect(enrollments.enroll(staffClaims, { employeeId: staffEmployeeId, courseId: course.id })).rejects.toThrow(
        BadRequestException
      );
    });
  });

  describe("CourseEnrollmentsService.updateProgress()", () => {
    it("moves assigned -> in_progress -> completed as progress rises, and refuses further updates once completed", async () => {
      const course = await courses.create(hrAdminClaims, { title: "Progress Course", category: "technical", durationMinutes: 60 });
      const enrollment = await enrollments.enroll(staffClaims, { employeeId: staffEmployeeId, courseId: course.id });

      const inProgress = await enrollments.updateProgress(staffClaims, enrollment.id, 40);
      expect(inProgress.status).toBe("in_progress");
      expect(inProgress.startedAt).not.toBeNull();
      expect(inProgress.completedAt).toBeNull();

      const completed = await enrollments.updateProgress(staffClaims, enrollment.id, 100);
      expect(completed.status).toBe("completed");
      expect(completed.completedAt).not.toBeNull();

      await expect(enrollments.updateProgress(staffClaims, enrollment.id, 50)).rejects.toThrow(BadRequestException);
    });

    it("denies updating someone else's progress without manage.self ownership", async () => {
      const course = await courses.create(hrAdminClaims, { title: "Not Yours", category: "technical", durationMinutes: 15 });
      const enrollment = await enrollments.enroll(staffClaims, { employeeId: staffEmployeeId, courseId: course.id });
      await expect(enrollments.updateProgress(outsiderClaims, enrollment.id, 10)).rejects.toThrow(ForbiddenException);
    });

    it("reports a course past its due date as overdue, derived at read time", async () => {
      const course = await courses.create(hrAdminClaims, { title: "Overdue Course", category: "compliance", durationMinutes: 30 });
      const enrollment = await enrollments.enroll(hrAdminClaims, {
        employeeId: staffEmployeeId,
        courseId: course.id,
        dueDate: "2020-01-01",
      });
      expect(enrollment.status).toBe("overdue");

      const fetched = await enrollments.getEnrollment(hrAdminClaims, enrollment.id);
      expect(fetched.status).toBe("overdue");
    });
  });

  describe("visibility + cancel()", () => {
    it("an outsider cannot see another employee's enrollment; a manager can see their report's", async () => {
      const course = await courses.create(hrAdminClaims, { title: "Visibility Course", category: "other", durationMinutes: 15 });
      const enrollment = await enrollments.enroll(staffClaims, { employeeId: staffEmployeeId, courseId: course.id });

      await expect(enrollments.getEnrollment(outsiderClaims, enrollment.id)).rejects.toThrow(NotFoundException);
      const managerView = await enrollments.getEnrollment(managerClaims, enrollment.id);
      expect(managerView.id).toBe(enrollment.id);
    });

    it("manage.all can cancel an enrollment; a stranger cannot", async () => {
      const course = await courses.create(hrAdminClaims, { title: "Cancel Course", category: "other", durationMinutes: 15 });
      const enrollment = await enrollments.enroll(staffClaims, { employeeId: staffEmployeeId, courseId: course.id });

      await expect(enrollments.cancel(outsiderClaims, enrollment.id)).rejects.toThrow(ForbiddenException);
      await enrollments.cancel(hrAdminClaims, enrollment.id);
      await expect(enrollments.getEnrollment(hrAdminClaims, enrollment.id)).rejects.toThrow(NotFoundException);
    });
  });
});
