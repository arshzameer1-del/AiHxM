import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EmployeesService } from "../employees/employees.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { WorkflowService } from "../workflow/workflow.service";
import { DataSubjectRequestsService } from "./data-subject-requests.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "dsr-fixtures" };

/**
 * Phase 2 gap-fill item #5. Real Postgres, no mocks — same discipline as
 * every other spec in this codebase. Covers: self-submission + on-behalf
 * submission, the "no user account" guard, an outsider being refused,
 * genuine TWO-STEP workflow routing (role step then a specific-user
 * "compliance officer" step) actually gating status all the way to
 * 'approved' (proving this feature really does need — and use — the
 * multi-step engine, unlike the single-decider attendance corrections
 * pattern), the reject path, fulfill()'s "must be approved first" guard,
 * and the HR queue vs. self-service "mine" list visibility split.
 */
describe("DataSubjectRequestsService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let rbac: RbacService;
  let entitlements: EntitlementsService;
  let audit: AuditService;
  let employees: EmployeesService;
  let workflow: WorkflowService;
  let dsr: DataSubjectRequestsService;

  let companyId: string;
  let hrAdminClaims: RequestClaims;
  let complianceOfficerClaims: RequestClaims;
  let staffClaims: RequestClaims;
  let outsiderClaims: RequestClaims;
  let staffEmployeeId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    rbac = new RbacService(db);
    entitlements = new EntitlementsService(db);
    audit = new AuditService();
    employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
    workflow = new WorkflowService(db, rbac, audit);
    dsr = new DataSubjectRequestsService(db, rbac, entitlements, audit, workflow);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `DSR Co ${stamp}`,
        `dsr-co-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [
        id,
      ]);
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

    const hrAdminUserId = await makeUser(`dsr-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    await assignRole(hrAdminUserId, "rbac_demo_full_access"); // workflow_template.manage.all, to create the template below
    hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

    const complianceOfficerUserId = await makeUser(`dsr-compliance-${stamp}@example.com`);
    await assignRole(complianceOfficerUserId, "employee_self_service");
    complianceOfficerClaims = { is_platform_admin: false, company_id: companyId, sub: complianceOfficerUserId };

    const staffUserId = await makeUser(`dsr-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service");
    staffClaims = { is_platform_admin: false, company_id: companyId, sub: staffUserId };

    const outsiderUserId = await makeUser(`dsr-outsider-${stamp}@example.com`);
    await assignRole(outsiderUserId, "employee_self_service");
    outsiderClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };

    const staffEmployee = await employees.create(hrAdminClaims, {
      firstName: "Sam",
      lastName: "Staff",
      userAccountId: staffUserId,
    });
    staffEmployeeId = staffEmployee.id;

    const hrRole = await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("SELECT id FROM roles WHERE key = 'hr_admin'"));

    // A real, deliberately TWO-step tenant-configured chain — the whole
    // point of routing DSR requests through the generic engine rather
    // than the plain single-decider shape attendance corrections use.
    await workflow.createTemplate(hrAdminClaims, {
      key: "data_subject_request",
      name: "Data Subject Request Review",
      objectKey: "data_subject_request",
      steps: [
        { stepOrder: 1, name: "HR reviews", approvers: [{ approverType: "role", roleId: hrRole.rows[0].id }] },
        {
          stepOrder: 2,
          name: "Compliance officer signs off",
          approvers: [{ approverType: "specific_user", userAccountId: complianceOfficerUserId }],
        },
      ],
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  it("refuses an outsider with no relationship to the employee", async () => {
    await expect(
      dsr.submit(outsiderClaims, { employeeId: staffEmployeeId, requestType: "access", description: "Not my business" })
    ).rejects.toThrow(ForbiddenException);
  });

  it("404s an employee that doesn't exist", async () => {
    await expect(
      dsr.submit(hrAdminClaims, {
        employeeId: "00000000-0000-0000-0000-000000000000",
        requestType: "access",
        description: "n/a",
      })
    ).rejects.toThrow(NotFoundException);
  });

  it("rejects submitting for an employee with no user account", async () => {
    const noLoginEmployee = await employees.create(hrAdminClaims, { firstName: "Nolan", lastName: "NoLogin" });
    await expect(
      dsr.submit(hrAdminClaims, { employeeId: noLoginEmployee.id, requestType: "deletion", description: "n/a" })
    ).rejects.toThrow(BadRequestException);
  });

  describe("self-submission through to a two-step approval", () => {
    let requestId: string;

    it("lets the employee submit a request about their own data", async () => {
      const created = await dsr.submit(staffClaims, {
        employeeId: staffEmployeeId,
        requestType: "access",
        description: "Please send me a copy of everything you hold on me.",
      });
      expect(created.status).toBe("pending");
      expect(created.isOnBehalf).toBe(false);
      expect(created.workflowInstanceId).not.toBeNull();
      requestId = created.id;
    });

    it("is visible to the employee themselves and to HR, but not to an outsider", async () => {
      await expect(dsr.getRequest(staffClaims, requestId)).resolves.toMatchObject({ id: requestId });
      await expect(dsr.getRequest(hrAdminClaims, requestId)).resolves.toMatchObject({ id: requestId });
      await expect(dsr.getRequest(outsiderClaims, requestId)).rejects.toThrow(NotFoundException);
    });

    it("cannot be fulfilled before it's even decided", async () => {
      await expect(dsr.fulfill(hrAdminClaims, requestId, { fulfillmentNote: "too early" })).rejects.toThrow(
        ConflictException
      );
    });

    it("stays pending after HR's step-1 approval — a second step remains", async () => {
      const decided = await dsr.decide(hrAdminClaims, requestId, { decision: "approved", comment: "Looks legitimate" });
      expect(decided.status).toBe("pending");
    });

    it("refuses a decide() from someone who isn't the resolved approver on the current step", async () => {
      await expect(dsr.decide(staffClaims, requestId, { decision: "approved" })).rejects.toThrow(ForbiddenException);
    });

    it("becomes 'approved' once the compliance officer signs off on step 2", async () => {
      const decided = await dsr.decide(complianceOfficerClaims, requestId, { decision: "approved" });
      expect(decided.status).toBe("approved");
    });

    it("refuses to decide an already-decided request", async () => {
      await expect(dsr.decide(hrAdminClaims, requestId, { decision: "approved" })).rejects.toThrow(ConflictException);
    });

    it("lets HR fulfill it, recording who and what was done", async () => {
      const fulfilled = await dsr.fulfill(hrAdminClaims, requestId, {
        fulfillmentNote: "Exported the employee's full HR file and emailed it securely on 2026-09-25.",
      });
      expect(fulfilled.status).toBe("fulfilled");
      expect(fulfilled.fulfilledByUserAccountId).toBe(hrAdminClaims.sub);
      expect(fulfilled.fulfilledAt).not.toBeNull();
      expect(fulfilled.fulfillmentNote).toContain("Exported");
    });

    it("refuses to fulfill an already-fulfilled request", async () => {
      await expect(dsr.fulfill(hrAdminClaims, requestId, { fulfillmentNote: "again" })).rejects.toThrow(
        ConflictException
      );
    });
  });

  describe("rejection path", () => {
    let requestId: string;

    it("HR submits on-behalf, and HR rejecting step 1 rejects the whole request", async () => {
      const created = await dsr.submit(hrAdminClaims, {
        employeeId: staffEmployeeId,
        requestType: "deletion",
        description: "Employee verbally asked HR to raise this on their behalf.",
      });
      expect(created.isOnBehalf).toBe(true);
      requestId = created.id;

      const decided = await dsr.decide(hrAdminClaims, requestId, { decision: "rejected", comment: "Retention period still applies" });
      expect(decided.status).toBe("rejected");
      expect(decided.decisionComment).toBe("Retention period still applies");
    });

    it("refuses to fulfill a rejected request", async () => {
      await expect(dsr.fulfill(hrAdminClaims, requestId, { fulfillmentNote: "n/a" })).rejects.toThrow(ConflictException);
    });
  });

  describe("queue visibility", () => {
    it("refuses a plain employee from viewing the HR queue", async () => {
      await expect(dsr.listQueue(staffClaims)).rejects.toThrow(ForbiddenException);
    });

    it("lets HR see the whole company's queue, optionally filtered by status", async () => {
      const all = await dsr.listQueue(hrAdminClaims);
      expect(all.length).toBeGreaterThanOrEqual(2);

      const rejected = await dsr.listQueue(hrAdminClaims, { status: "rejected" });
      expect(rejected.every((r) => r.status === "rejected")).toBe(true);
      expect(rejected.length).toBeGreaterThanOrEqual(1);
    });

    it("shows the employee only their own requests via listMine, never an outsider's", async () => {
      const mine = await dsr.listMine(staffClaims);
      expect(mine.length).toBeGreaterThanOrEqual(2);
      expect(mine.every((r) => r.employeeId === staffEmployeeId)).toBe(true);

      const outsiderMine = await dsr.listMine(outsiderClaims);
      expect(outsiderMine).toHaveLength(0);
    });
  });
});
