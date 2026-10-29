import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { ShiftRotationsService, rotationWeekFor } from "../shifts/shift-rotations.service";
import { AttendancePenaltiesService } from "../attendance-penalties/attendance-penalties.service";
import { AttendanceAutoCloseService } from "./attendance-auto-close.service";
import { AttendancePolicyService, distanceMetres } from "./attendance-policy.service";
import { AttendanceService } from "./attendance.service";
import { LeaveLedgerService } from "./leave-ledger.service";

// a tiny valid JPEG header is enough: the server checks the magic bytes and the size, not the picture
const jpegUrl = (extra = 200) => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(extra, 1)]).toString("base64")}`;
const OFFICE = { lat: 31.5204, lng: 74.3587 };

/** Rotating shifts, location checks and penalty rules against real Postgres. */
describe("Attendance depth", () => {
  let f: PayrollFixture;
  let rotations: ShiftRotationsService;
  let policy: AttendancePolicyService;
  let attendance: AttendanceService;
  let penalties: AttendancePenaltiesService;
  let staff: Awaited<ReturnType<PayrollFixture["makeUser"]>>;

  const mkEmployee = async (label: string) => {
    const claims = await f.makeUser(label, ["employee_self_service"]);
    const emp = await f.createEmployee({ userAccountId: claims.uid, monthlySalary: null });
    const number = (await f.sql<{ employee_number: string }>("SELECT employee_number FROM employees WHERE id = $1", [emp.id]))[0].employee_number;
    return { claims, id: emp.id, number };
  };
  const mkShift = async (name: string, type: string, start = "09:00", end = "17:00") =>
    (await f.sql<{ id: string }>(`INSERT INTO shifts (company_id, name, start_time, end_time, schedule_type) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [f.companyId, name, start, end, type]))[0].id;

  beforeAll(async () => {
    f = await buildPayrollFixture("attd");
    const storage = new LocalFileStorageService();
    rotations = new ShiftRotationsService(f.db, f.rbac, f.entitlements, f.audit);
    policy = new AttendancePolicyService(f.db, f.rbac, f.entitlements, f.audit, storage);
    attendance = new AttendanceService(f.db, f.rbac, f.entitlements, f.audit, f.workSchedule, new AttendanceAutoCloseService(f.db, f.audit, f.workSchedule), policy);
    penalties = new AttendancePenaltiesService(f.db, f.rbac, f.entitlements, f.audit, new LeaveLedgerService(f.db, f.rbac, f.entitlements, f.audit), f.additionalPayments);
    staff = (await mkEmployee("staff-attd")).claims;
  }, 120000);

  afterAll(async () => {
    await f.cleanup();
  }, 60000);

  describe("rotating shifts", () => {
    it("the week in force repeats every cycle, before the anchor too", () => {
      expect(rotationWeekFor("2026-01-05", 2, "2026-01-05")).toBe(1);
      expect(rotationWeekFor("2026-01-05", 2, "2026-01-11")).toBe(1);
      expect(rotationWeekFor("2026-01-05", 2, "2026-01-12")).toBe(2);
      expect(rotationWeekFor("2026-01-05", 2, "2026-01-19")).toBe(1);
      expect(rotationWeekFor("2026-01-05", 3, "2025-12-29")).toBe(3);
    });

    it("an employee on the rotating schedule gets the member shift of that week", async () => {
      const container = await mkShift("Rota", "rotating");
      const morning = await mkShift("Rota Morning", "fixed", "06:00", "14:00");
      const evening = await mkShift("Rota Evening", "fixed", "14:00", "22:00");
      const e = await mkEmployee("rota");
      await f.sql("INSERT INTO shift_assignments (company_id, employee_id, shift_id, effective_from, created_by_user_account_id) VALUES ($1,$2,$3,'2020-01-01',$4)", [f.companyId, e.id, container, f.hr.sub]);

      await expect(rotations.save(staff, container, { cycleWeeks: 2, anchorDate: "2026-01-05", weeks: [{ weekNo: 1, memberShiftId: morning }, { weekNo: 2, memberShiftId: evening }] })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(rotations.save(f.hr, container, { cycleWeeks: 2, anchorDate: "2026-01-05", weeks: [{ weekNo: 1, memberShiftId: morning }] })).rejects.toThrow(/each of the 2 weeks/);
      await expect(rotations.save(f.hr, morning, { cycleWeeks: 2, anchorDate: "2026-01-05", weeks: [{ weekNo: 1, memberShiftId: container }, { weekNo: 2, memberShiftId: evening }] })).rejects.toThrow(/rotating/);
      await expect(rotations.save(f.hr, container, { cycleWeeks: 2, anchorDate: "2026-01-05", weeks: [{ weekNo: 1, memberShiftId: container }, { weekNo: 2, memberShiftId: evening }] })).rejects.toThrow(/ordinary shifts/);

      const view = await rotations.save(f.hr, container, { cycleWeeks: 2, anchorDate: "2026-01-05", weeks: [{ weekNo: 1, memberShiftId: morning }, { weekNo: 2, memberShiftId: evening }] });
      expect(view.weeks.map((w) => w.memberShiftName)).toEqual(["Rota Morning", "Rota Evening"]);

      const on = (d: string) => f.db.withClaims(f.hr, (c) => f.workSchedule.resolve(c, e.id, d));
      expect((await on("2026-03-02")).scheduleName).toBe("Rota Morning"); // week 9 of the cycle -> week 1
      expect((await on("2026-03-09")).scheduleName).toBe("Rota Evening");
      expect((await on("2026-03-09")).startTime).toMatch(/^14:00/);
      expect((await on("2026-03-16")).scheduleName).toBe("Rota Morning");

      await rotations.remove(f.hr, container);
      expect((await on("2026-03-09")).scheduleName).toBe("Rota"); // no rotation set up: the container itself applies
    });
  });

  describe("location checks", () => {
    it("distance is measured in metres", () => {
      expect(Math.round(distanceMetres(OFFICE.lat, OFFICE.lng, OFFICE.lat + 0.001, OFFICE.lng))).toBeGreaterThan(100);
      expect(Math.round(distanceMetres(OFFICE.lat, OFFICE.lng, OFFICE.lat + 0.001, OFFICE.lng))).toBeLessThan(120);
    });

    it("only HR with the permission can change the rules, and checks cannot be switched on without a place", async () => {
      await expect(policy.updatePolicy(staff, { geofenceMode: "block" })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(policy.getPolicy(staff)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(policy.updatePolicy(f.hr, { geofenceMode: "block" })).rejects.toThrow(/at least one allowed location/);
      await expect(policy.saveGeofence(f.hr, null, { name: "Bad", latitude: 120, longitude: 0, radiusM: 100 })).rejects.toBeInstanceOf(BadRequestException);
      await expect(policy.saveGeofence(f.hr, null, { name: "Tiny", latitude: 1, longitude: 1, radiusM: 5 })).rejects.toThrow(/radius/);
    });

    it("flag mode records where each punch was and never blocks; block mode refuses outside punches", async () => {
      const fence = await policy.saveGeofence(f.hr, null, { name: "Head Office", latitude: OFFICE.lat, longitude: OFFICE.lng, radiusM: 150 });
      await policy.updatePolicy(f.hr, { geofenceMode: "flag" });
      expect(await policy.getClockPolicy(staff)).toEqual({ geofenceMode: "flag", selfieMode: "off", hasGeofences: true });

      const a = await mkEmployee("in-flag");
      const inside = await attendance.clockIn(a.claims, { employeeNumber: a.number, source: "gps", gpsLat: OFFICE.lat + 0.0003, gpsLng: OFFICE.lng });
      expect(inside.geofenceResult).toBe("inside");
      const b = await mkEmployee("out-flag");
      const outside = await attendance.clockIn(b.claims, { employeeNumber: b.number, source: "gps", gpsLat: 24.8607, gpsLng: 67.0011 });
      expect(outside.geofenceResult).toBe("outside");
      const c = await mkEmployee("nogps-flag");
      expect((await attendance.clockIn(c.claims, { employeeNumber: c.number, source: "manual" })).geofenceResult).toBe("unknown");

      const list = await policy.listExceptions(f.hr, "2020-01-01", "2099-12-31");
      expect(list.map((x) => x.employeeNumber).sort()).toEqual([b.number, c.number].sort());
      await expect(policy.listExceptions(staff, "2020-01-01", "2099-12-31")).rejects.toBeInstanceOf(ForbiddenException);

      await policy.updatePolicy(f.hr, { geofenceMode: "block" });
      const d = await mkEmployee("out-block");
      await expect(attendance.clockIn(d.claims, { employeeNumber: d.number, source: "gps", gpsLat: 24.8607, gpsLng: 67.0011 })).rejects.toThrow(/from Head Office/);
      await expect(attendance.clockIn(d.claims, { employeeNumber: d.number, source: "manual" })).rejects.toThrow(/Allow location access/);
      expect(await f.sql("SELECT 1 FROM attendance_records WHERE employee_id = $1", [d.id])).toHaveLength(0);
      expect((await attendance.clockIn(d.claims, { employeeNumber: d.number, source: "gps", gpsLat: OFFICE.lat, gpsLng: OFFICE.lng })).geofenceResult).toBe("inside");

      await expect(policy.deleteGeofence(f.hr, fence.id)).rejects.toThrow(/Switch location checks off/);
      await policy.updatePolicy(f.hr, { geofenceMode: "off" });
      await policy.deleteGeofence(f.hr, fence.id);
    });

    it("screens the position: poor accuracy, impossible travel, perfect accuracy and a reported mock location", async () => {
      await policy.updatePolicy(f.hr, { maxGpsAccuracyM: 100, maxTravelSpeedKmh: 250 });
      const a = await mkEmployee("flags");
      const rec = await attendance.clockIn(a.claims, { employeeNumber: a.number, source: "gps", gpsLat: OFFICE.lat, gpsLng: OFFICE.lng, gpsAccuracyM: 800, mockLocation: true });
      expect(rec.locationFlags?.sort()).toEqual(["low_accuracy", "reported_mock_location"]);
      const perfect = await mkEmployee("perfect");
      expect((await attendance.clockIn(perfect.claims, { employeeNumber: perfect.number, source: "gps", gpsLat: OFFICE.lat, gpsLng: OFFICE.lng, gpsAccuracyM: 0 })).locationFlags).toEqual(["perfect_accuracy"]);

      // 1000 km in an hour after an earlier punch
      const t = await mkEmployee("travel");
      await f.sql(`INSERT INTO attendance_records (company_id, employee_id, employee_number, source, gps_lat, gps_lng, clock_in_at, clock_out_at, work_date)
                   VALUES ($1,$2,$3,'gps',24.8607,67.0011, now() - interval '70 minutes', now() - interval '65 minutes', (now() - interval '70 minutes')::date)`, [f.companyId, t.id, t.number]);
      const out = await f.db.withClaims(f.hr, (c) => policy.assess(c, f.companyId, t.id, { gpsLat: OFFICE.lat, gpsLng: OFFICE.lng }));
      expect(out.flags).toContain("impossible_travel");

      await policy.updatePolicy(f.hr, { blockSuspectLocation: true });
      const blocked = await mkEmployee("blocked");
      await expect(attendance.clockIn(blocked.claims, { employeeNumber: blocked.number, source: "gps", gpsLat: OFFICE.lat, gpsLng: OFFICE.lng, mockLocation: true })).rejects.toThrow(/could not be trusted/);
      await policy.updatePolicy(f.hr, { blockSuspectLocation: false });
    });

    it("a selfie is stored, only the person and HR can open it, and 'required' refuses a clock-in without one", async () => {
      await policy.updatePolicy(f.hr, { selfieMode: "required" });
      const a = await mkEmployee("selfie");
      await expect(attendance.clockIn(a.claims, { employeeNumber: a.number, source: "manual" })).rejects.toThrow(/selfie is required/);
      await expect(attendance.clockIn(a.claims, { employeeNumber: a.number, source: "manual", selfie: "data:image/png;base64,AAAA" })).rejects.toThrow(/JPEG/);
      await expect(attendance.clockIn(a.claims, { employeeNumber: a.number, source: "manual", selfie: jpegUrl(80_000) })).rejects.toThrow(/too large/);
      const rec = await attendance.clockIn(a.claims, { employeeNumber: a.number, source: "manual", selfie: jpegUrl() });
      expect(rec.hasSelfie).toBe(true);
      expect((await policy.readSelfie(a.claims, rec.id)).buffer.length).toBeGreaterThan(100);
      expect((await policy.readSelfie(f.hr, rec.id)).mimeType).toBe("image/jpeg");
      await expect(policy.readSelfie(staff, rec.id)).rejects.toBeInstanceOf(ForbiddenException);
      await policy.updatePolicy(f.hr, { selfieMode: "off" });
      const b = await mkEmployee("selfie-off");
      expect((await attendance.clockIn(b.claims, { employeeNumber: b.number, source: "manual", selfie: jpegUrl() })).hasSelfie).toBe(false);
    });
  });

  describe("late and early penalty rules", () => {
    let emp: Awaited<ReturnType<typeof mkEmployee>>;
    const day = (d: string, status: string, late = 0, early = 0) =>
      f.sql(`INSERT INTO attendance_daily_results (company_id, employee_id, work_date, status, late_minutes, early_leave_minutes) VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (employee_id, work_date) DO UPDATE SET status = $4, late_minutes = $5, early_leave_minutes = $6`, [f.companyId, emp.id, d, status, late, early]);

    beforeAll(async () => {
      emp = await mkEmployee("late-person");
      await f.sql("INSERT INTO leave_types (company_id, code, name) VALUES ($1, 'casual_p', 'Casual') ON CONFLICT DO NOTHING", [f.companyId]);
      // four qualifying late days, one too short, one on leave
      for (const d of ["02", "03", "04", "05"]) await day(`2026-03-${d}`, "late", 15);
      await day("2026-03-06", "late", 5);
      await day("2026-03-09", "on_leave", 30);
    });

    it("rule input is checked and only authorised HR can manage rules", async () => {
      const base = { name: "Lates", triggerKind: "late" as const, minMinutes: 10, everyN: 3, penaltyType: "leave_deduction" as const, leaveType: "casual_p", penaltyDays: 1 };
      await expect(penalties.saveRule(staff, null, base)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(penalties.saveRule(f.hr, null, { ...base, leaveType: "nope" })).rejects.toThrow(/does not exist/);
      await expect(penalties.saveRule(f.hr, null, { ...base, penaltyDays: 0 })).rejects.toThrow(/more than 0/);
      await expect(penalties.saveRule(f.hr, null, { ...base, penaltyType: "salary_deduction", penaltyAmount: 0 })).rejects.toThrow(/more than zero/);
      await expect(penalties.saveRule(f.hr, null, { ...base, everyN: 0 })).rejects.toThrow(/Occurrences/);
    });

    it("previews who reached the threshold, applies a leave deduction once, and reverses it", async () => {
      const rule = await penalties.saveRule(f.hr, null, { name: "Every 3 lates", triggerKind: "late", minMinutes: 10, everyN: 3, penaltyType: "leave_deduction", leaveType: "casual_p", penaltyDays: 1 });
      const rows = await penalties.preview(f.hr, "2026-03");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ employeeId: emp.id, occurrences: 4, units: 1, penaltyDays: 1, status: "pending" });

      await expect(penalties.apply(f.hr, { ruleId: rule.id, employeeId: emp.id, month: "2036-03" })).rejects.toThrow(/after the month has ended/);
      const applied = await penalties.apply(f.hr, { ruleId: rule.id, employeeId: emp.id, month: "2026-03" });
      expect(applied.status).toBe("applied");
      const used = await f.sql<{ used_days: string }>("SELECT used_days FROM leave_balances WHERE employee_id = $1 AND leave_type = 'casual_p' AND year = 2026", [emp.id]);
      expect(Number(used[0].used_days)).toBe(1);
      await expect(penalties.apply(f.hr, { ruleId: rule.id, employeeId: emp.id, month: "2026-03" })).rejects.toBeInstanceOf(ConflictException);
      await expect(penalties.deleteRule(f.hr, rule.id)).rejects.toBeInstanceOf(ConflictException);
      expect((await penalties.preview(f.hr, "2026-03"))[0].status).toBe("applied");

      await penalties.reverse(f.hr, applied.applicationId as string);
      expect(Number((await f.sql<{ used_days: string }>("SELECT used_days FROM leave_balances WHERE employee_id = $1 AND leave_type = 'casual_p' AND year = 2026", [emp.id]))[0].used_days)).toBe(0);
      await expect(penalties.reverse(f.hr, applied.applicationId as string)).rejects.toBeInstanceOf(ConflictException);
      expect((await penalties.preview(f.hr, "2026-03"))[0].status).toBe("reversed");
    });

    it("a salary deduction becomes a pending deduction in payroll and is cancelled on reversal", async () => {
      const rule = await penalties.saveRule(f.hr, null, { name: "Lates fine", triggerKind: "late", minMinutes: 10, everyN: 2, penaltyType: "salary_deduction", penaltyAmount: 1500 });
      const row = (await penalties.preview(f.hr, "2026-03")).find((r) => r.ruleId === rule.id);
      expect(row).toMatchObject({ occurrences: 4, units: 2, penaltyAmount: 3000 });
      const applied = await penalties.apply(f.hr, { ruleId: rule.id, employeeId: emp.id, month: "2026-03" });
      const pay = await f.sql<{ payment_type: string; amount: string; status: string }>("SELECT payment_type, amount, status FROM employee_additional_payments WHERE employee_id = $1", [emp.id]);
      expect(pay).toEqual([{ payment_type: "deduction", amount: "3000.00", status: "pending" }]);
      await penalties.reverse(f.hr, applied.applicationId as string);
      expect((await f.sql<{ status: string }>("SELECT status FROM employee_additional_payments WHERE employee_id = $1", [emp.id]))[0].status).toBe("cancelled");
    });

    it("an early-leave rule counts early departures, not lates", async () => {
      const e2 = await mkEmployee("early-person");
      await f.sql("INSERT INTO attendance_daily_results (company_id, employee_id, work_date, status, early_leave_minutes) VALUES ($1,$2,'2026-03-10','early_departure',30),($1,$2,'2026-03-11','early_departure',45)", [f.companyId, e2.id]);
      await penalties.saveRule(f.hr, null, { name: "Early", triggerKind: "early_leave", minMinutes: 20, everyN: 2, penaltyType: "salary_deduction", penaltyAmount: 500 });
      const rows = (await penalties.preview(f.hr, "2026-03")).filter((r) => r.employeeId === e2.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ occurrences: 2, units: 1, penaltyAmount: 500 });
    });
  });
});
