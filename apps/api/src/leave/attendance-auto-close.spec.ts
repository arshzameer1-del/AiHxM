import { Pool } from "pg";
import { ConflictException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EmployeesService } from "../employees/employees.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { ShiftsService } from "../shifts/shifts.service";
import { WorkScheduleResolutionService } from "../shifts/work-schedule-resolution.service";
import { HolidaysService } from "../holidays/holidays.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { RulesEngine } from "../rules-engine/rules-engine.engine";
import { localParts } from "./attendance-evaluation.service";
import { AttendanceDevicesService } from "./attendance-devices.service";
import { AttendanceAutoCloseService, AUTO_CLOSED_STATUS, instantOfLocalTime } from "./attendance-auto-close.service";
import { AttendanceService } from "./attendance.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "attendance-autoclose-fixtures" };

const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** A forgotten clock-out is closed at the shift end; only one clock-in and one clock-out is allowed per day. */
describe("Attendance auto clock-out and one punch pair per day", () => {
  let pool: Pool;
  let db: DatabaseService;
  let attendance: AttendanceService;
  let autoClose: AttendanceAutoCloseService;
  let devices: AttendanceDevicesService;
  let companyId: string;
  let hr: RequestClaims;
  let staffClaims: RequestClaims;
  let staffEmployeeId: string;
  let staffNumber: string;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const sql = <T = Record<string, unknown>>(q: string, p: unknown[] = []) => db.withClaims(FIXTURE, async (c) => (await c.query(q, p)).rows as T[]);
  const today = () => localParts(new Date(), "Asia/Karachi").date;
  /** The most recent working (non-Sunday) day before today. */
  const lastWorkingDay = () => {
    let d = addDays(today(), -1);
    while (dow(d) === 0) d = addDays(d, -1);
    return d;
  };
  const at = (date: string, hm: string) => new Date(`${date}T${hm}:00+05:00`);
  async function openRecord(date: string, inHm: string) {
    const rows = await sql<{ id: string }>(
      `INSERT INTO attendance_records (company_id, employee_id, employee_number, source, clock_in_at, work_date)
       SELECT $1, e.id, e.employee_number, 'manual', $3, $4 FROM employees e WHERE e.id = $2 RETURNING id`,
      [companyId, staffEmployeeId, at(date, inHm), date]
    );
    return rows[0].id;
  }
  const record = async (id: string) => (await sql<{ clock_out_at: Date | null; derived_status: string | null }>("SELECT clock_out_at, derived_status FROM attendance_records WHERE id = $1", [id]))[0];

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    const eff = new EffectiveDatingEngine();
    const employees = new EmployeesService(db, rbac, ent, audit, new LocalFileStorageService());
    const holidays = new HolidaysService(db, rbac, ent, audit);
    const shifts = new ShiftsService(db, rbac, ent, audit, eff, new RulesEngine());
    const schedule = new WorkScheduleResolutionService(db, shifts, holidays);
    autoClose = new AttendanceAutoCloseService(db, audit, schedule);
    attendance = new AttendanceService(db, rbac, ent, audit, schedule, autoClose);
    devices = new AttendanceDevicesService(db, rbac, ent, audit);

    companyId = await db.withClaims(FIXTURE, async (c) => {
      const co = await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`AutoClose ${stamp}`, `autoclose-${stamp}`]);
      await c.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format) VALUES ($1, '["employee","leave"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [co.rows[0].id]
      );
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true),($1,'leave',true)", [co.rows[0].id]);
      return co.rows[0].id as string;
    });
    const mk = async (label: string, roles: string[]) =>
      db.withClaims(FIXTURE, async (c) => {
        const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`ac-${label}-${stamp}@example.com`]);
        for (const role of roles) {
          await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE key=$3))", [u.rows[0].id, companyId, role]);
        }
        return { claims: { is_platform_admin: false, company_id: companyId, sub: u.rows[0].id } as RequestClaims, uid: u.rows[0].id as string };
      });
    const hrU = await mk("hr", ["hr_admin", "rbac_demo_full_access"]);
    const staffU = await mk("staff", ["employee_self_service"]);
    hr = hrU.claims;
    staffClaims = staffU.claims;
    const staff = await employees.create(hr, { firstName: "Sam", lastName: "Staff", userAccountId: staffU.uid });
    staffEmployeeId = staff.id;
    staffNumber = staff.employeeNumber;

    // Shift 09:00-18:00 Monday-Saturday; Sunday is a rest day.
    const shift = await shifts.createShift(hr, { name: "Office", startTime: "09:00", endTime: "18:00", isDefault: true });
    await shifts.setWeeklyPattern(hr, shift.id, {
      days: [0, 1, 2, 3, 4, 5, 6].map((d) => (d === 0 ? { dayOfWeek: d, isWorking: false } : { dayOfWeek: d, isWorking: true, startTime: "09:00", endTime: "18:00" })),
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  beforeEach(async () => {
    await sql("DELETE FROM attendance_records WHERE employee_id = $1", [staffEmployeeId]);
  });

  it("turns Karachi wall-clock times into instants", () => {
    expect(instantOfLocalTime("2027-03-01", "18:00", "Asia/Karachi").toISOString()).toBe("2027-03-01T13:00:00.000Z");
    expect(instantOfLocalTime("2027-03-02", "02:30", "Asia/Karachi").toISOString()).toBe("2027-03-01T21:30:00.000Z");
  });

  it("a forgotten clock-out from an earlier day is set to that day's shift end time", async () => {
    const day = lastWorkingDay();
    const id = await openRecord(day, "09:05");
    const closed = await db.withClaims(staffClaims, (c) => autoClose.closeForgottenForEmployee(c, staffClaims, staffEmployeeId));
    expect(closed).toBe(1);
    const rec = await record(id);
    expect(rec.clock_out_at?.toISOString()).toBe(at(day, "18:00").toISOString());
    expect(rec.derived_status).toBe(AUTO_CLOSED_STATUS);
    const audits = await sql("SELECT 1 FROM audit_log WHERE target = $1 AND action = 'attendance.auto_clock_out'", [id]);
    expect(audits).toHaveLength(1);
  });

  it("never touches today's open clock-in", async () => {
    const id = await openRecord(today(), "09:00");
    const closed = await db.withClaims(staffClaims, (c) => autoClose.closeForgottenForEmployee(c, staffClaims, staffEmployeeId));
    expect(closed).toBe(0);
    expect((await record(id)).clock_out_at).toBeNull();
  });

  it("a rest day has no shift end, so nothing is invented", async () => {
    let sunday = addDays(today(), -1);
    while (dow(sunday) !== 0) sunday = addDays(sunday, -1);
    const id = await openRecord(sunday, "10:00");
    const closed = await db.withClaims(staffClaims, (c) => autoClose.closeForgottenForEmployee(c, staffClaims, staffEmployeeId));
    expect(closed).toBe(0);
    expect((await record(id)).clock_out_at).toBeNull();
  });

  it("the hourly sweep closes forgotten clock-outs for the company", async () => {
    const id = await openRecord(lastWorkingDay(), "09:00");
    const closed = await autoClose.closeAllDue();
    expect(closed).toBeGreaterThanOrEqual(1);
    expect((await record(id)).clock_out_at).not.toBeNull();
  });

  it("clocking in the next day closes yesterday's forgotten record and starts today's", async () => {
    const day = lastWorkingDay();
    const old = await openRecord(day, "09:00");
    const rec = await attendance.clockIn(staffClaims, { employeeNumber: staffNumber, source: "manual" });
    expect(rec.clockOutAt).toBeNull();
    expect((await record(old)).clock_out_at?.toISOString()).toBe(at(day, "18:00").toISOString());
  });

  it("only one clock-in and one clock-out per day", async () => {
    await attendance.clockIn(staffClaims, { employeeNumber: staffNumber, source: "manual" });
    await expect(attendance.clockIn(staffClaims, { employeeNumber: staffNumber, source: "manual" })).rejects.toThrow(/already clocked in/i);
    await attendance.clockOut(staffClaims, { employeeNumber: staffNumber });
    const again = attendance.clockIn(staffClaims, { employeeNumber: staffNumber, source: "manual" });
    await expect(again).rejects.toBeInstanceOf(ConflictException);
    await expect(again).rejects.toThrow(/one clock-in and one clock-out is allowed per day/i);
    expect(await sql("SELECT 1 FROM attendance_records WHERE employee_id = $1", [staffEmployeeId])).toHaveLength(1);
  });

  it("the attendance list marks system-closed records", async () => {
    await openRecord(lastWorkingDay(), "09:00");
    const list = await attendance.listForEmployee(staffClaims, staffEmployeeId, 10);
    expect(list[0]).toMatchObject({ autoClosed: true });
    expect(list[0].clockOutAt).not.toBeNull();
  });

  it("a device cannot start a second shift on a day that already has one", async () => {
    const dev = await devices.createDevice(hr, { name: `Gate ${stamp}` });
    await devices.enroll(hr, dev.id, { employeeId: staffEmployeeId, deviceUserId: "5" });
    const day = lastWorkingDay();
    const res = await devices.ingest(companyId, dev.id, [
      { deviceUserId: "5", punchedAt: `${day}T04:00:00Z`, direction: "in" },
      { deviceUserId: "5", punchedAt: `${day}T12:00:00Z`, direction: "out" },
      { deviceUserId: "5", punchedAt: `${day}T12:30:00Z`, direction: "in" },
    ]);
    expect(res).toMatchObject({ received: 3, processed: 2, duplicates: 1 });
    expect(await sql("SELECT 1 FROM attendance_records WHERE employee_id = $1", [staffEmployeeId])).toHaveLength(1);
  });
});
