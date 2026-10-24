import { Pool } from "pg";
import { HttpException, NotFoundException } from "@nestjs/common";
import type { LeaveValidationResult, SetLeaveDurationSettingsRequest } from "@aihxm/shared-types";
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
import { AttendanceEvaluationService } from "./attendance-evaluation.service";
import { LeaveTypesService } from "./leave-types.service";
import { LeaveDurationSettingsService } from "./leave-duration-settings.service";
import { LeaveValidationRulesService } from "./leave-validation-rules.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "short-hours-fixtures" };

/**
 * BACKLOG58 against real Postgres: short-hours leave and the configurable validation rules. One company with a day
 * shift (09:00-18:00, unpaid lunch 13:00-14:00 Mon-Fri), a night shift (22:00-06:00) and an 08:00-16:00 shift, a
 * short-hours leave type kept in hours, and a second company that must never see any of it.
 */
describe("Short-hours leave and validation rules (BACKLOG58)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let leave: LeaveRequestsService;
  let types: LeaveTypesService;
  let settings: LeaveDurationSettingsService;
  let rules: LeaveValidationRulesService;
  let employees: EmployeesService;
  let shifts: ShiftsService;
  let evaluation: AttendanceEvaluationService;

  let companyId: string;
  let otherCompanyId: string;
  let hr: RequestClaims;
  let otherHr: RequestClaims;
  let otherStaff: RequestClaims;
  let otherEmployeeId: string;
  const staff: Record<string, { claims: RequestClaims; employeeId: string }> = {};
  let shortLeaveTypeId: string;

  const NONE: SetLeaveDurationSettingsRequest = {
    selectionMethod: "employee_selected", earliestStartTime: null, latestEndTime: null, fixedStartTime: null, fixedEndTime: null,
    minDurationMinutes: null, maxDurationMinutes: null, incrementMinutes: null, breakTreatment: "exclude_unpaid",
    validateAgainstSchedule: true, allowOvernight: false, sameDayPolicy: "unrestricted", minNoticeMinutes: null, backdateDaysAllowed: null,
    dailyLimitMinutes: null, monthlyLimitMinutes: null, frequencyMaxRequests: null, frequencyPeriod: null, dayEquivalentMinutes: null,
    workflowTemplateKey: null, isActive: true,
  };
  const configure = (patch: SetLeaveDurationSettingsRequest = {}) => settings.set(hr, "short_leave", null, { ...NONE, ...patch });

  const timed = (who: string, date: string, startTime: string, endTime: string, extra: Record<string, unknown> = {}) => ({
    employeeId: staff[who].employeeId, leaveType: "short_leave", startDate: date, endDate: date, dayPart: "hours" as const, startTime, endTime, ...extra,
  });
  const submit = (who: string, date: string, s: string, e: string, extra: Record<string, unknown> = {}) => leave.submit(staff[who].claims, timed(who, date, s, e, extra));

  /** The structured findings a refused request carries. */
  async function refusal(p: Promise<unknown>): Promise<{ status: number; codes: string[]; validation: LeaveValidationResult }> {
    try {
      await p;
    } catch (err) {
      if (err instanceof HttpException) {
        const body = err.getResponse() as { validation?: LeaveValidationResult };
        const v = body.validation as LeaveValidationResult;
        return { status: err.getStatus(), codes: v ? [...v.blocking, ...v.warnings].map((f) => f.code) : [], validation: v };
      }
      throw err;
    }
    throw new Error("expected the request to be refused");
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    employees = new EmployeesService(db, rbac, ent, audit, new LocalFileStorageService());
    const groups = new EmployeeGroupsService(db, rbac, ent, new EffectiveDatingEngine(), new RulesEngine());
    const workflow = new WorkflowService(db, rbac, audit);
    const holidays = new HolidaysService(db, rbac, ent, audit);
    shifts = new ShiftsService(db, rbac, ent, audit, new EffectiveDatingEngine(), new RulesEngine());
    const workSchedule = new WorkScheduleResolutionService(db, shifts, holidays);
    leave = new LeaveRequestsService(db, rbac, ent, audit, groups, workflow, workSchedule);
    evaluation = new AttendanceEvaluationService(db, rbac, ent, audit, workSchedule);
    types = new LeaveTypesService(db, rbac, ent, audit);
    settings = new LeaveDurationSettingsService(db, rbac, ent, audit);
    rules = new LeaveValidationRulesService(db, rbac, ent, audit);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const makeCompany = async (name: string) =>
      db.withClaims(FIXTURE, async (c) => {
        const r = await c.query("INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, 'Asia/Karachi') RETURNING id", [`${name} ${stamp}`, `${name.toLowerCase().replace(/\W+/g, "-")}-${stamp}`]);
        const id = r.rows[0].id as string;
        await c.query(`INSERT INTO company_config (company_id, enabled_modules, employee_number_format) VALUES ($1, '["employee","leave"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`, [id]);
        await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true),($1,'leave',true)", [id]);
        return id;
      });
    const makeUser = async (company: string, tag: string, roles: string[]): Promise<RequestClaims> =>
      db.withClaims(FIXTURE, async (c) => {
        const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`sh-${tag}-${stamp}@example.com`]);
        for (const key of roles) {
          const role = await c.query("SELECT id FROM roles WHERE key = $1", [key]);
          await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,$3)", [u.rows[0].id, company, role.rows[0].id]);
        }
        return { is_platform_admin: false, company_id: company, sub: u.rows[0].id as string };
      });

    companyId = await makeCompany("Short Hours Co");
    otherCompanyId = await makeCompany("Short Hours Other");
    hr = await makeUser(companyId, "hr", ["hr_admin", "rbac_demo_full_access"]);
    otherHr = await makeUser(otherCompanyId, "ohr", ["hr_admin", "rbac_demo_full_access"]);
    otherStaff = await makeUser(otherCompanyId, "ostaff", ["employee_self_service"]);
    otherEmployeeId = (await employees.create(otherHr, { firstName: "Olga", lastName: "Other", userAccountId: otherStaff.sub })).id;

    // One approval step served by HR, in both companies.
    for (const [claims, label] of [[hr, "hr"], [otherHr, "ohr"]] as const) {
      await workflow.createTemplate(claims, { key: "leave_request", name: `Leave ${label}`, objectKey: "leave_request", steps: [{ stepOrder: 1, name: "HR approves", approvers: [{ approverType: "specific_user", userAccountId: claims.sub }] }] });
    }

    // The short-hours type: off by default, switched on here and kept in hours.
    shortLeaveTypeId = await db.withClaims(hr, async (c) => (await types.getByCode(c, companyId, "short_leave"))!.id);
    await types.update(hr, shortLeaveTypeId, { isActive: true, durationMode: "short_hours", balanceUnit: "hours" });
    await groups.createLeavePolicy(hr, { name: "Default", annualLeaveDays: 20, casualLeaveDays: 5, sickLeaveDays: 5, isDefault: true, entitlements: [{ leaveType: "short_leave", days: 20 }] });

    const day = await shifts.createShift(hr, { name: "Day 9-18", startTime: "09:00", endTime: "18:00", timezone: "Asia/Karachi" });
    await shifts.setWeeklyPattern(hr, day.id, {
      days: Array.from({ length: 7 }, (_, d) => ({
        dayOfWeek: d,
        isWorking: d >= 1 && d <= 5,
        ...(d >= 1 && d <= 5 ? { startTime: "09:00", endTime: "18:00", breaks: [{ startTime: "13:00", endTime: "14:00", isPaid: false }] } : {}),
      })),
    });
    const night = await shifts.createShift(hr, { name: "Night 22-06", startTime: "22:00", endTime: "06:00", crossesMidnight: true, timezone: "Asia/Karachi" });
    await shifts.setWeeklyPattern(hr, night.id, {
      days: Array.from({ length: 7 }, (_, d) => ({ dayOfWeek: d, isWorking: d >= 1 && d <= 5, ...(d >= 1 && d <= 5 ? { startTime: "22:00", endTime: "06:00" } : {}) })),
    });
    const early = await shifts.createShift(hr, { name: "Early 8-16", startTime: "08:00", endTime: "16:00", timezone: "Asia/Karachi" });
    await shifts.setWeeklyPattern(hr, early.id, {
      days: Array.from({ length: 7 }, (_, d) => ({ dayOfWeek: d, isWorking: d >= 1 && d <= 5, ...(d >= 1 && d <= 5 ? { startTime: "08:00", endTime: "16:00" } : {}) })),
    });

    const people: Array<[string, string]> = [["a", day.id], ["b", night.id], ["c", early.id], ["d", day.id], ["e", day.id], ["f", day.id], ["g", day.id]];
    for (const [tag, shiftId] of people) {
      const claims = await makeUser(companyId, tag, ["employee_self_service"]);
      const emp = await employees.create(hr, { firstName: `Person ${tag.toUpperCase()}`, lastName: "Shorthours", userAccountId: claims.sub });
      await shifts.assignShift(hr, { employeeId: emp.id, shiftId, effectiveFrom: "2026-01-01" });
      staff[tag] = { claims, employeeId: emp.id };
    }
    await configure();
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE, (c) => c.query("DELETE FROM companies WHERE id = ANY($1::uuid[])", [[companyId, otherCompanyId]]));
    await pool.end();
  });

  /** The 2027 balance in hours, as the validation reports it (the balances list only covers the current year). */
  const balanceOf = async (who: string) => {
    const probe = await leave.validate(staff[who].claims, timed(who, "2027-12-27", "10:00", "10:30"));
    return probe.balance!;
  };

  it("accepts a valid one-hour request, prices it from the schedule and holds it against the balance", async () => {
    const { request, validation } = await submit("a", "2027-06-07", "10:00", "11:00", { reason: "Bank" });
    expect(request).toMatchObject({ status: "pending", dayPart: "hours", startTime: "10:00", endTime: "11:00", durationMinutes: 60, balanceUnits: 1, balanceUnit: "hours", timeZone: "Asia/Karachi" });
    expect(request.startDate).toBe("2027-06-07");
    expect(validation?.duration?.durationMinutes).toBe(60);
    const b = await balanceOf("a");
    expect(b).toMatchObject({ unit: "hours", entitled: 20, used: 0, reserved: 1, available: 19 });
    // the same figures come back from the dry run without writing anything
    const dry = await leave.validate(staff.a.claims, timed("a", "2027-06-08", "10:00", "11:00"));
    expect(dry.canSubmit).toBe(true);
    expect(dry.balance).toMatchObject({ unit: "hours", reserved: 1, available: 19 });
    expect((await leave.listRequests(staff.a.claims)).filter((r) => r.startDate === "2027-06-08")).toHaveLength(0);
  });

  it("enforces the minimum and maximum duration exactly at the boundaries, and the request step", async () => {
    await configure({ minDurationMinutes: 30, maxDurationMinutes: 120, incrementMinutes: 15 });
    expect((await submit("a", "2027-06-08", "10:00", "10:30")).request.durationMinutes).toBe(30); // exactly the minimum
    expect((await submit("a", "2027-06-09", "10:00", "12:00")).request.durationMinutes).toBe(120); // exactly the maximum
    expect((await refusal(submit("a", "2027-06-10", "10:00", "10:15"))).codes).toContain("min_duration_not_met");
    expect((await refusal(submit("a", "2027-06-10", "10:00", "12:15"))).codes).toContain("max_duration_exceeded");
    expect((await refusal(submit("a", "2027-06-10", "10:00", "10:50"))).codes).toContain("invalid_time_range"); // not on a 15-minute step
  });

  it("refuses missing, reversed and empty ranges with stable codes", async () => {
    await configure();
    for (const [s, e] of [["11:00", "10:00"], ["10:00", "10:00"]] as const) {
      const r = await refusal(submit("a", "2027-06-10", s, e));
      expect(r.status).toBe(400);
      expect(r.codes).toContain("invalid_time_range");
    }
    const missing = await refusal(leave.submit(staff.a.claims, { employeeId: staff.a.employeeId, leaveType: "short_leave", startDate: "2027-06-10", endDate: "2027-06-10", dayPart: "hours", startTime: "10:00" }));
    expect(missing.codes).toContain("invalid_time_range");
    expect(missing.validation.blocking[0]).toMatchObject({ code: "invalid_time_range", severity: "block" });
    // nothing was written by any of the refused attempts
    expect((await leave.listRequests(staff.a.claims)).filter((r) => r.startDate === "2027-06-10")).toHaveLength(0);
  });

  it("refuses times outside the permitted window", async () => {
    await configure({ earliestStartTime: "10:00", latestEndTime: "17:00" });
    expect((await refusal(submit("a", "2027-06-10", "09:00", "10:00"))).codes).toContain("outside_permitted_hours");
    expect((await refusal(submit("a", "2027-06-10", "16:00", "17:30"))).codes).toContain("outside_permitted_hours");
    expect((await submit("a", "2027-06-10", "16:00", "17:00")).request.durationMinutes).toBe(60);
  });

  it("does not count the unpaid lunch break inside the request (unless the type says to)", async () => {
    await configure();
    const r = await submit("a", "2027-06-14", "12:00", "15:00");
    expect(r.request).toMatchObject({ durationMinutes: 120, breakMinutes: 60, balanceUnits: 2 });
    expect(r.validation?.duration).toMatchObject({ grossMinutes: 180, breakMinutes: 60, durationMinutes: 120 });
    await configure({ breakTreatment: "include" });
    const counted = await leave.validate(staff.a.claims, timed("a", "2027-06-15", "12:00", "15:00"));
    expect(counted.duration).toMatchObject({ durationMinutes: 180, breakMinutes: 0 });
    await configure();
  });

  it("validates against the employee's own shift, so the same times can be right for one person and wrong for another", async () => {
    await configure();
    // 08:00-09:00 is before the day shift starts, but inside the early shift
    expect((await refusal(submit("a", "2027-06-16", "08:00", "09:00"))).codes).toContain("attendance_or_shift_conflict");
    expect((await submit("c", "2027-06-16", "08:00", "09:00")).request.durationMinutes).toBe(60);
    // a type that does not validate against the schedule lets anyone pick
    await configure({ validateAgainstSchedule: false });
    expect((await submit("a", "2027-06-16", "07:00", "08:00")).request.durationMinutes).toBe(60);
    await configure();
  });

  it("accepts a request that runs past midnight only when the type explicitly allows it", async () => {
    await configure({ allowOvernight: false });
    expect((await refusal(submit("b", "2027-06-14", "23:00", "02:00"))).codes).toContain("invalid_time_range");
    await configure({ allowOvernight: true });
    const r = await submit("b", "2027-06-14", "23:00", "02:00");
    expect(r.request).toMatchObject({ durationMinutes: 180, balanceUnits: 3, startDate: "2027-06-14", endDate: "2027-06-15" });
    await configure();
  });

  it("stops a request without the required supporting document, and accepts it once one is attached", async () => {
    await types.update(hr, shortLeaveTypeId, { documentRequired: true, documentRequiredAfterDays: 5 });
    const rule = await rules.create(hr, { code: "doc_over_an_hour", name: "Document over an hour", validationType: "attachment_required", leaveTypes: ["short_leave"], severity: "block", message: "Attach the document for requests over an hour.", params: { requiredAfterMinutes: 60 }, priority: 5 });
    try {
      const refused = await refusal(submit("d", "2027-06-21", "10:00", "11:30"));
      expect(refused.codes).toContain("attachment_required");
      expect(refused.validation.blocking.find((f) => f.code === "attachment_required")).toMatchObject({ field: "attachment", message: "Attach the document for requests over an hour." });
      expect((await submit("d", "2027-06-21", "10:00", "11:00")).request.durationMinutes).toBe(60); // not over the threshold
      const doc = await employees.addDocument(hr, staff.d.employeeId, "other", { originalname: "note.pdf", mimetype: "application/pdf", buffer: Buffer.from("%PDF-1.4 x"), size: 10 });
      const ok = await submit("d", "2027-06-22", "10:00", "11:30", { attachmentDocumentId: doc.id });
      expect(ok.request.attachmentDocumentId).toBe(doc.id);
    } finally {
      await rules.remove(hr, rule.id);
      await types.update(hr, shortLeaveTypeId, { documentRequired: false });
    }
  });

  it("refuses a request that overlaps another pending or approved one, by any part of it", async () => {
    await submit("e", "2027-06-23", "10:00", "11:00");
    const clash = await refusal(submit("e", "2027-06-23", "10:30", "11:30"));
    expect(clash.status).toBe(409);
    expect(clash.codes).toContain("overlaps_existing_request");
    const wholeDay = await refusal(leave.submit(staff.e.claims, { employeeId: staff.e.employeeId, leaveType: "annual", startDate: "2027-06-22", endDate: "2027-06-24" }));
    expect(wholeDay.codes).toContain("overlaps_existing_request");
    expect((await submit("e", "2027-06-23", "11:00", "12:00")).request.durationMinutes).toBe(60); // touching, not overlapping
  });

  it("blocks an overspend, counting what pending requests already hold, and gives the balance back when one is cancelled", async () => {
    await configure();
    const first = await submit("f", "2027-06-28", "09:00", "18:00"); // 9h less the lunch hour = 8h
    expect(first.request.balanceUnits).toBe(8);
    await submit("f", "2027-06-29", "09:00", "18:00"); // 16h held
    const third = await refusal(submit("f", "2027-06-30", "09:00", "18:00")); // 24h > 20h
    expect(third.codes).toContain("balance_insufficient");
    expect(third.validation.balance).toMatchObject({ unit: "hours", entitled: 20, reserved: 16, available: 4 });
    expect(third.validation.blocking.find((f) => f.code === "balance_insufficient")?.message).toMatch(/Insufficient/);
    await leave.cancel(hr, first.request.id);
    expect((await balanceOf("f")).reserved).toBe(8);
    expect((await submit("f", "2027-06-30", "09:00", "18:00")).request.balanceUnits).toBe(8);
  });

  it("lets a warning through only after the employee confirms it, and never lets a non-proceed warning through", async () => {
    await configure();
    const rule = await rules.create(hr, { code: "long_one_warn", name: "Over an hour (warn)", validationType: "max_duration_exceeded", leaveTypes: ["short_leave"], severity: "warning", allowProceed: true, message: "That is longer than an hour: {{requested}}.", params: { maxMinutes: 60 }, priority: 1 });
    try {
      const unconfirmed = await refusal(submit("g", "2027-07-05", "10:00", "11:30"));
      expect(unconfirmed.status).toBe(409);
      expect(unconfirmed.validation.warnings.map((w) => w.ruleCode)).toEqual(["long_one_warn"]);
      expect(unconfirmed.validation.blocking).toHaveLength(0);
      const dry = await leave.validate(staff.g.claims, timed("g", "2027-07-05", "10:00", "11:30"));
      expect(dry.canSubmit).toBe(false);
      const ok = await submit("g", "2027-07-05", "10:00", "11:30", { acknowledgedWarnings: ["long_one_warn"] });
      expect(ok.request.acknowledgedWarnings).toEqual(["long_one_warn"]);
      expect(ok.validation?.acknowledged).toEqual(["long_one_warn"]);
      // the same warning but one the employee may not proceed through
      await rules.update(hr, rule.id, { allowProceed: false });
      const stuck = await refusal(submit("g", "2027-07-06", "10:00", "11:30", { acknowledgedWarnings: ["long_one_warn"] }));
      expect(stuck.codes).toContain("max_duration_exceeded");
    } finally {
      await rules.remove(hr, rule.id);
    }
  });

  it("serialises concurrent requests: a balance cannot be overspent and one slot cannot be booked twice", async () => {
    await configure();
    // five 6-hour requests on five different days against what is left of the 20 hours
    const room = Math.floor((await balanceOf("d")).available / 6);
    expect(room).toBeLessThan(5);
    const days = ["2027-07-12", "2027-07-13", "2027-07-14", "2027-07-15", "2027-07-16"];
    const settled = await Promise.allSettled(days.map((d) => leave.submit(staff.d.claims, timed("d", d, "09:00", "16:00"))));
    const ok = settled.filter((s) => s.status === "fulfilled").length;
    expect(ok).toBe(room);
    const failures = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected").map((s) => s.reason as HttpException);
    expect(failures).toHaveLength(5 - room);
    for (const f of failures) {
      const v = (f.getResponse() as { validation: LeaveValidationResult }).validation;
      expect(v.blocking.map((b) => b.code)).toContain("balance_insufficient");
    }
    expect((await balanceOf("d")).reserved).toBeLessThanOrEqual(20);
    // three identical requests at the same moment: exactly one is booked
    const same = await Promise.allSettled([1, 2, 3].map(() => leave.submit(staff.g.claims, timed("g", "2027-07-20", "10:00", "11:00"))));
    expect(same.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect(same.filter((s): s is PromiseRejectedResult => s.status === "rejected").every((s) => (s.reason as HttpException).getStatus() === 409)).toBe(true);
    const rows = await db.withClaims(hr, (c) => c.query("SELECT count(*)::int AS n FROM leave_requests WHERE employee_id = $1 AND start_date = '2027-07-20' AND status = 'pending'", [staff.g.employeeId]));
    expect(rows.rows[0].n).toBe(1);
  });

  it("keeps a request on the rules it was accepted under when the policy changes later, and applies the new rules to new requests", async () => {
    await configure({ maxDurationMinutes: 180 });
    const old = await submit("a", "2027-07-26", "10:00", "12:30");
    expect(old.request.durationMinutes).toBe(150);
    await configure({ maxDurationMinutes: 30 });
    const stored = await db.withClaims(hr, (c) => c.query("SELECT balance_units, duration_minutes, rules_snapshot FROM leave_requests WHERE id = $1", [old.request.id]));
    expect(Number(stored.rows[0].balance_units)).toBe(2.5);
    expect(JSON.stringify(stored.rows[0].rules_snapshot)).toContain("180"); // the settings it was judged by
    // a new request meets the new limit ...
    expect((await refusal(submit("a", "2027-07-27", "10:00", "11:00"))).codes).toContain("max_duration_exceeded");
    // ... while approving the old one still charges what it was priced at
    const before = await balanceOf("a");
    await leave.decide(hr, old.request.id, { decision: "approved" });
    const after = await balanceOf("a");
    expect(after.used - before.used).toBe(2.5);
    expect(after.reserved).toBe(before.reserved - 2.5);
    await configure();
  });

  it("keeps the rules per company: another company sees none of this and cannot reach these employees", async () => {
    const mine = await rules.list(hr);
    expect(mine.filter((r) => r.isSystem)).toHaveLength(20);
    const other = await rules.list(otherHr);
    expect(other.some((r) => mine.some((m) => m.id === r.id))).toBe(false);
    await expect(rules.get(otherHr, mine[0].id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(rules.update(otherHr, mine[0].id, { priority: 7 })).rejects.toBeInstanceOf(NotFoundException);
    // their own settings are untouched by ours
    const theirs = await settings.list(otherHr, "short_leave");
    expect(theirs.every((s) => s.id === null || s.leavePolicyId !== null || s.maxDurationMinutes === null)).toBe(true);
    // their employee cannot book our type or our people
    expect((await refusal(leave.submit(otherStaff, { employeeId: otherEmployeeId, leaveType: "short_leave", startDate: "2027-08-02", endDate: "2027-08-02", dayPart: "hours", startTime: "10:00", endTime: "11:00" }))).codes).toContain("leave_type_unavailable");
    await expect(leave.validate(otherStaff, timed("a", "2027-08-02", "10:00", "11:00"))).rejects.toBeInstanceOf(HttpException);
    await expect(leave.previewRule(otherHr, { rule: { validationType: "max_duration_exceeded", severity: "warning", message: "x", params: { maxMinutes: 5 } }, request: timed("a", "2027-08-02", "10:00", "11:00") })).rejects.toBeInstanceOf(HttpException);
  });

  it("manages rules: built-in ones cannot be deleted, safety checks keep blocking, every change is in the history", async () => {
    const all = await rules.list(hr);
    const balance = all.find((r) => r.validationType === "balance_insufficient" && r.isSystem)!;
    expect(balance.isLocked).toBe(true);
    const lowered = await rules.update(hr, balance.id, { severity: "warning", isActive: false, message: "Not enough hours left ({{available}})." });
    expect(lowered.severity).toBe("block");
    expect(lowered.isActive).toBe(true);
    expect(lowered.message).toBe("Not enough hours left ({{available}}).");
    await rules.update(hr, balance.id, { message: "Insufficient {{leaveType}} balance: requested {{requested}}, {{available}} available for {{year}}." });
    await expect(rules.remove(hr, balance.id)).rejects.toBeInstanceOf(HttpException);
    const history = await rules.history(hr, balance.id);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0].version).toBeGreaterThan(history[history.length - 1].version);

    const mine = await rules.create(hr, { code: "notice_warn", name: "Short notice", validationType: "insufficient_notice", severity: "warning", message: "Please give more notice.", params: { minNoticeMinutes: 60 }, priority: 50, conditions: { op: "and", children: [{ field: "durationMinutes", operator: "gt", value: 60 }] } });
    expect(mine).toMatchObject({ isSystem: false, severity: "warning", version: 1 });
    await expect(rules.create(hr, { code: "bad_cond", name: "x", validationType: "max_duration_exceeded", message: "x", conditions: { op: "and", children: [{ field: "nonsense" as never, operator: "gt", value: 1 }] } })).rejects.toBeInstanceOf(HttpException);
    await expect(rules.create(hr, { code: "bad_msg", name: "x", validationType: "max_duration_exceeded", message: "{{nothing_like_this}}" })).rejects.toBeInstanceOf(HttpException);
    await rules.remove(hr, mine.id);
  });

  it("can try a draft rule against a sample request without saving anything", async () => {
    await configure();
    const out = await leave.previewRule(hr, {
      rule: { validationType: "max_duration_exceeded", severity: "warning", name: "Draft cap", message: "Over 30 minutes", params: { maxMinutes: 30 }, leaveTypes: ["short_leave"] },
      request: timed("a", "2027-08-09", "10:00", "11:00"),
    });
    expect(out.draftFired).toBe(true);
    expect(out.withDraft.warnings.map((w) => w.code)).toContain("max_duration_exceeded");
    expect(out.withoutDraft.warnings).toHaveLength(0);
    expect((await rules.list(hr)).some((r) => r.name === "Draft cap")).toBe(false);
  });

  it("charges nothing for a request that is cancelled before it is decided, and records the approved hours in the ledger", async () => {
    const r = await submit("c", "2027-08-10", "09:00", "10:00");
    const held = (await balanceOf("c")).reserved;
    await leave.cancel(hr, r.request.id);
    expect((await balanceOf("c")).reserved).toBe(held - 1);
    const kept = await submit("c", "2027-08-11", "09:00", "10:30");
    await leave.decide(hr, kept.request.id, { decision: "approved" });
    const ledger = await db.withClaims(hr, (c) => c.query("SELECT entry_type, days FROM leave_ledger WHERE employee_id = $1 AND leave_type = 'short_leave' ORDER BY created_at DESC LIMIT 1", [staff.c.employeeId]));
    expect(Number(ledger.rows[0].days)).toBeCloseTo(-1.5, 5);
  });

  it("shows approved short-hours leave in attendance: the day expects fewer hours and is marked as partly on leave", async () => {
    // person C (08:00-16:00, 8 scheduled hours) was approved 09:00-10:30 on 2027-08-11 in the test above
    await evaluation.evaluate(hr, { from: "2027-08-11", to: "2027-08-11", employeeId: staff.c.employeeId });
    const row = (await db.withClaims(hr, (c) => c.query("SELECT scheduled_minutes, status, exceptions, leave_request_id FROM attendance_daily_results WHERE employee_id = $1 AND work_date = '2027-08-11'", [staff.c.employeeId]))).rows[0];
    expect(row.scheduled_minutes).toBe(480 - 90);
    expect(row.exceptions).toContain("partial_leave");
    expect(row.status).not.toBe("on_leave");
    expect(row.leave_request_id).not.toBeNull();
  });
});
