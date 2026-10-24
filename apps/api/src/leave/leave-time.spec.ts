import { calculateTimedLeave, formatMinutes, periodEnd, periodStart, scheduledDayMinutes, toBalanceUnits, zonedWallClockToInstant, type TimedLeaveInput } from "./leave-time";

const office = {
  hasSchedule: true,
  startTime: "09:00",
  endTime: "17:00",
  crossesMidnight: false,
  breaks: [{ id: "b1", startTime: "13:00", endTime: "14:00", isPaid: false }],
};

function calc(overrides: Partial<TimedLeaveInput> & { startTime: string; endTime: string }) {
  return calculateTimedLeave({ date: "2026-10-12", timeZone: "Asia/Karachi", schedule: office, breakTreatment: "exclude_all", allowOvernight: false, ...overrides });
}

describe("calculateTimedLeave", () => {
  it("charges 10:30-11:30 as one hour when no break falls inside it", () => {
    const r = calc({ startTime: "10:30", endTime: "11:30" });
    expect(r.ok).toBe(true);
    expect(r.grossMinutes).toBe(60);
    expect(r.breakMinutes).toBe(0);
    expect(r.netMinutes).toBe(60);
    // Karachi is UTC+5: 10:30 local = 05:30 UTC
    expect(r.startAt).toBe("2026-10-12T05:30:00.000Z");
    expect(r.endAt).toBe("2026-10-12T06:30:00.000Z");
  });

  it("takes the lunch break out of a request that spans it", () => {
    const r = calc({ startTime: "12:30", endTime: "14:30" });
    expect(r.grossMinutes).toBe(120);
    expect(r.breakMinutes).toBe(60);
    expect(r.netMinutes).toBe(60);
    expect(r.breaks).toEqual([{ startTime: "13:00", endTime: "14:00", isPaid: false, overlapMinutes: 60, excluded: true }]);
  });

  it("honours the break treatment of the settings", () => {
    expect(calc({ startTime: "12:30", endTime: "14:30", breakTreatment: "include" }).netMinutes).toBe(120);
    // the break here is unpaid, so exclude_unpaid removes it...
    expect(calc({ startTime: "12:30", endTime: "14:30", breakTreatment: "exclude_unpaid" }).netMinutes).toBe(60);
    // ...and a paid break stays in the charged time
    const paid = { ...office, breaks: [{ id: "b", startTime: "13:00", endTime: "14:00", isPaid: true }] };
    expect(calc({ startTime: "12:30", endTime: "14:30", breakTreatment: "exclude_unpaid", schedule: paid }).netMinutes).toBe(120);
  });

  it("uses the employee's own shift: another shift has other breaks", () => {
    const late = { hasSchedule: true, startTime: "10:00", endTime: "18:00", crossesMidnight: false, breaks: [{ id: "b", startTime: "14:00", endTime: "15:00", isPaid: false }] };
    // 13:00-14:00 is lunch for the 09:00 shift but ordinary time for this one
    expect(calc({ startTime: "13:00", endTime: "14:00", schedule: late }).netMinutes).toBe(60);
    expect(calc({ startTime: "13:00", endTime: "14:00" }).ok).toBe(false);
    expect(calc({ startTime: "13:00", endTime: "14:00" }).errors).toEqual(["no_minutes_left"]);
  });

  it("works without any schedule (no breaks to exclude)", () => {
    const none = { hasSchedule: false, startTime: null, endTime: null, crossesMidnight: false, breaks: [] };
    expect(calc({ startTime: "08:00", endTime: "09:15", schedule: none }).netMinutes).toBe(75);
  });

  it("refuses reversed, equal and malformed times", () => {
    expect(calc({ startTime: "11:30", endTime: "10:30" }).errors).toEqual(["end_not_after_start"]);
    expect(calc({ startTime: "10:30", endTime: "10:30" }).errors).toEqual(["end_not_after_start"]);
    expect(calc({ startTime: "25:00", endTime: "26:00" }).errors).toEqual(["invalid_time_format"]);
    expect(calc({ startTime: "", endTime: "10:00" }).errors).toEqual(["invalid_time_format"]);
  });

  describe("daylight-saving time", () => {
    const ny = { timeZone: "America/New_York", schedule: { hasSchedule: false, startTime: null, endTime: null, crossesMidnight: false, breaks: [] } };

    it("charges the minutes that really pass across the spring-forward jump", () => {
      // 2026-03-08: 02:00-03:00 does not exist in New York
      const r = calc({ ...ny, date: "2026-03-08", startTime: "01:30", endTime: "03:30" });
      expect(r.ok).toBe(true);
      expect(r.grossMinutes).toBe(60);
    });

    it("refuses a clock time that does not exist", () => {
      expect(calc({ ...ny, date: "2026-03-08", startTime: "02:30", endTime: "03:30" }).errors).toEqual(["time_does_not_exist"]);
    });

    it("charges the extra hour of the fall-back night", () => {
      // 2026-11-01: 01:00-02:00 happens twice
      const r = calc({ ...ny, date: "2026-11-01", startTime: "00:30", endTime: "02:30" });
      expect(r.grossMinutes).toBe(180);
    });

    it("reads an ambiguous time as its first occurrence", () => {
      const first = zonedWallClockToInstant("2026-11-01", 90, "America/New_York");
      expect(new Date(first as number).toISOString()).toBe("2026-11-01T05:30:00.000Z");
    });
  });

  describe("overnight shifts", () => {
    const night = { hasSchedule: true, startTime: "22:00", endTime: "06:00", crossesMidnight: true, breaks: [{ id: "b", startTime: "01:00", endTime: "01:30", isPaid: false }] };

    it("is refused unless overnight requests are explicitly enabled", () => {
      expect(calc({ startTime: "23:00", endTime: "01:00", schedule: night }).errors).toEqual(["end_not_after_start"]);
    });

    it("runs past midnight when enabled, and takes the night break out", () => {
      const r = calc({ startTime: "23:30", endTime: "02:00", schedule: night, allowOvernight: true });
      expect(r.ok).toBe(true);
      expect(r.overnight).toBe(true);
      expect(r.startDate).toBe("2026-10-12");
      expect(r.endDate).toBe("2026-10-13");
      expect(r.grossMinutes).toBe(150);
      expect(r.breakMinutes).toBe(30);
      expect(r.netMinutes).toBe(120);
    });

    it("reads hours before the shift start as the following morning", () => {
      const r = calc({ startTime: "02:00", endTime: "03:00", schedule: night, allowOvernight: true });
      expect(r.startDate).toBe("2026-10-13");
      expect(r.netMinutes).toBe(60);
    });
  });
});

describe("units", () => {
  it("converts minutes to the balance unit", () => {
    expect(toBalanceUnits(90, "minutes", 480)).toBe(90);
    expect(toBalanceUnits(90, "hours", 480)).toBe(1.5);
    expect(toBalanceUnits(20, "hours", 480)).toBe(0.3333);
    expect(toBalanceUnits(240, "days", 480)).toBe(0.5);
    // a day is the employee's own day, not a fixed 8 hours
    expect(toBalanceUnits(240, "days", 420)).toBe(0.5714);
  });

  it("measures the scheduled working day less the breaks the settings exclude", () => {
    expect(scheduledDayMinutes(office, "exclude_all")).toBe(420);
    expect(scheduledDayMinutes(office, "include")).toBe(480);
    expect(scheduledDayMinutes({ hasSchedule: false, startTime: null, endTime: null, breaks: [] }, "exclude_all")).toBeNull();
  });

  it("formats durations", () => {
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(120)).toBe("2 h");
    expect(formatMinutes(90)).toBe("1 h 30 min");
  });
});

describe("calendar periods", () => {
  it("finds the Monday-based week and the month and year around a date", () => {
    expect(periodStart("2026-10-07", "week")).toBe("2026-10-05"); // a Wednesday
    expect(periodEnd("2026-10-07", "week")).toBe("2026-10-11");
    expect(periodStart("2026-10-07", "month")).toBe("2026-10-01");
    expect(periodEnd("2026-02-10", "month")).toBe("2026-02-28");
    expect(periodStart("2026-10-07", "year")).toBe("2026-01-01");
    expect(periodEnd("2026-10-07", "year")).toBe("2026-12-31");
  });
});
