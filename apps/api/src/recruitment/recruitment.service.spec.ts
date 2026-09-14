import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { WorkflowService } from "../workflow/workflow.service";
import { EmployeesService } from "../employees/employees.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { RecruitmentService } from "./recruitment.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "recruitment-spec-fixtures" };

/**
 * Phase 10's own exit criterion (plan doc Section 7), proven the same
 * way every prior phase's was: real Postgres, no mocks. A requisition
 * routes through a real tenant-configured approval chain reusing the
 * Phase 6 workflow engine as-is (no new approver type, unlike Phase 9),
 * a candidate moves through a real forward-only Kanban pipeline, and
 * accepting an offer creates a real Employee record via
 * `EmployeesService.create()` — the second real caller of Employee
 * Number assignment, after direct HR-Admin creation and bulk import.
 */
describe("RecruitmentService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let workflow: WorkflowService;
  let employees: EmployeesService;
  let recruitment: RecruitmentService;

  let companyId: string;
  let hrAdminClaims: RequestClaims;
  let approverClaims: RequestClaims;
  let outsiderClaims: RequestClaims;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    workflow = new WorkflowService(db, rbac, audit);
    employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
    recruitment = new RecruitmentService(db, rbac, entitlements, audit, workflow, employees);

    const stamp = Date.now();
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Recruitment Spec Co ${stamp}`,
        `recruitment-spec-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee", "recruitment"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query(
        "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true), ($1, 'recruitment', true)",
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
    async function assignRole(userAccountId: string, roleKey: string): Promise<string> {
      return db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
        await client.query(
          "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
          [userAccountId, companyId, role.rows[0].id]
        );
        return role.rows[0].id as string;
      });
    }

    const hrAdminUserId = await makeUser(`recruitment-hr-${stamp}@example.com`);
    const hrAdminRoleId = await assignRole(hrAdminUserId, "hr_admin");
    // Also holds rbac_demo_full_access purely to configure the
    // requisition-approval workflow template below — same fixture
    // shortcut leave-requests.service.spec.ts already uses.
    await assignRole(hrAdminUserId, "rbac_demo_full_access");
    hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

    // A SECOND real hr_admin — approves requisitions the first one
    // raises. The engine itself doesn't forbid a role-approver from
    // being the same user who submitted (no ownership check for `role`
    // approvers), but using two distinct people here is the realistic
    // case and lets the "self-decide" question stay open rather than
    // silently relying on the engine's permissiveness.
    const approverUserId = await makeUser(`recruitment-approver-${stamp}@example.com`);
    await assignRole(approverUserId, "hr_admin");
    approverClaims = { is_platform_admin: false, company_id: companyId, sub: approverUserId };

    const outsiderUserId = await makeUser(`recruitment-outsider-${stamp}@example.com`);
    outsiderClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };

    await workflow.createTemplate(hrAdminClaims, {
      key: "job_requisition",
      name: "Requisition Approval",
      objectKey: "job_requisition",
      steps: [{ stepOrder: 1, name: "HR Admin approves", approvers: [{ approverType: "role", roleId: hrAdminRoleId }] }],
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  describe("requisitions", () => {
    it("creates a draft, submits it for approval, and an approval flips it to approved", async () => {
      const requisition = await recruitment.createRequisition(hrAdminClaims, {
        title: "Senior Backend Engineer",
        department: "Engineering",
        headcount: 2,
        salaryBand: "E4",
      });
      expect(requisition.status).toBe("draft");

      const submitted = await recruitment.submitRequisition(hrAdminClaims, requisition.id);
      expect(submitted.status).toBe("pending_approval");
      expect(submitted.workflowInstanceId).not.toBeNull();

      const decided = await recruitment.decideRequisition(approverClaims, requisition.id, { decision: "approved" });
      expect(decided.status).toBe("approved");
    });

    it("a rejection flips it to rejected", async () => {
      const requisition = await recruitment.createRequisition(hrAdminClaims, { title: "Should Be Rejected" });
      await recruitment.submitRequisition(hrAdminClaims, requisition.id);
      const decided = await recruitment.decideRequisition(approverClaims, requisition.id, { decision: "rejected" });
      expect(decided.status).toBe("rejected");
    });

    it("denies an outsider with no recruitment.manage.all", async () => {
      await expect(recruitment.createRequisition(outsiderClaims, { title: "Nope" })).rejects.toThrow(ForbiddenException);
    });

    it("404s when the recruitment module is disabled for the tenant", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = false WHERE company_id = $1 AND module_key = 'recruitment'", [
          companyId,
        ])
      );
      await expect(recruitment.createRequisition(hrAdminClaims, { title: "Nope" })).rejects.toThrow(NotFoundException);
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = true WHERE company_id = $1 AND module_key = 'recruitment'", [
          companyId,
        ])
      );
    });
  });

  describe("the full pipeline: requisition -> candidate -> Kanban -> offer -> hire", () => {
    let requisitionId: string;
    let candidateId: string;
    let applicationId: string;

    beforeAll(async () => {
      const requisition = await recruitment.createRequisition(hrAdminClaims, {
        title: "Product Designer",
        department: "Design",
        salaryBand: "D3",
      });
      requisitionId = requisition.id;
      await recruitment.submitRequisition(hrAdminClaims, requisitionId);
      await recruitment.decideRequisition(approverClaims, requisitionId, { decision: "approved" });

      const candidate = await recruitment.createCandidate(hrAdminClaims, {
        firstName: "Zara",
        lastName: "Candidate",
        email: `zara-${Date.now()}@example.com`,
      });
      candidateId = candidate.id;
    });

    it("refuses an application against a requisition that isn't approved yet", async () => {
      const draftRequisition = await recruitment.createRequisition(hrAdminClaims, { title: "Still Draft" });
      const anotherCandidate = await recruitment.createCandidate(hrAdminClaims, { firstName: "No", lastName: "Go" });
      await expect(
        recruitment.createApplication(hrAdminClaims, { requisitionId: draftRequisition.id, candidateId: anotherCandidate.id })
      ).rejects.toThrow(BadRequestException);
    });

    it("creates the application at 'applied' and refuses a duplicate", async () => {
      const application = await recruitment.createApplication(hrAdminClaims, { requisitionId, candidateId });
      applicationId = application.id;
      expect(application.stage).toBe("applied");

      await expect(recruitment.createApplication(hrAdminClaims, { requisitionId, candidateId })).rejects.toThrow(
        ConflictException
      );
    });

    it("moves forward through the Kanban board but refuses a backward move and a direct jump to 'hired'", async () => {
      const screening = await recruitment.moveApplicationStage(hrAdminClaims, applicationId, "screening");
      expect(screening.stage).toBe("screening");

      await expect(recruitment.moveApplicationStage(hrAdminClaims, applicationId, "applied")).rejects.toThrow(
        BadRequestException
      );
      await expect(recruitment.moveApplicationStage(hrAdminClaims, applicationId, "hired")).rejects.toThrow(
        BadRequestException
      );

      const interview = await recruitment.moveApplicationStage(hrAdminClaims, applicationId, "interview");
      expect(interview.stage).toBe("interview");
    });

    it("extending an offer moves the application to 'offer', and a second pending offer is refused", async () => {
      const offer = await recruitment.extendOffer(hrAdminClaims, {
        applicationId,
        salary: 250000,
        startDate: "2026-11-01",
      });
      expect(offer.status).toBe("pending");

      const application = (await recruitment.listApplications(hrAdminClaims, requisitionId)).find(
        (a) => a.id === applicationId
      )!;
      expect(application.stage).toBe("offer");

      await expect(
        recruitment.extendOffer(hrAdminClaims, { applicationId, salary: 260000, startDate: "2026-11-01" })
      ).rejects.toThrow(ConflictException);

      await recruitment.rescindOffer(hrAdminClaims, offer.id);
      // Rescinding clears the way for a fresh offer.
      const secondOffer = await recruitment.extendOffer(hrAdminClaims, {
        applicationId,
        salary: 255000,
        startDate: "2026-11-15",
      });
      expect(secondOffer.status).toBe("pending");

      // Accept this one — proven in the next test.
      const decided = await recruitment.decideOffer(hrAdminClaims, secondOffer.id, "accepted");
      expect(decided.offer.status).toBe("accepted");
      expect(decided.employee).not.toBeNull();
      expect(decided.employee!.firstName).toBe("Zara");
      expect(decided.employee!.employeeNumber).toMatch(/^EMP-/);
      expect(decided.employee!.department).toBe("Design");
      expect(decided.employee!.designation).toBe("Product Designer");

      const hiredApplication = (await recruitment.listApplications(hrAdminClaims, requisitionId)).find(
        (a) => a.id === applicationId
      )!;
      expect(hiredApplication.stage).toBe("hired");

      const fetchedEmployee = await employees.get(hrAdminClaims, decided.employee!.id);
      expect(fetchedEmployee.dateOfJoining).toBe("2026-11-15");
    });

    it("a declined offer leaves the application at 'offer' so a new offer can go to someone else", async () => {
      const secondCandidate = await recruitment.createCandidate(hrAdminClaims, { firstName: "Bilal", lastName: "Backup" });
      const secondApplication = await recruitment.createApplication(hrAdminClaims, {
        requisitionId,
        candidateId: secondCandidate.id,
      });
      const offer = await recruitment.extendOffer(hrAdminClaims, {
        applicationId: secondApplication.id,
        salary: 240000,
        startDate: "2026-12-01",
      });
      const decided = await recruitment.decideOffer(hrAdminClaims, offer.id, "declined");
      expect(decided.offer.status).toBe("declined");
      expect(decided.employee).toBeNull();

      const application = (await recruitment.listApplications(hrAdminClaims, requisitionId)).find(
        (a) => a.id === secondApplication.id
      )!;
      expect(application.stage).toBe("offer"); // unchanged — still open to a fresh offer
    });
  });
});
