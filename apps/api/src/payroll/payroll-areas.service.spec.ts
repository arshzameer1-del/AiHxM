import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { ImportExportService } from "../import-export/import-export.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { WorkflowService } from "../workflow/workflow.service";
import { PayrollService } from "./payroll.service";
import { PayrollAreasService } from "./payroll-areas.service";
import { EmployeeCompensationService } from "../employees/employee-compensation.service";
import { RulesEngine } from "../rules-engine/rules-engine.engine";
import { HolidaysService } from "../holidays/holidays.service";
import { ShiftsService } from "../shifts/shifts.service";
import { WorkScheduleResolutionService } from "../shifts/work-schedule-resolution.service";
import { EmployeeGroupsService } from "../employee-groups/employee-groups.service";
import { LeaveRequestsService } from "../leave/leave-requests.service";
import { OvertimeService } from "../leave/overtime.service";
import { EmployeeLoansService } from "../employees/employee-loans.service";
import { EmployeeAdditionalPaymentsService } from "../employees/employee-additional-payments.service";
import { EmployeeOffCyclePaymentsService } from "../employees/employee-offcycle-payments.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "payroll-areas-spec-fixtures" };

/**
 * Payroll Areas (0101_payroll_areas.sql / 0102 seed) — real Postgres, real
 * collaborators, no mocks, same rule as payroll.service.spec.ts. Its own
 * isolated company so nothing here disturbs that file's company-wide
 * runs/period assumptions.
 *
 * Fixture shape:
 *   org units:  South Region -> Karachi Branch (child), North Region
 *   areas:      KHI  (linked to org unit Karachi Branch)  — inside South's subtree
 *               LHE  (linked to org unit North Region)    — outside South
 *               ISB  (linked to cost center "Islamabad CC") — cost-center dimension
 *   regional_payroll user  -> data scope org_unit = South Region  (reaches KHI only)
 *   regional_payroll user2 -> data scope cost_center = Islamabad CC (reaches ISB only)
 */
describe("Payroll Areas + payroll Data Scope", () => {
  let pool: Pool;
  let db: DatabaseService;
  let rbac: RbacService;
  let payroll: PayrollService;
  let areas: PayrollAreasService;
  let compensation: EmployeeCompensationService;
  let workflow: WorkflowService;

  let companyId: string;
  let hrAdminClaims: RequestClaims;
  let approverClaims: RequestClaims;
  let regionalClaims: RequestClaims;
  let regionalCcClaims: RequestClaims;
  let outsiderClaims: RequestClaims;

  let southId: string;
  let karachiId: string;
  let northId: string;
  let islamabadCcId: string;

  let khiAreaId: string;
  let lheAreaId: string;
  let isbAreaId: string;

  let khiEmployeeId: string;
  let lheEmployeeId: string;
  let unassignedEmployeeId: string;

  let counter = 0;

  async function makeUser(email: string): Promise<string> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]);
      return result.rows[0].id as string;
    });
  }

  async function assignRole(userAccountId: string, roleKey: string): Promise<void> {
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [
        userAccountId,
        companyId,
        role.rows[0].id,
      ]);
    });
  }

  async function assignDataScope(userAccountId: string, scopeType: string, scopeEntityId: string): Promise<void> {
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query(
        "INSERT INTO data_scope_assignments (user_account_id, company_id, scope_type, scope_entity_id) VALUES ($1, $2, $3, $4)",
        [userAccountId, companyId, scopeType, scopeEntityId]
      )
    );
  }

  async function insertOrgUnit(name: string, parentId: string | null): Promise<string> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        "INSERT INTO org_units (company_id, parent_id, unit_type, name) VALUES ($1, $2, 'division', $3) RETURNING id",
        [companyId, parentId, name]
      );
      return result.rows[0].id as string;
    });
  }

  async function createEmployee(): Promise<string> {
    counter += 1;
    const id = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        `INSERT INTO employees (company_id, employee_number, first_name, last_name, date_of_joining, bank_account_number)
         VALUES ($1, $2, 'Area', 'Employee', '2020-01-01', $3) RETURNING id`,
        [companyId, `PA-${counter}`, `PK-PA-${counter}`]
      );
      return result.rows[0].id as string;
    });
    await compensation.setCompensation(hrAdminClaims, { employeeId: id, monthlySalary: 100000, effectiveFrom: "2020-01-01" });
    return id;
  }

  async function payslipEmployeeIds(runId: string): Promise<string[]> {
    const payslips = await payroll.listPayslips(hrAdminClaims, { payrollRunId: runId });
    return payslips.map((p) => p.employeeId).sort();
  }

  /** create -> calculate -> submit (as `preparer`) -> approve (approver). */
  async function approvedRun(preparer: RequestClaims, periodStart: string, periodEnd: string, payrollAreaId: string | null) {
    const run = await payroll.createRun(preparer, { periodStart, periodEnd, payrollAreaId });
    await payroll.calculateRun(preparer, run.id);
    await payroll.submitForApproval(preparer, run.id);
    await payroll.decideApproval(approverClaims, run.id, { decision: "approved" });
    return run.id;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    workflow = new WorkflowService(db, rbac, audit);
    const shifts = new ShiftsService(db, rbac, entitlements, audit, new EffectiveDatingEngine(), new RulesEngine());
    const workSchedule = new WorkScheduleResolutionService(db, shifts, new HolidaysService(db, rbac, entitlements, audit));
    const employeeGroups = new EmployeeGroupsService(db, rbac, entitlements, new EffectiveDatingEngine(), new RulesEngine());
    const leaveRequests = new LeaveRequestsService(db, rbac, entitlements, audit, employeeGroups, workflow, workSchedule);
    const overtime = new OvertimeService(db, rbac, entitlements, audit, new EffectiveDatingEngine(), workSchedule);
    // Payroll Enterprise Gap Analysis Phase P3 (2026-10-02) — required
    // collaborator, same as leaveRequests/overtime/workSchedule above.
    const loans = new EmployeeLoansService(db, rbac, entitlements, audit);
    const additionalPayments = new EmployeeAdditionalPaymentsService(db, rbac, entitlements, audit);
    // Payroll Enterprise Gap Analysis Phase P4 (2026-10-02) — required
    // collaborator, same as loans/additionalPayments above.
    const offCyclePayments = new EmployeeOffCyclePaymentsService(db, rbac, entitlements, audit);
    payroll = new PayrollService(
      db,
      rbac,
      entitlements,
      audit,
      new ImportExportService(),
      new EffectiveDatingEngine(),
      workflow,
      leaveRequests,
      overtime,
      workSchedule,
      undefined,
      undefined,
      loans,
      additionalPayments,
      offCyclePayments
    );
    areas = new PayrollAreasService(db, rbac, entitlements, audit);
    compensation = new EmployeeCompensationService(db, rbac, entitlements, audit, new EffectiveDatingEngine());

    const stamp = Date.now();
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Payroll Areas Spec Co ${stamp}`,
        `payroll-areas-spec-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true), ($1, 'payroll', true)",
        [id]
      );
      return id;
    });

    const hrAdminUserId = await makeUser(`pa-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    await assignRole(hrAdminUserId, "rbac_demo_full_access"); // workflow template setup only
    hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

    const approverUserId = await makeUser(`pa-approver-${stamp}@example.com`);
    await assignRole(approverUserId, "payroll_approver");
    approverClaims = { is_platform_admin: false, company_id: companyId, sub: approverUserId };

    const regionalUserId = await makeUser(`pa-regional-${stamp}@example.com`);
    await assignRole(regionalUserId, "regional_payroll");
    regionalClaims = { is_platform_admin: false, company_id: companyId, sub: regionalUserId };

    const regionalCcUserId = await makeUser(`pa-regional-cc-${stamp}@example.com`);
    await assignRole(regionalCcUserId, "regional_payroll");
    regionalCcClaims = { is_platform_admin: false, company_id: companyId, sub: regionalCcUserId };

    const outsiderUserId = await makeUser(`pa-outsider-${stamp}@example.com`);
    await assignRole(outsiderUserId, "employee_self_service");
    outsiderClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };

    const approverRole = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("SELECT id FROM roles WHERE key = 'payroll_approver'")
    );
    await workflow.createTemplate(hrAdminClaims, {
      key: "payroll_run",
      name: "Payroll Run Approval",
      objectKey: "payroll_run",
      steps: [{ stepOrder: 1, name: "Payroll Approver reviews", approvers: [{ approverType: "role", roleId: approverRole.rows[0].id }] }],
    });

    southId = await insertOrgUnit("South Region", null);
    karachiId = await insertOrgUnit("Karachi Branch", southId);
    northId = await insertOrgUnit("North Region", null);
    islamabadCcId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO cost_centers (company_id, name) VALUES ($1, 'Islamabad CC') RETURNING id", [companyId]);
      return result.rows[0].id as string;
    });

    await assignDataScope(regionalUserId, "org_unit", southId);
    await assignDataScope(regionalCcUserId, "cost_center", islamabadCcId);

    khiEmployeeId = await createEmployee();
    lheEmployeeId = await createEmployee();
    unassignedEmployeeId = await createEmployee();
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  describe("PayrollAreasService CRUD", () => {
    it("hr_admin (payroll_area.manage.all) creates payroll areas and links them to org units / cost centers", async () => {
      const khi = await areas.create(hrAdminClaims, { code: "KHI-M", name: "Karachi Monthly", description: "Karachi staff, monthly" });
      expect(khi.code).toBe("KHI-M");
      expect(khi.isActive).toBe(true);
      expect(khi.employeeCount).toBe(0);
      expect(khi.scopeLinks).toEqual([]);
      khiAreaId = khi.id;

      const linked = await areas.addScopeLink(hrAdminClaims, khiAreaId, { scopeType: "org_unit", scopeEntityId: karachiId });
      expect(linked.scopeLinks).toHaveLength(1);
      expect(linked.scopeLinks[0]).toMatchObject({ scopeType: "org_unit", scopeEntityId: karachiId });

      lheAreaId = (await areas.create(hrAdminClaims, { code: "LHE-W", name: "Lahore Weekly" })).id;
      await areas.addScopeLink(hrAdminClaims, lheAreaId, { scopeType: "org_unit", scopeEntityId: northId });

      isbAreaId = (await areas.create(hrAdminClaims, { code: "ISB-M", name: "Islamabad Monthly" })).id;
      await areas.addScopeLink(hrAdminClaims, isbAreaId, { scopeType: "cost_center", scopeEntityId: islamabadCcId });

      const listed = await areas.list(hrAdminClaims);
      expect(listed.map((a) => a.code)).toEqual(["ISB-M", "KHI-M", "LHE-W"]);
    });

    it("rejects a duplicate code, a duplicate scope link, and a link to an entity that doesn't exist", async () => {
      await expect(areas.create(hrAdminClaims, { code: "KHI-M", name: "Dup" })).rejects.toThrow(ConflictException);
      await expect(
        areas.addScopeLink(hrAdminClaims, khiAreaId, { scopeType: "org_unit", scopeEntityId: karachiId })
      ).rejects.toThrow(ConflictException);
      await expect(
        areas.addScopeLink(hrAdminClaims, khiAreaId, { scopeType: "location", scopeEntityId: karachiId })
      ).rejects.toThrow(NotFoundException);
    });

    it("update() renames; a caller with no payroll permission at all is forbidden", async () => {
      const updated = await areas.update(hrAdminClaims, lheAreaId, { name: "Lahore Weekly Staff" });
      expect(updated.name).toBe("Lahore Weekly Staff");
      await expect(areas.list(outsiderClaims)).rejects.toThrow(ForbiddenException);
      await expect(areas.create(outsiderClaims, { code: "X", name: "X" })).rejects.toThrow(ForbiddenException);
    });

    it("a payroll_area.manage.scoped caller sees only the areas their data scope reaches (org unit subtree / flat cost center)", async () => {
      // South Region assignment expands to Karachi Branch -> reaches KHI only.
      expect((await areas.list(regionalClaims)).map((a) => a.id)).toEqual([khiAreaId]);
      // Cost-center assignment reaches only the area linked to that cost center.
      expect((await areas.list(regionalCcClaims)).map((a) => a.id)).toEqual([isbAreaId]);
      await expect(areas.get(regionalClaims, lheAreaId)).rejects.toThrow(NotFoundException);
      expect((await areas.get(regionalClaims, khiAreaId)).code).toBe("KHI-M");
    });

    it("a scoped caller cannot create areas, edit scope links (which define their own reach), or update an out-of-scope area", async () => {
      await expect(areas.create(regionalClaims, { code: "NEW", name: "New" })).rejects.toThrow(ForbiddenException);
      await expect(
        areas.addScopeLink(regionalClaims, lheAreaId, { scopeType: "org_unit", scopeEntityId: karachiId })
      ).rejects.toThrow(ForbiddenException);
      await expect(areas.update(regionalClaims, lheAreaId, { name: "Hijacked" })).rejects.toThrow(ForbiddenException);
      const own = await areas.update(regionalClaims, khiAreaId, { description: "Edited by regional payroll" });
      expect(own.description).toBe("Edited by regional payroll");
    });
  });

  describe("assignEmployee()", () => {
    it("hr_admin assigns employees to payroll areas; employeeCount reflects it", async () => {
      await areas.assignEmployee(hrAdminClaims, { employeeId: khiEmployeeId, payrollAreaId: khiAreaId });
      await areas.assignEmployee(hrAdminClaims, { employeeId: lheEmployeeId, payrollAreaId: lheAreaId });
      expect((await areas.get(hrAdminClaims, khiAreaId)).employeeCount).toBe(1);
      expect((await areas.get(hrAdminClaims, lheAreaId)).employeeCount).toBe(1);
      const stored = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("SELECT payroll_area_id FROM employees WHERE id = $1", [khiEmployeeId])
      );
      expect(stored.rows[0].payroll_area_id).toBe(khiAreaId);
    });

    it("a scoped caller can't pull an employee out of an out-of-scope area, or place a company-wide (unassigned) one", async () => {
      await expect(
        areas.assignEmployee(regionalClaims, { employeeId: lheEmployeeId, payrollAreaId: khiAreaId })
      ).rejects.toThrow(ForbiddenException);
      await expect(
        areas.assignEmployee(regionalClaims, { employeeId: unassignedEmployeeId, payrollAreaId: khiAreaId })
      ).rejects.toThrow(ForbiddenException);
      await expect(
        areas.assignEmployee(regionalClaims, { employeeId: khiEmployeeId, payrollAreaId: lheAreaId })
      ).rejects.toThrow(ForbiddenException);
    });

    it("refuses an inactive target area and an unknown employee", async () => {
      const temp = await areas.create(hrAdminClaims, { code: "TEMP", name: "Temporary" });
      await areas.deactivate(hrAdminClaims, temp.id);
      await expect(
        areas.assignEmployee(hrAdminClaims, { employeeId: unassignedEmployeeId, payrollAreaId: temp.id })
      ).rejects.toThrow(BadRequestException);
      await expect(
        areas.assignEmployee(hrAdminClaims, { employeeId: "00000000-0000-0000-0000-000000000000", payrollAreaId: khiAreaId })
      ).rejects.toThrow(NotFoundException);
      // Deactivated areas drop out of the default list, but stay readable.
      expect((await areas.list(hrAdminClaims)).map((a) => a.id)).not.toContain(temp.id);
      expect((await areas.list(hrAdminClaims, { includeInactive: true })).map((a) => a.id)).toContain(temp.id);
      await expect(
        payroll.createRun(hrAdminClaims, { periodStart: "2025-12-01", periodEnd: "2025-12-31", payrollAreaId: temp.id })
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("payroll runs narrowed by payroll area", () => {
    it("calculateRun() on an area run includes only that area's employees; a company-wide run includes everyone", async () => {
      const khiRun = await payroll.createRun(hrAdminClaims, { periodStart: "2026-01-01", periodEnd: "2026-01-31", payrollAreaId: khiAreaId });
      expect(khiRun.payrollAreaId).toBe(khiAreaId);
      const calculated = await payroll.calculateRun(hrAdminClaims, khiRun.id);
      expect(calculated.errors).toEqual([]);
      expect(await payslipEmployeeIds(khiRun.id)).toEqual([khiEmployeeId]);

      const companyWide = await payroll.createRun(hrAdminClaims, { periodStart: "2026-02-01", periodEnd: "2026-02-28" });
      expect(companyWide.payrollAreaId).toBeNull();
      await payroll.calculateRun(hrAdminClaims, companyWide.id);
      expect(await payslipEmployeeIds(companyWide.id)).toEqual([khiEmployeeId, lheEmployeeId, unassignedEmployeeId].sort());
    });

    it("never mixes a company-wide run with area runs for the same period, but allows one run per area", async () => {
      // 2026-01: a KHI run already exists.
      await expect(payroll.createRun(hrAdminClaims, { periodStart: "2026-01-01", periodEnd: "2026-01-31" })).rejects.toThrow(
        BadRequestException
      );
      await expect(
        payroll.createRun(hrAdminClaims, { periodStart: "2026-01-01", periodEnd: "2026-01-31", payrollAreaId: khiAreaId })
      ).rejects.toThrow(BadRequestException);
      // 2026-02: a company-wide run already exists.
      await expect(
        payroll.createRun(hrAdminClaims, { periodStart: "2026-02-01", periodEnd: "2026-02-28", payrollAreaId: lheAreaId })
      ).rejects.toThrow(BadRequestException);
      const lheJan = await payroll.createRun(hrAdminClaims, { periodStart: "2026-01-01", periodEnd: "2026-01-31", payrollAreaId: lheAreaId });
      expect(lheJan.payrollAreaId).toBe(lheAreaId);
    });

    it("a scoped caller can create/calculate/submit/finalize/disburse runs of in-scope areas", async () => {
      const runId = await approvedRun(regionalClaims, "2026-03-01", "2026-03-31", khiAreaId);
      const finalized = await payroll.finalizeRun(regionalClaims, runId);
      expect(finalized.status).toBe("finalized");
      const csv = await payroll.generateDisbursementFile(regionalClaims, runId);
      expect(csv).toContain("PK-PA-1");
      expect(csv).not.toContain("PK-PA-2");
    });

    it("a scoped caller is blocked from every sensitive action on a run outside their payroll-area data scope", async () => {
      // Out-of-scope area: hr_admin prepares it all the way to approved.
      const lheRunId = await approvedRun(hrAdminClaims, "2026-03-01", "2026-03-31", lheAreaId);

      await expect(
        payroll.createRun(regionalClaims, { periodStart: "2026-04-01", periodEnd: "2026-04-30", payrollAreaId: lheAreaId })
      ).rejects.toThrow(ForbiddenException);
      await expect(payroll.calculateRun(regionalClaims, lheRunId)).rejects.toThrow(ForbiddenException);
      await expect(payroll.finalizeRun(regionalClaims, lheRunId)).rejects.toThrow(ForbiddenException);

      await payroll.finalizeRun(hrAdminClaims, lheRunId);
      await expect(payroll.generateDisbursementFile(regionalClaims, lheRunId)).rejects.toThrow(ForbiddenException);

      // The cost-center-scoped user reaches ISB only — not KHI either.
      const khiRuns = (await payroll.listRuns(hrAdminClaims)).filter((r) => r.payrollAreaId === khiAreaId);
      await expect(payroll.calculateRun(regionalCcClaims, khiRuns[0].id)).rejects.toThrow(ForbiddenException);
    });

    it("a scoped caller can never touch a company-wide run (no payroll area), nor create one", async () => {
      const companyWide = (await payroll.listRuns(hrAdminClaims)).find((r) => r.payrollAreaId === null)!;
      await expect(payroll.calculateRun(regionalClaims, companyWide.id)).rejects.toThrow(ForbiddenException);
      await expect(payroll.finalizeRun(regionalClaims, companyWide.id)).rejects.toThrow(ForbiddenException);
      await expect(payroll.generateDisbursementFile(regionalClaims, companyWide.id)).rejects.toThrow(ForbiddenException);
      await expect(payroll.createRun(regionalClaims, { periodStart: "2026-05-01", periodEnd: "2026-05-31" })).rejects.toThrow(
        ForbiddenException
      );
    });

    it("listRuns()/getRun()/listPayslips() narrow a scoped caller to in-scope runs; .all sees everything", async () => {
      const all = await payroll.listRuns(hrAdminClaims);
      const scoped = await payroll.listRuns(regionalClaims);
      expect(new Set(all.map((r) => r.payrollAreaId))).toEqual(new Set([khiAreaId, lheAreaId, null]));
      expect(scoped.length).toBeGreaterThan(0);
      expect(scoped.every((r) => r.payrollAreaId === khiAreaId)).toBe(true);
      expect(scoped.length).toBe(all.filter((r) => r.payrollAreaId === khiAreaId).length);

      const lheRun = all.find((r) => r.payrollAreaId === lheAreaId)!;
      await expect(payroll.getRun(regionalClaims, lheRun.id)).rejects.toThrow(NotFoundException);
      expect((await payroll.getRun(hrAdminClaims, lheRun.id)).id).toBe(lheRun.id);

      const scopedPayslips = await payroll.listPayslips(regionalClaims, {});
      expect(scopedPayslips.length).toBeGreaterThan(0);
      expect(new Set(scopedPayslips.map((p) => p.employeeId))).toEqual(new Set([khiEmployeeId]));
      const lhePayslips = await payroll.listPayslips(hrAdminClaims, { payrollRunId: lheRun.id });
      await expect(payroll.getPayslip(regionalClaims, lhePayslips[0].id)).rejects.toThrow(NotFoundException);
    });

    it("a .all caller is unrestricted: acts on any area's run and on company-wide runs exactly as before", async () => {
      const isbRunId = await approvedRun(hrAdminClaims, "2026-03-01", "2026-03-31", isbAreaId);
      expect((await payroll.finalizeRun(hrAdminClaims, isbRunId)).status).toBe("finalized");
      await payroll.generateDisbursementFile(hrAdminClaims, isbRunId);

      const companyWide = (await payroll.listRuns(hrAdminClaims)).find((r) => r.payrollAreaId === null)!;
      await payroll.submitForApproval(hrAdminClaims, companyWide.id);
      await payroll.decideApproval(approverClaims, companyWide.id, { decision: "approved" });
      expect((await payroll.finalizeRun(hrAdminClaims, companyWide.id)).status).toBe("finalized");
    });

    it("reversing an area run keeps the corrective run in the same payroll area", async () => {
      const khiMarch = (await payroll.listRuns(hrAdminClaims)).find(
        (r) => r.payrollAreaId === khiAreaId && r.periodStart === "2026-03-01" && r.status === "finalized"
      )!;
      const reversed = await payroll.reverseRun(hrAdminClaims, khiMarch.id, { reason: "Wrong allowance" });
      const corrective = await payroll.getRun(hrAdminClaims, reversed.correctiveRunId!);
      expect(corrective.payrollAreaId).toBe(khiAreaId);
      // ...and is therefore still within the regional user's reach.
      expect((await payroll.getRun(regionalClaims, corrective.id)).id).toBe(corrective.id);
    });

    it("never pays an employee twice for one period after they move between payroll areas", async () => {
      const mover = await createEmployee();
      await areas.assignEmployee(hrAdminClaims, { employeeId: mover, payrollAreaId: khiAreaId });
      const khiJune = await payroll.createRun(hrAdminClaims, { periodStart: "2026-06-01", periodEnd: "2026-06-30", payrollAreaId: khiAreaId });
      await payroll.calculateRun(hrAdminClaims, khiJune.id);
      expect(await payslipEmployeeIds(khiJune.id)).toContain(mover);

      // Moving between two in-scope areas is fine for the scoped caller too
      // — but LHE is out of their scope, so hr_admin does this move.
      await areas.assignEmployee(hrAdminClaims, { employeeId: mover, payrollAreaId: lheAreaId });
      const lheJune = await payroll.createRun(hrAdminClaims, { periodStart: "2026-06-01", periodEnd: "2026-06-30", payrollAreaId: lheAreaId });
      const result = await payroll.calculateRun(hrAdminClaims, lheJune.id);
      expect(result.errors.map((e) => e.employeeId)).toEqual([mover]);
      expect(await payslipEmployeeIds(lheJune.id)).toEqual([lheEmployeeId]);
    });
  });
});
