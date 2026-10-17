import test from "node:test";
import assert from "node:assert/strict";
import type { AttendanceDailyResultView, AttendanceRecordView } from "@aihxm/shared-types";
import { buildDays, minutesText, runningText, stripDays } from "./attendanceDays";

function rec(inAt: string, outAt: string | null, status: AttendanceRecordView["status"] = "on_time"): AttendanceRecordView {
  return { id: inAt, employeeId: "e", employeeNumber: "EMP-1", source: "manual", clockInAt: inAt, clockOutAt: outAt, gpsLat: null, gpsLng: null, status, shiftName: "General" };
}
function res(workDate: string, status: AttendanceDailyResultView["status"], extra: Partial<AttendanceDailyResultView> = {}): AttendanceDailyResultView {
  return { id: workDate, employeeId: "e", workDate, shiftId: null, scheduleName: null, status, scheduledMinutes: 480, workedMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, firstInAt: null, lastOutAt: null, punchCount: 0, leaveRequestId: null, onDutyRequestId: null, exceptions: [], isOverridden: false, overrideReason: null, evaluatedAt: "", ...extra };
}
const local = (d: string, hm: string) => new Date(`${d}T${hm}:00`).toISOString();

test("two sessions in a day: first in, last out, worked is the sum, the gap is the break", () => {
  const d = "2026-10-14";
  const rows = buildDays([rec(local(d, "09:00"), local(d, "13:00")), rec(local(d, "14:00"), local(d, "18:00"))], [], new Date(`2026-10-17T10:00:00`));
  const day = rows.get(d)!;
  assert.equal(day.firstIn, local(d, "09:00"));
  assert.equal(day.lastOut, local(d, "18:00"));
  assert.equal(day.workedMinutes, 480);
  assert.equal(day.breakMinutes, 60);
  assert.equal(day.kind, "on_time");
  assert.equal(day.sessions.length, 2);
});

test("an open clock-in today counts running time and has no check-out", () => {
  const now = new Date("2026-10-17T12:30:00");
  const rows = buildDays([rec(local("2026-10-17", "10:00"), null)], [], now);
  const day = rows.get("2026-10-17")!;
  assert.equal(day.open, true);
  assert.equal(day.lastOut, null);
  assert.equal(day.workedMinutes, 150);
});

test("a forgotten clock-out from an earlier day is not running time", () => {
  const rows = buildDays([rec(local("2026-10-15", "09:00"), null)], [], new Date("2026-10-17T10:00:00"));
  const day = rows.get("2026-10-15")!;
  assert.equal(day.open, false);
  assert.equal(day.workedMinutes, 0);
  assert.deepEqual(day.notes, ["No clock-out"]);
});

test("a late first punch makes the day late; leaving early marks it early", () => {
  const d = "2026-10-15";
  assert.equal(buildDays([rec(local(d, "10:57"), local(d, "18:00"), "late")], [], new Date("2026-10-17T10:00:00")).get(d)!.kind, "late");
  assert.equal(buildDays([rec(local(d, "09:00"), local(d, "15:00"), "early_departure")], [], new Date("2026-10-17T10:00:00")).get(d)!.kind, "early");
});

test("a processed day wins for status and worked time, and break is what the engine netted off", () => {
  const d = "2026-10-13";
  const rows = buildDays(
    [rec(local(d, "09:54"), local(d, "21:14"))],
    [res(d, "late", { workedMinutes: 620, firstInAt: local(d, "09:54"), lastOutAt: local(d, "21:14"), lateMinutes: 54 })],
    new Date("2026-10-17T10:00:00")
  );
  const day = rows.get(d)!;
  assert.equal(day.kind, "late");
  assert.equal(day.workedMinutes, 620);
  assert.equal(day.breakMinutes, 60);
  assert.equal(day.lateMinutes, 54);
});

test("processed absence, leave and holiday have their own kinds even with no punches", () => {
  const rows = buildDays([], [res("2026-10-12", "absent"), res("2026-10-11", "on_leave"), res("2026-10-10", "holiday"), res("2026-10-09", "rest_day")], new Date("2026-10-17T10:00:00"));
  assert.deepEqual(["2026-10-12", "2026-10-11", "2026-10-10", "2026-10-09"].map((d) => rows.get(d)!.kind), ["absent", "leave", "holiday", "none"]);
});

test("the strip is the last 30 days ending today, oldest first, unknown days are none", () => {
  const rows = buildDays([rec(local("2026-10-17", "09:00"), local("2026-10-17", "17:00"))], [], new Date("2026-10-17T18:00:00"));
  const strip = stripDays(rows, "2026-10-17", 30);
  assert.equal(strip.length, 30);
  assert.equal(strip[0].date, "2026-09-18");
  assert.equal(strip[29].date, "2026-10-17");
  assert.equal(strip[29].kind, "on_time");
  assert.equal(strip[28].kind, "none");
});

test("time text", () => {
  assert.equal(minutesText(511), "8h 31m");
  assert.equal(minutesText(0), "—");
  assert.equal(runningText("2026-10-17T10:00:00", new Date("2026-10-17T12:05:09")), "2:05:09");
});
