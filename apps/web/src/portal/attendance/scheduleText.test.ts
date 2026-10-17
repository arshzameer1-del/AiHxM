import test from "node:test";
import assert from "node:assert/strict";
import type { ResolvedWorkScheduleView } from "@aihxm/shared-types";
import { summariseShift, unpaidBreakMinutes } from "./scheduleText";

const base: ResolvedWorkScheduleView = {
  date: "2026-10-15", hasSchedule: true, scheduleId: "s", scheduleName: "General shift", scheduleType: "fixed", timezone: "Asia/Karachi", assignmentSource: null, assignmentRuleName: null,
  isWorking: true, isHalfDay: false, startTime: "09:00", endTime: "18:00", crossesMidnight: false, isFlexible: false, flexibleStartTime: null, flexibleEndTime: null, coreStartTime: null, coreEndTime: null,
  breaks: [{ id: "b", startTime: "13:00", endTime: "14:00", isPaid: false }], graceMinutesLate: 15, graceMinutesEarly: 0, isHoliday: false, isMandatoryHoliday: false, holidayName: null,
};

test("a normal working day reads name, hours, break and grace", () => {
  const s = summariseShift(base);
  assert.equal(s.title, "General shift");
  assert.equal(s.hours, "9:00 AM – 6:00 PM");
  assert.equal(s.detail, "1 h unpaid break · 15 min grace");
  assert.equal(s.working, true);
});
test("paid breaks are not taken off", () => {
  assert.equal(unpaidBreakMinutes({ ...base, breaks: [{ id: "b", startTime: "13:00", endTime: "13:30", isPaid: true }] }), 0);
});
test("holiday, day off and no schedule", () => {
  assert.equal(summariseShift({ ...base, isMandatoryHoliday: true, holidayName: "Independence Day" }).title, "Holiday: Independence Day");
  assert.equal(summariseShift({ ...base, isWorking: false }).title, "Day off");
  assert.equal(summariseShift({ ...base, hasSchedule: false }).title, "No shift assigned");
  assert.equal(summariseShift(null).title, "No shift assigned");
});
