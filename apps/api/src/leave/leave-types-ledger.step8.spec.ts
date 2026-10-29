import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EmployeesService } from "../employees/employees.service";
import { EmployeeGroupsService } from "../employee-groups/employee-groups.service";
import { WorkflowService } from "../workflow/workflow.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { ShiftsService } from "../shifts/shifts.service";
import { WorkScheduleResolutionService } from "../shifts/work-schedule-resolution.service";
import { HolidaysService } from "../holidays/holidays.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { RulesEngine } from "../rules-engine/rules-engine.engine";
import { LeaveRequestsService } from "./leave-requests.service";
import { LeaveTypesService } from "./leave-types.service";
import { LeaveLedgerService } from "./leave-ledger.service";
import { LeaveAccrualService } from "./leave-accrual.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "leave-step8-fixtures" };

/** Gap Register TLM-01 / TLM-02 / TLM-03 against real Postgres. */
describe("Leave types, ledger and request rules (Step 8A)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let employees: EmployeesService;
  let groups: EmployeeGroupsService;
  let workflow: WorkflowService;
  let leave: LeaveRequestsService;
  let types: LeaveTypesService;
  let ledger: LeaveLedgerService;
  let accrual: LeaveAccrualService;
  let companyId: string;
  let hr: RequestClaims;
  let managerClaims: RequestClaims;
  let staffClaims: RequestClaims;
  let femaleClaims: RequestClaims;
  let managerEmployeeId: string;
  let staffEmployeeId: string;
  let femaleEmployeeId: string;
  let defaultPolicyId: string;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const sql = <T = Record<string, unknown>>(q: string, p: unknown[] = []) => db.withClaims(FIXTURE, async (c) => (await c.query(q, p)).rows as T[]);

  async function approve(requestId: string) {
    return leave.decide(managerClaims, requestId, { decision: "approved" });
  }
  async function balance(employeeId: string, leaveType: string, year = 2027) {
    const [row] = await sql<{ entitled_days: string; used_days: string }>(
      "SELECT entitled_days, used_days FROM leave_balances WHERE employee_id = $1 AND leave_type = $2 AND year = $3",
      [employeeId, leaveType, year]
    );
    return row ? { entitled: Number(row.entitled_days), used: Number(row.used_days) } : null;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    const eff = new EffectiveDatingEngine();
    employees = new EmployeesService(db, rbac, ent, audit, new LocalFileStorageService());
    groups = new EmployeeGroupsService(db, rbac, ent, eff, new RulesEngine());
    workflow = new WorkflowService(db, rbac, audit);
    const holidays = new HolidaysService(db, rbac, ent, audit);
    const shifts = new ShiftsService(db, rbac, ent, audit, eff, new RulesEngine());
    const schedule = new WorkScheduleResolutionService(db, shifts, holidays);
    types = new LeaveTypesService(db, rbac, ent, audit);
    ledger = new LeaveLedgerService(db, rbac, ent, audit);
    leave = new LeaveRequestsService(db, rbac, ent, audit, groups, workflow, schedule, types, ledger);
    accrual = new LeaveAccrualService(db, groups, ledger);

    companyId = await db.withClaims(FIXTURE, async (c) => {
      const co = await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Leave8 ${stamp}`, `leave8-${stamp}`]);
      await c.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format) VALUES ($1, '["employee","leave"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [co.rows[0].id]
      );
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true),($1,'leave',true)", [co.rows[0].id]);
      return co.rows[0].id as string;
    });
    const mk = async (label: string, roles: string[]) =>
      db.withClaims(FIXTURE, async (c) => {
        const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`l8-${label}-${stamp}@example.com`]);
        for (const role of roles) {
          await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE key=$3))", [u.rows[0].id, companyId, role]);
        }
        return { claims: { is_platform_admin: false, company_id: companyId, sub: u.rows[0].id } as RequestClaims, uid: u.rows[0].id as string };
      });
    const hrU = await mk("hr", ["hr_admin", "rbac_demo_full_access"]);
    const mgrU = await mk("mgr", ["line_manager", "employee_self_service"]);
    const staffU = await mk("staff", ["employee_self_service"]);
    const femaleU = await mk("female", ["employee_self_service"]);
    hr = hrU.claims;
    managerClaims = mgrU.claims;
    staffClaims = staffU.claims;
    femaleClaims = femaleU.claims;

    managerEmployeeId = (await employees.create(hr, { firstName: "Maya", lastName: "Manager", userAccountId: mgrU.uid })).id;
    staffEmployeeId = (await employees.create(hr, { firstName: "Sam", lastName: "Staff", gender: "male", managerId: managerEmployeeId, userAccountId: staffU.uid })).id;
    femaleEmployeeId = (await employees.create(hr, { firstName: "Fiza", lastName: "Female", gender: "female", managerId: managerEmployeeId, userAccountId: femaleU.uid })).id;

    const policy = await groups.createLeavePolicy(hr, { name: "Default", annualLeaveDays: 14, casualLeaveDays: 10, sickLeaveDays: 8, isDefault: true });
    defaultPolicyId = policy.id;
    await workflow.createTemplate(hr, {
      key: "leave_request",
      name: "Leave Approval",
      objectKey: "leave_request",
      steps: [{ stepOrder: 1, name: "Manager approves", approvers: [{ approverType: "manager_of_submitter" }] }],
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  describe("TLM-01 catalogue and entitlements", () => {
    it("a new tenant gets the built-in types active and the Pakistan-typical ones inactive, with no seeded day counts", async () => {
      const all = await types.list(hr, { includeInactive: true });
      expect(all.map((t) => t.code)).toEqual(expect.arrayContaining(["annual", "casual", "sick", "unpaid", "maternity", "paternity", "hajj", "bereavement", "compensatory", "short_leave"]));
      const active = (await types.list(staffClaims)).map((t) => t.code).sort();
      expect(active).toEqual(["annual", "casual", "sick", "unpaid"]);
      const unpaid = all.find((t) => t.code === "unpaid")!;
      expect(unpaid).toMatchObject({ isPaid: false, tracksBalance: false, isSystem: true });
      expect(all.find((t) => t.code === "maternity")).toMatchObject({ genderRestriction: "female", isActive: false });
      const policy = (await groups.listLeavePolicies(hr)).find((p) => p.id === defaultPolicyId)!;
      expect(policy.entitlements.map((e) => e.leaveType)).toEqual(["annual", "casual", "sick"]);
    });

    it("HR can define tenant types; others cannot; codes are validated, unique and system types stay on", async () => {
      await expect(types.create(staffClaims, { code: "study", name: "Study leave" })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(types.create(hr, { code: "Bad Code!", name: "x" })).rejects.toBeInstanceOf(BadRequestException);
      const study = await types.create(hr, { code: "Study_Leave", name: "Study leave", isPaid: true, halfDayAllowed: false });
      expect(study).toMatchObject({ code: "study_leave", isSystem: false, isActive: true, halfDayAllowed: false });
      await expect(types.create(hr, { code: "study_leave", name: "Dup" })).rejects.toBeInstanceOf(ConflictException);
      const annual = (await types.list(hr)).find((t) => t.code === "annual")!;
      await expect(types.update(hr, annual.id, { isActive: false })).rejects.toBeInstanceOf(BadRequestException);
      await expect(types.update(hr, annual.id, { tracksBalance: false })).rejects.toBeInstanceOf(BadRequestException);
      const renamed = await types.update(hr, annual.id, { name: "Annual leave (paid)" });
      expect(renamed.name).toBe("Annual leave (paid)");
    });

    it("a policy keeps per-leave-type entitlements per version; unknown types are refused; the legacy columns stay in step", async () => {
      await types.update(hr, (await types.list(hr, { includeInactive: true })).find((t) => t.code === "paternity")!.id, { isActive: true });
      const updated = await groups.updateLeavePolicy(hr, defaultPolicyId, {
        annualLeaveDays: 20,
        entitlements: [{ leaveType: "paternity", days: 5 }, { leaveType: "casual", days: 12, carryForwardCapDays: 3 }],
      });
      expect(updated.annualLeaveDays).toBe(20);
      expect(updated.casualLeaveDays).toBe(12); // legacy column follows the entitlement row
      const byType = Object.fromEntries(updated.entitlements.map((e) => [e.leaveType, e]));
      expect(byType.annual.days).toBe(20);
      expect(byType.paternity.days).toBe(5);
      expect(byType.casual.carryForwardCapDays).toBe(3);
      expect(byType.sick.days).toBe(8); // carried over from the previous version

      await expect(groups.updateLeavePolicy(hr, defaultPolicyId, { entitlements: [{ leaveType: "nonexistent", days: 1 }] })).rejects.toBeInstanceOf(BadRequestException);

      const history = await groups.getLeavePolicyHistory(hr, defaultPolicyId);
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[history.length - 1].entitlements?.find((e) => e.leaveType === "paternity")?.days).toBe(5);
    });

    it("enforces the type's gender rule and lists the new balance only for eligible employees", async () => {
      await expect(
        leave.submit(femaleClaims, { employeeId: femaleEmployeeId, leaveType: "paternity", startDate: "2027-02-01", endDate: "2027-02-02" })
      ).rejects.toThrow(/only available to male/);
      await expect(
        leave.submit(staffClaims, { employeeId: staffEmployeeId, leaveType: "hajj", startDate: "2027-02-01", endDate: "2027-02-02" })
      ).rejects.toThrow(/not available/); // hajj is still inactive

      const ok = await leave.submit(staffClaims, { employeeId: staffEmployeeId, leaveType: "paternity", startDate: "2027-02-01", endDate: "2027-02-03" });
      expect(ok.request).toMatchObject({ leaveType: "paternity", daysRequested: 3, dayPart: "full", payrollImpact: false });
      expect(ok.request.returnDate).toBe("2027-02-04");
      const staffBalances = await leave.getBalances(staffClaims, staffEmployeeId);
      expect(staffBalances.find((b) => b.leaveType === "paternity")).toMatchObject({ entitledDays: 5, usedDays: 0 });
      const femaleBalances = await leave.getBalances(femaleClaims, femaleEmployeeId);
      expect(femaleBalances.map((b) => b.leaveType)).not.toContain("paternity");
      await expect(
        leave.submit(staffClaims, { employeeId: staffEmployeeId, leaveType: "paternity", startDate: "2027-03-01", endDate: "2027-03-06" })
      ).rejects.toThrow(/Insufficient/);
    });
  });

  describe("TLM-03 request rules", () => {
    it("supports half days: 0.5 day, opposite halves of one day coexist, the same half or a full day do not", async () => {
      const first = await leave.submit(staffClaims, { employeeId: staffEmployeeId, leaveType: "casual", startDate: "2027-05-10", endDate: "2027-05-10", dayPart: "first_half" });
      expect(first.request).toMatchObject({ daysRequested: 0.5, dayPart: "first_half", returnDate: "2027-05-10" });
      const second = await leave.submit(staffClaims, { employeeId: staffEmployeeId, leaveType: "casual", startDate: "2027-05-10", endDate: "2027-05-10", dayPart: "second_half" });
      expect(second.request).toMatchObject({ daysRequested: 0.5, dayPart: "second_half", returnDate: "2027-05-11" });
      await expect(
        leave.submit(staffClaims, { employeeId: staffEmployeeId, leaveType: "casual", startDate: "2027-05-10", endDate: "2027-05-10", dayPart: "first_half" })
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        leave.submit(staffClaims, { employeeId: staffEmployeeId, leaveType: "sick", startDate: "2027-05-09", endDate: "2027-05-11" })
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        leave.submit(staffClaims, { employeeId: staffEmployeeId, leaveType: "casual", startDate: "2027-05-10", endDate: "2027-05-11", dayPart: "first_half" })
      ).rejects.toThrow(/same date/);
      await expect(
        leave.submit(staffClaims, { employeeId: staffEmployeeId, leaveType: "study_leave", startDate: "2027-06-01", endDate: "2027-06-01", dayPart: "first_half" })
      ).rejects.toThrow(/half day/);
      expect(await balance(staffEmployeeId, "casual")).toEqual({ entitled: 12, used: 0 });
    });

    it("overlapping full-day leave is refused, including at the database (exclusion constraint)", async () => {
      await leave.submit(staffClaims, { employeeId: staffEmployeeId, leaveType: "annual", startDate: "2027-07-05", endDate: "2027-07-07" });
      await expect(
        leave.submit(staffClaims, { employeeId: staffEmployeeId, leaveType: "annual", startDate: "2027-07-07", endDate: "2027-07-08" })
      ).rejects.toBeInstanceOf(ConflictException);
      const constraint = await sql("SELECT 1 FROM pg_constraint WHERE conname = 'leave_requests_no_full_day_overlap'");
      expect(constraint).toHaveLength(1);
      await expect(
        sql(
          `INSERT INTO leave_requests (company_id, employee_id, leave_type, start_date, end_date, days_requested, status, submitted_by_user_account_id)
           VALUES ($1, $2, 'annual', '2027-07-06', '2027-07-06', 1, 'pending', $3)`,
          [companyId, staffEmployeeId, staffClaims.sub]
        )
      ).rejects.toThrow();
    });

    it("requires a supporting document beyond the type's threshold and validates it belongs to the employee; stores delegate and rejection reason", async () => {
      const t = await types.create(hr, { code: "medical", name: "Medical leave", documentRequired: true, documentRequiredAfterDays: 2 });
      expect(t.documentRequiredAfterDays).toBe(2);
      await groups.updateLeavePolicy(hr, defaultPolicyId, { entitlements: [{ leaveType: "medical", days: 10 }] });
      await expect(
        leave.submit(staffClaims, { employeeId: staffEmployeeId, leaveType: "medical", startDate: "2027-08-02", endDate: "2027-08-04" })
      ).rejects.toThrow(/supporting document/);
      const short = await leave.submit(staffClaims, { employeeId: staffEmployeeId, leaveType: "medical", startDate: "2027-08-02", endDate: "2027-08-03" });
      expect(short.request.daysRequested).toBe(2);

      const [doc] = await sql<{ id: string }>(
        `INSERT INTO employee_documents (company_id, employee_id, document_type, file_name, mime_type, size_bytes, storage_path)
         VALUES ($1,$2,'medical_certificate','cert.pdf','application/pdf',10,'x/cert.pdf') RETURNING id`,
        [companyId, staffEmployeeId]
      );
      const [otherDoc] = await sql<{ id: string }>(
        `INSERT INTO employee_documents (company_id, employee_id, document_type, file_name, mime_type, size_bytes, storage_path)
         VALUES ($1,$2,'medical_certificate','other.pdf','application/pdf',10,'x/other.pdf') RETURNING id`,
        [companyId, femaleEmployeeId]
      );
      await expect(
        leave.submit(staffClaims, { employeeId: staffEmployeeId, leaveType: "medical", startDate: "2027-08-09", endDate: "2027-08-12", attachmentDocumentId: otherDoc.id })
      ).rejects.toThrow(/does not belong/);
      const withDoc = await leave.submit(staffClaims, {
        employeeId: staffEmployeeId, leaveType: "medical", startDate: "2027-08-09", endDate: "2027-08-12",
        attachmentDocumentId: doc.id, delegateEmployeeId: femaleEmployeeId,
      });
      expect(withDoc.request).toMatchObject({ attachmentDocumentId: doc.id, delegateEmployeeId: femaleEmployeeId, daysRequested: 4 });
      await expect(
        leave.submit(staffClaims, { employeeId: staffEmployeeId, leaveType: "annual", startDate: "2027-09-01", endDate: "2027-09-01", delegateEmployeeId: staffEmployeeId })
      ).rejects.toThrow(/themselves/);

      const rejected = await leave.decide(managerClaims, short.request.id, { decision: "rejected", comment: "Team is short-staffed" });
      expect(rejected).toMatchObject({ status: "rejected", rejectionReason: "Team is short-staffed" });
    });

    it("unpaid leave keeps no balance, flags payroll impact and is read by payroll through is_paid=false (half day = 0.5)", async () => {
      const full = await leave.submit(staffClaims, { employeeId: staffEmployeeId, leaveType: "unpaid", startDate: "2027-10-04", endDate: "2027-10-05" });
      const half = await leave.submit(staffClaims, { employeeId: staffEmployeeId, leaveType: "unpaid", startDate: "2027-10-11", endDate: "2027-10-11", dayPart: "second_half" });
      expect(full.request.payrollImpact).toBe(true);
      await approve(full.request.id);
      await approve(half.request.id);
      expect(await balance(staffEmployeeId, "unpaid")).toBeNull();
      const segments = await db.withClaims(hr, (client) => leave.getApprovedUnpaidLeaveDaysInRange(client, staffEmployeeId, "2027-10-01", "2027-10-31"));
      expect(segments.totalDays).toBe(2.5);
    });
  });

  describe("TLM-02 ledger", () => {
    it("approval writes a deduction, cancelling reverses it once, and the balance is always derived from the ledger", async () => {
      const sub = await leave.submit(staffClaims, { employeeId: staffEmployeeId, leaveType: "sick", startDate: "2027-11-01", endDate: "2027-11-03" });
      expect(await balance(staffEmployeeId, "sick")).toEqual({ entitled: 8, used: 0 });
      await approve(sub.request.id);
      expect(await balance(staffEmployeeId, "sick")).toEqual({ entitled: 8, used: 3 });
      const entries = await ledger.history(staffClaims, staffEmployeeId, { leaveType: "sick", year: 2027 });
      expect(entries.map((e) => [e.entryType, e.days])).toEqual([["deduction", -3], ["opening", 8]]);
      expect(entries[0]).toMatchObject({ sourceType: "leave_request", sourceId: sub.request.id });

      await leave.cancel(hr, sub.request.id);
      expect(await balance(staffEmployeeId, "sick")).toEqual({ entitled: 8, used: 0 });
      const after = await ledger.history(hr, staffEmployeeId, { leaveType: "sick", year: 2027 });
      expect(after.map((e) => e.entryType).sort()).toEqual(["deduction", "opening", "reversal"]);
      expect(after.find((e) => e.entryType === "reversal")!.reversesEntryId).toBe(after.find((e) => e.entryType === "deduction")!.id);
      await expect(leave.cancel(hr, sub.request.id)).rejects.toThrow(/already cancelled/);

      // Derived: re-deriving from the ledger gives the same summary.
      await db.withClaims(FIXTURE, (c) => ledger.refreshBalance(c, companyId, staffEmployeeId, "sick", 2027));
      expect(await balance(staffEmployeeId, "sick")).toEqual({ entitled: 8, used: 0 });
    });

    it("the ledger is append-only", async () => {
      await expect(sql("UPDATE leave_ledger SET days = 99 WHERE employee_id = $1", [staffEmployeeId])).rejects.toThrow(/append-only|permission denied/);
      await expect(sql("DELETE FROM leave_ledger WHERE employee_id = $1", [staffEmployeeId])).rejects.toThrow(/append-only|permission denied/);
    });

    it("HR adjustments need a reason and permission, never push the balance below used, and appear in the history and audit log", async () => {
      await expect(ledger.adjust(staffClaims, { employeeId: staffEmployeeId, leaveType: "annual", year: 2027, days: 2, reason: "x" })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(ledger.adjust(hr, { employeeId: staffEmployeeId, leaveType: "annual", year: 2027, days: 2, reason: "  " })).rejects.toBeInstanceOf(BadRequestException);
      const sub = await leave.submit(staffClaims, { employeeId: staffEmployeeId, leaveType: "annual", startDate: "2027-12-01", endDate: "2027-12-05" });
      await approve(sub.request.id);
      const r = await ledger.adjust(hr, { employeeId: staffEmployeeId, leaveType: "annual", year: 2027, days: 2.5, reason: "Granted for covering a shutdown" });
      expect(r).toEqual({ entitledDays: 22.5, usedDays: 5, remainingDays: 17.5 });
      await expect(ledger.adjust(hr, { employeeId: staffEmployeeId, leaveType: "annual", year: 2027, days: -20, reason: "too much" })).rejects.toThrow(/below the days already used/);
      await expect(ledger.adjust(hr, { employeeId: staffEmployeeId, leaveType: "unpaid", year: 2027, days: 1, reason: "no balance" })).rejects.toThrow(/does not keep a balance/);
      const history = await ledger.history(hr, staffEmployeeId, { leaveType: "annual", year: 2027 });
      expect(history.find((e) => e.entryType === "adjustment")).toMatchObject({ days: 2.5, sourceType: "manual_adjustment", reason: "Granted for covering a shutdown" });
      const audited = await sql("SELECT 1 FROM audit_log WHERE company_id = $1 AND action = 'leave_balance.adjust'", [companyId]);
      expect(audited.length).toBeGreaterThan(0);
      const [bal] = await sql<{ entitled_days: string; adjusted_days: string; opening_days: string }>(
        "SELECT entitled_days, adjusted_days, opening_days FROM leave_balances WHERE employee_id = $1 AND leave_type = 'annual' AND year = 2027",
        [staffEmployeeId]
      );
      expect([Number(bal.entitled_days), Number(bal.adjusted_days), Number(bal.opening_days)]).toEqual([22.5, 2.5, 20]);
      // Staff cannot read a colleague's ledger.
      await expect(ledger.history(femaleClaims, staffEmployeeId)).rejects.toThrow();
    });

    it("a balance row created at 0 before a policy applied is topped up when the policy grants days, once only (LIVE-18)", async () => {
      const year = 2031;
      const row = async () => (await sql<{ entitled_days: string }>("SELECT entitled_days FROM leave_balances WHERE employee_id = $1 AND leave_type = 'annual' AND year = $2", [staffEmployeeId, year]))[0];
      await db.withClaims(hr, (c) => ledger.ensureBalance(c, companyId, staffEmployeeId, "annual", year, { days: 0, method: "upfront" }));
      expect(Number((await row()).entitled_days)).toBe(0);

      await db.withClaims(hr, (c) => ledger.ensureBalance(c, companyId, staffEmployeeId, "annual", year, { days: 14, method: "upfront" }));
      expect(Number((await row()).entitled_days)).toBe(14);

      // Asking again does not post the entitlement twice, and a later HR adjustment is not undone.
      await db.withClaims(hr, (c) => ledger.ensureBalance(c, companyId, staffEmployeeId, "annual", year, { days: 14, method: "upfront" }));
      expect(Number((await row()).entitled_days)).toBe(14);
      await ledger.adjust(hr, { employeeId: staffEmployeeId, leaveType: "annual", year, days: 3, reason: "Carried over by agreement" });
      await db.withClaims(hr, (c) => ledger.ensureBalance(c, companyId, staffEmployeeId, "annual", year, { days: 14, method: "upfront" }));
      expect(Number((await row()).entitled_days)).toBe(17);
    });

    it("a type with accrual method 'none' is never topped up from the policy (LIVE-18)", async () => {
      const year = 2032;
      await db.withClaims(hr, (c) => ledger.ensureBalance(c, companyId, staffEmployeeId, "sick", year, { days: 0, method: "none" }));
      await db.withClaims(hr, (c) => ledger.ensureBalance(c, companyId, staffEmployeeId, "sick", year, { days: 8, method: "none" }));
      const [r] = await sql<{ entitled_days: string }>("SELECT entitled_days FROM leave_balances WHERE employee_id = $1 AND leave_type = 'sick' AND year = $2", [staffEmployeeId, year]);
      expect(Number(r.entitled_days)).toBe(0);
    });

    it("the monthly accrual job accrues each elapsed month once, is idempotent and catches up", async () => {
      await types.create(hr, { code: "monthly_leave", name: "Monthly leave", accrualMethod: "monthly" });
      // Grant the entitlement on the policy this employee actually resolves to (a group assignment can win over the default policy).
      const resolved = await groups.resolvePolicyInternal({ ...FIXTURE, company_id: companyId, is_service: true } as RequestClaims, staffEmployeeId, "leave");
      await groups.updateLeavePolicy(hr, resolved.policyId ?? defaultPolicyId, { entitlements: [{ leaveType: "monthly_leave", days: 12 }] });
      const mar = await accrual.run("2027-03-15", companyId);
      expect(mar.accruals).toBeGreaterThanOrEqual(3);
      expect(await balance(staffEmployeeId, "monthly_leave")).toEqual({ entitled: 3, used: 0 });
      expect((await accrual.run("2027-03-20", companyId)).accruals).toBe(0); // same month: nothing new
      expect(await balance(staffEmployeeId, "monthly_leave")).toEqual({ entitled: 3, used: 0 });
      await accrual.run("2027-04-02", companyId);
      expect(await balance(staffEmployeeId, "monthly_leave")).toEqual({ entitled: 4, used: 0 });
      await accrual.run("2027-12-31", companyId);
      expect(await balance(staffEmployeeId, "monthly_leave")).toEqual({ entitled: 12, used: 0 });
      const entries = await ledger.history(hr, staffEmployeeId, { leaveType: "monthly_leave", year: 2027 });
      expect(entries.filter((e) => e.entryType === "accrual")).toHaveLength(12);
    });
  });

  describe("TLM-03 cancellation of approved leave", () => {
    it("an employee requests cancellation, the manager declines or approves, and approval restores the balance", async () => {
      const sub = await leave.submit(staffClaims, { employeeId: staffEmployeeId, leaveType: "casual", startDate: "2027-12-20", endDate: "2027-12-21" });
      await expect(leave.requestCancellation(staffClaims, sub.request.id, "plans changed")).rejects.toThrow(/approved/);
      await approve(sub.request.id);
      const before = await balance(staffEmployeeId, "casual");
      expect(before!.used).toBe(2);

      await expect(leave.requestCancellation(femaleClaims, sub.request.id, "not mine")).rejects.toThrow();
      await expect(leave.requestCancellation(staffClaims, sub.request.id, "")).rejects.toBeInstanceOf(BadRequestException);
      const requested = await leave.requestCancellation(staffClaims, sub.request.id, "plans changed");
      expect(requested).toMatchObject({ status: "approved", cancellationStatus: "requested", cancellationReason: "plans changed" });
      await expect(leave.requestCancellation(staffClaims, sub.request.id, "again")).rejects.toBeInstanceOf(ConflictException);
      await expect(leave.decideCancellation(staffClaims, sub.request.id, { decision: "approved" })).rejects.toThrow();

      const declined = await leave.decideCancellation(managerClaims, sub.request.id, { decision: "declined" });
      expect(declined).toMatchObject({ status: "approved", cancellationStatus: "declined" });
      expect((await balance(staffEmployeeId, "casual"))!.used).toBe(2);

      await leave.requestCancellation(staffClaims, sub.request.id, "really cannot go");
      const approvedCancel = await leave.decideCancellation(managerClaims, sub.request.id, { decision: "approved" });
      expect(approvedCancel).toMatchObject({ status: "cancelled", cancellationStatus: "approved" });
      expect((await balance(staffEmployeeId, "casual"))!.used).toBe(0);
    });

    it("a leave that has already ended cannot have a cancellation requested", async () => {
      await sql(
        `INSERT INTO leave_requests (company_id, employee_id, leave_type, start_date, end_date, days_requested, status, submitted_by_user_account_id)
         VALUES ($1, $2, 'annual', '2020-01-06', '2020-01-07', 2, 'approved', $3)`,
        [companyId, staffEmployeeId, staffClaims.sub]
      );
      const [row] = await sql<{ id: string }>("SELECT id FROM leave_requests WHERE employee_id = $1 AND start_date = '2020-01-06'", [staffEmployeeId]);
      await expect(leave.requestCancellation(staffClaims, row.id, "oops")).rejects.toThrow(/already ended/);
    });
  });
});
