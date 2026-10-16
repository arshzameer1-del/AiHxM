import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EmployeesService } from "../employees/employees.service";
import { EmployeeGroupsService } from "../employee-groups/employee-groups.service";
import { WorkflowService } from "../workflow/workflow.service";
import { WorkflowAdapterRegistry } from "../workflow/workflow-adapter.registry";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { ShiftsService } from "../shifts/shifts.service";
import { WorkScheduleResolutionService } from "../shifts/work-schedule-resolution.service";
import { HolidaysService } from "../holidays/holidays.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { RulesEngine } from "../rules-engine/rules-engine.engine";
import { LeaveRequestsService } from "./leave-requests.service";
import { AttendanceEvaluationService, scheduledMinutesOf, localParts } from "./attendance-evaluation.service";
import { AttendanceDevicesService, hashDeviceKey } from "./attendance-devices.service";
import { DeviceKeyGuard } from "./device-key.guard";
import { TimesheetsService, weekStart } from "./timesheets.service";
import { AttendanceService } from "./attendance.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "attendance-step8-fixtures" };

/** Gap Register TLM-04 / TLM-05 / TLM-06 against real Postgres. */
describe("Attendance daily results, devices and timesheets (Step 8B)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let evaluation: AttendanceEvaluationService;
  let devices: AttendanceDevicesService;
  let timesheets: TimesheetsService;
  let leave: LeaveRequestsService;
  let attendance: AttendanceService;
  let workflow: WorkflowService;
  let companyId: string;
  let hr: RequestClaims;
  let managerClaims: RequestClaims;
  let staffClaims: RequestClaims;
  let otherClaims: RequestClaims;
  let managerEmployeeId: string;
  let staffEmployeeId: string;
  let staffNumber: string;
  let otherEmployeeId: string;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const sql = <T = Record<string, unknown>>(q: string, p: unknown[] = []) => db.withClaims(FIXTURE, async (c) => (await c.query(q, p)).rows as T[]);

  /** A punch pair on `date` at Karachi local `inHm` / `outHm` (UTC+5, no DST). */
  async function punch(employeeId: string, date: string, inHm: string, outHm: string | null) {
    const toUtc = (hm: string) => new Date(`${date}T${hm}:00+05:00`);
    await sql(
      `INSERT INTO attendance_records (company_id, employee_id, employee_number, source, clock_in_at, clock_out_at, work_date)
       SELECT $1, e.id, e.employee_number, 'manual', $3, $4, $5 FROM employees e WHERE e.id = $2`,
      [companyId, employeeId, toUtc(inHm), outHm ? toUtc(outHm) : null, date]
    );
  }
  async function dayResult(employeeId: string, date: string) {
    const rows = await sql<Record<string, unknown>>("SELECT * FROM attendance_daily_results WHERE employee_id = $1 AND work_date = $2", [employeeId, date]);
    return rows[0];
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    const eff = new EffectiveDatingEngine();
    const employees = new EmployeesService(db, rbac, ent, audit, new LocalFileStorageService());
    const groups = new EmployeeGroupsService(db, rbac, ent, eff, new RulesEngine());
    workflow = new WorkflowService(db, rbac, audit, new WorkflowAdapterRegistry());
    const holidays = new HolidaysService(db, rbac, ent, audit);
    const shifts = new ShiftsService(db, rbac, ent, audit, eff, new RulesEngine());
    const schedule = new WorkScheduleResolutionService(db, shifts, holidays);
    leave = new LeaveRequestsService(db, rbac, ent, audit, groups, workflow, schedule);
    attendance = new AttendanceService(db, rbac, ent, audit, schedule);
    evaluation = new AttendanceEvaluationService(db, rbac, ent, audit, schedule);
    devices = new AttendanceDevicesService(db, rbac, ent, audit);
    timesheets = new TimesheetsService(db, rbac, ent, audit, workflow);

    companyId = await db.withClaims(FIXTURE, async (c) => {
      const co = await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Att8 ${stamp}`, `att8-${stamp}`]);
      await c.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format) VALUES ($1, '["employee","leave"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [co.rows[0].id]
      );
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true),($1,'leave',true)", [co.rows[0].id]);
      return co.rows[0].id as string;
    });
    const mk = async (label: string, roles: string[]) =>
      db.withClaims(FIXTURE, async (c) => {
        const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`a8-${label}-${stamp}@example.com`]);
        for (const role of roles) {
          await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE key=$3))", [u.rows[0].id, companyId, role]);
        }
        return { claims: { is_platform_admin: false, company_id: companyId, sub: u.rows[0].id } as RequestClaims, uid: u.rows[0].id as string };
      });
    const hrU = await mk("hr", ["hr_admin", "rbac_demo_full_access"]);
    const mgrU = await mk("mgr", ["line_manager", "employee_self_service"]);
    const staffU = await mk("staff", ["employee_self_service"]);
    const otherU = await mk("other", ["employee_self_service"]);
    hr = hrU.claims;
    managerClaims = mgrU.claims;
    staffClaims = staffU.claims;
    otherClaims = otherU.claims;
    managerEmployeeId = (await employees.create(hr, { firstName: "Maya", lastName: "Manager", userAccountId: mgrU.uid })).id;
    const staff = await employees.create(hr, { firstName: "Sam", lastName: "Staff", managerId: managerEmployeeId, userAccountId: staffU.uid });
    staffEmployeeId = staff.id;
    staffNumber = staff.employeeNumber;
    otherEmployeeId = (await employees.create(hr, { firstName: "Olu", lastName: "Other", managerId: managerEmployeeId, userAccountId: otherU.uid })).id;
    await groups.createLeavePolicy(hr, { name: "Default", annualLeaveDays: 14, casualLeaveDays: 10, sickLeaveDays: 8, isDefault: true });
    await workflow.createTemplate(hr, {
      key: "leave_request", name: "Leave Approval", objectKey: "leave_request",
      steps: [{ stepOrder: 1, name: "Manager", approvers: [{ approverType: "manager_of_submitter" }] }],
    });

    // Shift 09:00-18:00, 10 minute graces; Sunday is a rest day.
    const shift = await shifts.createShift(hr, { name: "Office", startTime: "09:00", endTime: "18:00", graceMinutesLate: 10, graceMinutesEarly: 10, isDefault: true });
    await shifts.setWeeklyPattern(hr, shift.id, {
      days: [0, 1, 2, 3, 4, 5, 6].map((d) => (d === 0 ? { dayOfWeek: d, isWorking: false } : { dayOfWeek: d, isWorking: true, startTime: "09:00", endTime: "18:00" })),
    });
    await holidays.createHoliday(hr, { name: "Test Holiday", holidayDate: "2027-03-09" });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  describe("helpers", () => {
    it("reads clock time in the schedule's own time zone and computes scheduled minutes with unpaid breaks removed", () => {
      expect(localParts(new Date("2027-03-01T04:05:00Z"), "Asia/Karachi")).toEqual({ date: "2027-03-01", minutes: 9 * 60 + 5 });
      expect(localParts(new Date("2027-03-01T20:00:00Z"), "Asia/Karachi")).toEqual({ date: "2027-03-02", minutes: 60 });
      const day = {
        isWorking: true, isMandatoryHoliday: false, startTime: "09:00", endTime: "18:00", crossesMidnight: false,
        breaks: [{ id: "b", startTime: "13:00", endTime: "14:00", isPaid: false }, { id: "p", startTime: "11:00", endTime: "11:15", isPaid: true }],
      } as unknown as Parameters<typeof scheduledMinutesOf>[0];
      expect(scheduledMinutesOf(day)).toBe(480);
      expect(weekStart("2027-03-03")).toBe("2027-03-01");
      expect(weekStart("2027-03-07")).toBe("2027-03-01");
      expect(weekStart("2027-03-08")).toBe("2027-03-08");
    });
  });

  describe("TLM-04 daily results", () => {
    it("clock-in stamps the work date and shift on the raw record", async () => {
      const rec = await attendance.clockIn(staffClaims, { employeeNumber: staffNumber, source: "manual" });
      const [row] = await sql<{ work_date: Date; shift_id: string | null; geofence_result: string; approval_state: string }>(
        "SELECT work_date, shift_id, geofence_result, approval_state FROM attendance_records WHERE id = $1", [rec.id]
      );
      expect(row.work_date).toBeTruthy();
      expect(row.shift_id).not.toBeNull();
      expect([row.geofence_result, row.approval_state]).toEqual(["not_applicable", "auto_approved"]);
      const out = await attendance.clockOut(staffClaims, { employeeNumber: staffNumber });
      expect(out.clockOutAt).not.toBeNull();
      const [after] = await sql<{ derived_status: string | null }>("SELECT derived_status FROM attendance_records WHERE id = $1", [rec.id]);
      expect(after.derived_status).not.toBeNull();
      await sql("DELETE FROM attendance_records WHERE id = $1", [rec.id]); // keep the March fixtures clean
    });

    it("turns punches, the schedule, holidays and leave into one processed row per day", async () => {
      await punch(staffEmployeeId, "2027-03-01", "09:05", "18:00"); // Mon: inside grace
      await punch(staffEmployeeId, "2027-03-02", "09:30", "18:00"); // Tue: late
      await punch(staffEmployeeId, "2027-03-03", "09:00", "17:00"); // Wed: early out
      await punch(staffEmployeeId, "2027-03-04", "09:20", "16:30"); // Thu: both
      // Fri 03-05: nothing -> absent;  Sat 03-06: approved annual leave;  Sun 03-07: rest day
      const sub = await leave.submit(staffClaims, { employeeId: staffEmployeeId, leaveType: "annual", startDate: "2027-03-06", endDate: "2027-03-06" });
      await leave.decide(managerClaims, sub.request.id, { decision: "approved" });
      const half = await leave.submit(staffClaims, { employeeId: staffEmployeeId, leaveType: "casual", startDate: "2027-03-08", endDate: "2027-03-08", dayPart: "first_half" });
      await leave.decide(managerClaims, half.request.id, { decision: "approved" });
      // Tue 03-09 is a holiday; Wed 03-10: clocked in, never out.
      await punch(staffEmployeeId, "2027-03-10", "09:00", null);

      const r = await evaluation.run({ from: "2027-03-01", to: "2027-03-10", companyId, employeeId: staffEmployeeId });
      expect(r.days).toBe(10);

      expect(await dayResult(staffEmployeeId, "2027-03-01")).toMatchObject({ status: "present", worked_minutes: 535, scheduled_minutes: 540, late_minutes: 0, early_leave_minutes: 0, punch_count: 1 });
      expect(await dayResult(staffEmployeeId, "2027-03-02")).toMatchObject({ status: "late", late_minutes: 30, early_leave_minutes: 0 });
      expect(await dayResult(staffEmployeeId, "2027-03-03")).toMatchObject({ status: "early_departure", early_leave_minutes: 60, late_minutes: 0 });
      expect(await dayResult(staffEmployeeId, "2027-03-04")).toMatchObject({ status: "late_and_early", late_minutes: 20, early_leave_minutes: 90 });
      expect(await dayResult(staffEmployeeId, "2027-03-05")).toMatchObject({ status: "absent", worked_minutes: 0, scheduled_minutes: 540 });
      const leaveDay = await dayResult(staffEmployeeId, "2027-03-06");
      expect(leaveDay).toMatchObject({ status: "on_leave", leave_request_id: sub.request.id });
      expect(await dayResult(staffEmployeeId, "2027-03-07")).toMatchObject({ status: "rest_day", scheduled_minutes: 0 });
      expect(await dayResult(staffEmployeeId, "2027-03-08")).toMatchObject({ status: "half_day", leave_request_id: half.request.id });
      expect(await dayResult(staffEmployeeId, "2027-03-09")).toMatchObject({ status: "holiday", scheduled_minutes: 0 });
      expect(await dayResult(staffEmployeeId, "2027-03-10")).toMatchObject({ status: "present", worked_minutes: 0, exceptions: ["missing_clock_out"] });
    });

    it("is idempotent, and punches on a rest day keep the rest-day status but record the work", async () => {
      await punch(staffEmployeeId, "2027-03-14", "10:00", "13:00"); // Sunday
      await evaluation.run({ from: "2027-03-14", to: "2027-03-14", companyId, employeeId: staffEmployeeId });
      const first = await dayResult(staffEmployeeId, "2027-03-14");
      expect(first).toMatchObject({ status: "rest_day", worked_minutes: 180, exceptions: ["unscheduled_work"] });
      await evaluation.run({ from: "2027-03-14", to: "2027-03-14", companyId, employeeId: staffEmployeeId });
      const rows = await sql("SELECT 1 FROM attendance_daily_results WHERE employee_id = $1 AND work_date = '2027-03-14'", [staffEmployeeId]);
      expect(rows).toHaveLength(1);
      expect((await dayResult(staffEmployeeId, "2027-03-14"))!.id).toBe(first!.id);
    });

    it("HR overrides a day with a reason; the job never overwrites it; the audit trail keeps it", async () => {
      await expect(evaluation.override(staffClaims, { employeeId: staffEmployeeId, workDate: "2027-03-05", status: "present", reason: "x" })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(evaluation.override(hr, { employeeId: staffEmployeeId, workDate: "2027-03-05", status: "present", reason: " " })).rejects.toBeInstanceOf(BadRequestException);
      const o = await evaluation.override(hr, { employeeId: staffEmployeeId, workDate: "2027-03-05", status: "present", reason: "Device was offline, supervisor confirmed" });
      expect(o).toMatchObject({ status: "present", isOverridden: true, overrideReason: "Device was offline, supervisor confirmed" });
      await evaluation.run({ from: "2027-03-05", to: "2027-03-05", companyId, employeeId: staffEmployeeId });
      expect(await dayResult(staffEmployeeId, "2027-03-05")).toMatchObject({ status: "present", is_overridden: true, source: "manual_override" });
      const audited = await sql("SELECT 1 FROM audit_log WHERE company_id = $1 AND action = 'attendance.day_override'", [companyId]);
      expect(audited.length).toBeGreaterThan(0);
    });

    it("reads are scoped: self, direct manager and HR can read; a colleague cannot; the period summary adds up", async () => {
      const own = await evaluation.list(staffClaims, { employeeId: staffEmployeeId, from: "2027-03-01", to: "2027-03-10" });
      expect(own).toHaveLength(10);
      await expect(evaluation.list(managerClaims, { employeeId: staffEmployeeId, from: "2027-03-01", to: "2027-03-10" })).resolves.toHaveLength(10);
      await expect(evaluation.list(otherClaims, { employeeId: staffEmployeeId, from: "2027-03-01", to: "2027-03-10" })).rejects.toBeInstanceOf(ForbiddenException);
      const summary = await evaluation.summary(hr, staffEmployeeId, "2027-03-01", "2027-03-10");
      expect(summary.days).toBe(10);
      expect(summary.byStatus).toMatchObject({ present: 3, late: 1, early_departure: 1, late_and_early: 1, on_leave: 1, rest_day: 1, half_day: 1, holiday: 1, absent: 0 });
      expect(summary.lateMinutes).toBe(50);
      expect(summary.earlyLeaveMinutes).toBe(150);
      await expect(evaluation.evaluate(staffClaims, { from: "2027-03-01", to: "2027-03-02" })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(evaluation.evaluate(hr, { from: "2027-01-01", to: "2027-12-31" })).rejects.toThrow(/limited/);
    });

    it("Team Attendance (B1): a manager sees their reports with summary and last-day status; others see nobody; bad windows are refused", async () => {
      const view = await evaluation.team(managerClaims, "2027-03-01", "2027-03-10");
      const mine = view.members.find((m) => m.employeeId === staffEmployeeId);
      expect(mine).toBeDefined();
      expect(mine!.employeeNumber).toBe(staffNumber);
      expect(mine!.summary.days).toBe(10);
      expect(mine!.lastDayStatus).not.toBeNull();
      // nobody reports to the colleague, so their team is empty and they cannot see someone else's team
      expect((await evaluation.team(otherClaims, "2027-03-01", "2027-03-10")).members.find((m) => m.employeeId === staffEmployeeId)).toBeUndefined();
      await expect(evaluation.team(managerClaims, "2027-03-10", "2027-03-01")).rejects.toThrow(/before/);
      await expect(evaluation.team(managerClaims, "2027-01-01", "2027-12-31")).rejects.toThrow(/93 days/);
      await expect(evaluation.team(managerClaims, "garbage", "2027-03-01")).rejects.toThrow(/YYYY-MM-DD/);
    });
  });

  describe("TLM-05 devices and punch ingestion", () => {
    let deviceId: string;
    let deviceKey: string;
    const iso = (hm: string) => `2026-03-02T${hm}:00Z`;

    it("creates a device, shows the key once, and authenticates only with that key", async () => {
      await expect(devices.createDevice(staffClaims, { name: "Gate" })).rejects.toBeInstanceOf(ForbiddenException);
      const created = await devices.createDevice(hr, { name: "Main gate", deviceType: "face", serialNumber: `SN-${stamp}` });
      deviceId = created.id;
      deviceKey = created.apiKey;
      expect(deviceKey).toMatch(/^dk_[0-9a-f]{48}$/);
      expect(created).toMatchObject({ hasApiKey: true, deviceType: "face", isActive: true });
      const [stored] = await sql<{ api_key_hash: string }>("SELECT api_key_hash FROM attendance_devices WHERE id = $1", [deviceId]);
      expect(stored.api_key_hash).toBe(hashDeviceKey(deviceKey));
      expect(JSON.stringify(await devices.listDevices(hr))).not.toContain(deviceKey);
      await expect(devices.createDevice(hr, { name: "Main gate" })).rejects.toBeInstanceOf(ConflictException);
      await expect(devices.createDevice(hr, { name: "Other", serialNumber: `SN-${stamp}` })).rejects.toBeInstanceOf(ConflictException);

      expect(await devices.authenticate(deviceId, deviceKey)).toEqual({ companyId });
      expect(await devices.authenticate(deviceId, "dk_wrong")).toBeNull();
      expect(await devices.authenticate("not-a-uuid", deviceKey)).toBeNull();
      const guard = new DeviceKeyGuard(devices);
      const ctx = (key?: string) => ({ switchToHttp: () => ({ getRequest: () => ({ headers: key ? { "x-device-key": key } : {}, params: { deviceId } }) }) }) as never;
      await expect(guard.canActivate(ctx(deviceKey))).resolves.toBe(true);
      await expect(guard.canActivate(ctx("dk_nope"))).rejects.toThrow(/Invalid device credentials/);
      await expect(guard.canActivate(ctx())).rejects.toThrow(/Invalid device credentials/);

      const rotated = await devices.rotateKey(hr, deviceId);
      expect(await devices.authenticate(deviceId, deviceKey)).toBeNull();
      expect(await devices.authenticate(deviceId, rotated.apiKey)).toEqual({ companyId });
      deviceKey = rotated.apiKey;
      await devices.updateDevice(hr, deviceId, { isActive: false });
      expect(await devices.authenticate(deviceId, deviceKey)).toBeNull();
      await devices.updateDevice(hr, deviceId, { isActive: true });
    });

    it("enrols device users, refusing a clash, and turns a punch batch into clock-in / clock-out records exactly once", async () => {
      // Earlier tests left an open web clock-in for this employee; close it so the device starts clean.
      await sql("UPDATE attendance_records SET clock_out_at = clock_in_at + interval '1 hour' WHERE employee_id = $1 AND clock_out_at IS NULL AND device_id IS NULL AND clock_in_at > now() - interval '1 day'", [staffEmployeeId]);
      await devices.enroll(hr, deviceId, { employeeId: staffEmployeeId, deviceUserId: "17" });
      await expect(devices.enroll(hr, deviceId, { employeeId: otherEmployeeId, deviceUserId: "17" })).rejects.toBeInstanceOf(ConflictException);
      await expect(devices.enroll(hr, deviceId, { employeeId: staffEmployeeId, deviceUserId: "18" })).rejects.toBeInstanceOf(ConflictException);

      const batch = [
        { deviceUserId: "17", punchedAt: iso("04:00"), direction: "in" as const },
        { deviceUserId: "17", punchedAt: iso("13:00"), direction: "out" as const },
      ];
      const first = await devices.ingest(companyId, deviceId, batch);
      expect(first).toEqual({ received: 2, processed: 2, duplicates: 0, unmatched: 0, rejected: 0 });
      const records = await sql<{ source: string; device_id: string; work_date: Date; clock_out_at: Date | null }>(
        "SELECT source, device_id, work_date, clock_out_at FROM attendance_records WHERE employee_id = $1 AND device_id = $2", [staffEmployeeId, deviceId]
      );
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ source: "biometric", device_id: deviceId });
      expect(records[0].clock_out_at).not.toBeNull();
      expect(records[0].work_date.toISOString().slice(0, 10)).toBe("2026-03-02");

      // The device re-sends the whole batch after a network drop: nothing new.
      const again = await devices.ingest(companyId, deviceId, batch);
      expect(again).toEqual({ received: 2, processed: 0, duplicates: 2, unmatched: 0, rejected: 0 });
      expect(await sql("SELECT 1 FROM attendance_records WHERE employee_id = $1 AND device_id = $2", [staffEmployeeId, deviceId])).toHaveLength(1);
      expect(await sql("SELECT 1 FROM raw_punches WHERE device_id = $1", [deviceId])).toHaveLength(2);

      // The device's own event id is the idempotency key when present.
      const ext = await devices.ingest(companyId, deviceId, [{ deviceUserId: "17", punchedAt: iso("04:00"), direction: "in", externalId: "evt-1" }]);
      expect(ext.duplicates).toBe(1); // new key, but inside the double-tap window of the existing in-punch
    });

    it("double taps, orphan clock-outs, future punches and unknown users are classified, not lost", async () => {
      const res = await devices.ingest(companyId, deviceId, [
        { deviceUserId: "17", punchedAt: "2026-03-03T04:00:00Z", direction: "in" },
        { deviceUserId: "17", punchedAt: "2026-03-03T04:00:30Z", direction: "in" }, // double tap
        { deviceUserId: "17", punchedAt: "2026-03-03T13:00:00Z" }, // unknown direction with an open record -> out
        { deviceUserId: "17", punchedAt: "2026-03-04T13:00:00Z", direction: "out" }, // out with nothing open
        { deviceUserId: "17", punchedAt: "2099-01-01T00:00:00Z", direction: "in" }, // future
        { deviceUserId: "99", punchedAt: "2026-03-03T04:10:00Z", direction: "in" }, // not enrolled
      ]);
      expect(res).toEqual({ received: 6, processed: 2, duplicates: 1, unmatched: 1, rejected: 2 });
      const byStatus = await sql<{ status: string; n: string }>("SELECT status, count(*) AS n FROM raw_punches WHERE device_id = $1 GROUP BY status", [deviceId]);
      const counts = Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)]));
      expect(counts).toMatchObject({ processed: 4, duplicate: 2, unmatched: 1, rejected: 2 });
      const unmatched = await devices.listPunches(hr, { deviceId, status: "unmatched" });
      expect(unmatched).toHaveLength(1);
      expect(unmatched[0]).toMatchObject({ deviceUserId: "99", error: expect.stringContaining("No active enrolment") });
    });

    it("enrolling the unknown user afterwards processes their waiting punches; revoking stops further matching", async () => {
      const { enrollment, reprocessed } = await devices.enroll(hr, deviceId, { employeeId: otherEmployeeId, deviceUserId: "99" });
      expect(reprocessed).toBe(1);
      expect(await sql("SELECT 1 FROM attendance_records WHERE employee_id = $1 AND device_id = $2", [otherEmployeeId, deviceId])).toHaveLength(1);
      await devices.revokeEnrollment(hr, deviceId, enrollment.id);
      const res = await devices.ingest(companyId, deviceId, [{ deviceUserId: "99", punchedAt: "2026-03-05T04:00:00Z", direction: "in" }]);
      expect(res.unmatched).toBe(1);
      await expect(devices.ingest(companyId, deviceId, [])).rejects.toBeInstanceOf(BadRequestException);
    });

    it("device records feed the daily result like any other punch", async () => {
      await sql("UPDATE employees SET date_of_joining = '2026-01-01' WHERE id = $1", [staffEmployeeId]);
      await evaluation.run({ from: "2026-03-02", to: "2026-03-02", companyId, employeeId: staffEmployeeId });
      expect(await dayResult(staffEmployeeId, "2026-03-02")).toMatchObject({ status: expect.stringMatching(/present|late|early_departure|late_and_early/), punch_count: 1, worked_minutes: 540 });
    });
  });

  describe("TLM-06 timesheets", () => {
    let sheetId: string;

    it("opens the ISO week as a draft, validates entries, and shows what attendance recorded", async () => {
      const sheet = await timesheets.getOrCreate(staffClaims, staffEmployeeId, "2027-03-03");
      sheetId = sheet.id;
      expect(sheet).toMatchObject({ periodStart: "2027-03-01", periodEnd: "2027-03-07", status: "draft", totalMinutes: 0 });
      expect(sheet.recordedMinutesByDay["2027-03-01"]).toBe(535);
      expect((await timesheets.getOrCreate(staffClaims, staffEmployeeId, "2027-03-07")).id).toBe(sheetId);
      await expect(timesheets.getOrCreate(otherClaims, staffEmployeeId, "2027-03-03")).rejects.toBeInstanceOf(NotFoundException);

      await expect(timesheets.saveEntries(staffClaims, sheetId, { entries: [{ workDate: "2027-03-08", minutes: 60 }] })).rejects.toThrow(/outside this timesheet's week/);
      await expect(timesheets.saveEntries(staffClaims, sheetId, { entries: [{ workDate: "2027-03-02", minutes: 900 }, { workDate: "2027-03-02", minutes: 600 }] })).rejects.toThrow(/more than 24 hours/);
      await expect(timesheets.saveEntries(staffClaims, sheetId, { entries: [{ workDate: "2027-03-02", minutes: 30, costCenterId: "00000000-0000-0000-0000-000000000000" }] })).rejects.toThrow(/cost centres/);
      await expect(timesheets.submit(staffClaims, sheetId)).rejects.toThrow(/at least one entry/);

      const saved = await timesheets.saveEntries(staffClaims, sheetId, {
        entries: [
          { workDate: "2027-03-01", minutes: 300, taskRef: "PRJ-1", description: "Build" },
          { workDate: "2027-03-01", minutes: 235, taskRef: "PRJ-2" },
          { workDate: "2027-03-02", minutes: 480 },
        ],
      });
      expect(saved.totalMinutes).toBe(1015);
      expect(saved.entries).toHaveLength(3);
      // Replacing is a replace, not an append.
      const replaced = await timesheets.saveEntries(staffClaims, sheetId, { entries: [{ workDate: "2027-03-01", minutes: 535 }, { workDate: "2027-03-02", minutes: 480 }] });
      expect(replaced.totalMinutes).toBe(1015);
      expect(replaced.entries).toHaveLength(2);
    });

    it("without a workflow template the direct manager decides; nobody decides their own sheet; a decided sheet is final", async () => {
      const submitted = await timesheets.submit(staffClaims, sheetId);
      expect(submitted.status).toBe("pending");
      expect(submitted.workflowInstanceId).toBeNull();
      await expect(timesheets.saveEntries(staffClaims, sheetId, { entries: [{ workDate: "2027-03-01", minutes: 10 }] })).rejects.toBeInstanceOf(ConflictException);
      await expect(timesheets.decide(staffClaims, sheetId, { decision: "approved" })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(timesheets.decide(otherClaims, sheetId, { decision: "approved" })).rejects.toBeInstanceOf(ForbiddenException);
      const pending = await timesheets.list(managerClaims, { forApproval: true });
      expect(pending.map((t) => t.id)).toContain(sheetId);
      expect(await timesheets.list(otherClaims, {})).toHaveLength(0);

      const approved = await timesheets.decide(managerClaims, sheetId, { decision: "approved", comment: "ok" });
      expect(approved).toMatchObject({ status: "approved", decisionComment: "ok" });
      await expect(timesheets.decide(managerClaims, sheetId, { decision: "rejected" })).rejects.toBeInstanceOf(ConflictException);
      await expect(timesheets.cancel(staffClaims, sheetId)).rejects.toBeInstanceOf(ConflictException);
    });

    it("with an active timesheet workflow the sheet is routed through the engine, can be sent back, edited and resubmitted", async () => {
      await workflow.createTemplate(hr, {
        key: "timesheet_approval", name: "Timesheet approval", objectKey: "timesheet",
        steps: [{ stepOrder: 1, name: "Manager", approvers: [{ approverType: "manager_of_submitter" }] }],
      });
      const sheet = await timesheets.getOrCreate(staffClaims, staffEmployeeId, "2027-03-10");
      await timesheets.saveEntries(staffClaims, sheet.id, { entries: [{ workDate: "2027-03-10", minutes: 240 }] });
      const submitted = await timesheets.submit(staffClaims, sheet.id);
      expect(submitted.status).toBe("pending");
      expect(submitted.workflowInstanceId).not.toBeNull();

      const instance = await workflow.getInstance(managerClaims, submitted.workflowInstanceId!);
      const step = instance.steps.find((s) => s.status === "pending")!;
      await workflow.decide(managerClaims, step.id, { decision: "send_back", comment: "Add the afternoon" });
      const returned = await timesheets.get(staffClaims, sheet.id);
      expect(returned.status).toBe("returned");

      await timesheets.saveEntries(staffClaims, sheet.id, { entries: [{ workDate: "2027-03-10", minutes: 240 }, { workDate: "2027-03-10", minutes: 240, taskRef: "PM" }] });
      const resubmitted = await timesheets.submit(staffClaims, sheet.id);
      expect(resubmitted.status).toBe("pending");
      expect(resubmitted.workflowInstanceId).toBe(submitted.workflowInstanceId);

      const approved = await timesheets.decide(managerClaims, sheet.id, { decision: "approved" });
      expect(approved).toMatchObject({ status: "approved", totalMinutes: 480 });
      const audited = await sql("SELECT 1 FROM audit_log WHERE company_id = $1 AND action IN ('timesheet.approved','timesheet.returned')", [companyId]);
      expect(audited.length).toBeGreaterThanOrEqual(2);
    });
  });
});
