import { nextLocalRun, recipientMayReceive } from "./schedule-time";

describe("schedule time", () => {
  // 2026-10-07 is a Wednesday
  const now = { date: "2026-10-07", hour: 9 };
  it("daily: later today if the hour has not passed, else tomorrow", () => {
    expect(nextLocalRun({ frequency: "daily", dayOfWeek: null, dayOfMonth: null, hourLocal: 11 }, now)).toEqual({ date: "2026-10-07", hour: 11 });
    expect(nextLocalRun({ frequency: "daily", dayOfWeek: null, dayOfMonth: null, hourLocal: 9 }, now)).toEqual({ date: "2026-10-08", hour: 9 });
    expect(nextLocalRun({ frequency: "daily", dayOfWeek: null, dayOfMonth: null, hourLocal: 7 }, now)).toEqual({ date: "2026-10-08", hour: 7 });
  });
  it("weekly: the next matching weekday, never in the past", () => {
    expect(nextLocalRun({ frequency: "weekly", dayOfWeek: 1, dayOfMonth: null, hourLocal: 7 }, now)).toEqual({ date: "2026-10-12", hour: 7 }); // Monday
    expect(nextLocalRun({ frequency: "weekly", dayOfWeek: 3, dayOfMonth: null, hourLocal: 12 }, now)).toEqual({ date: "2026-10-07", hour: 12 }); // today, later
    expect(nextLocalRun({ frequency: "weekly", dayOfWeek: 3, dayOfMonth: null, hourLocal: 8 }, now)).toEqual({ date: "2026-10-14", hour: 8 }); // today, passed
    expect(nextLocalRun({ frequency: "weekly", dayOfWeek: 0, dayOfMonth: null, hourLocal: 8 }, now)).toEqual({ date: "2026-10-11", hour: 8 }); // Sunday
  });
  it("monthly: this month if still ahead, else next month, across the year end", () => {
    expect(nextLocalRun({ frequency: "monthly", dayOfWeek: null, dayOfMonth: 15, hourLocal: 7 }, now)).toEqual({ date: "2026-10-15", hour: 7 });
    expect(nextLocalRun({ frequency: "monthly", dayOfWeek: null, dayOfMonth: 1, hourLocal: 7 }, now)).toEqual({ date: "2026-11-01", hour: 7 });
    expect(nextLocalRun({ frequency: "monthly", dayOfWeek: null, dayOfMonth: 7, hourLocal: 12 }, now)).toEqual({ date: "2026-10-07", hour: 12 });
    expect(nextLocalRun({ frequency: "monthly", dayOfWeek: null, dayOfMonth: 7, hourLocal: 9 }, now)).toEqual({ date: "2026-11-07", hour: 9 });
    expect(nextLocalRun({ frequency: "monthly", dayOfWeek: null, dayOfMonth: 5, hourLocal: 7 }, { date: "2026-12-20", hour: 3 })).toEqual({ date: "2027-01-05", hour: 7 });
  });
});

describe("who may receive a scheduled file", () => {
  const tenant = { scope: "tenant" as const, canExport: true };
  it("the owner needs export access", () => {
    expect(recipientMayReceive({ id: "o", access: tenant }, "o")).toBe(true);
    expect(recipientMayReceive({ id: "o", access: { scope: "team", canExport: true } }, "o")).toBe(true);
    expect(recipientMayReceive({ id: "o", access: { scope: "tenant", canExport: false } }, "o")).toBe(false);
    expect(recipientMayReceive({ id: "o", access: null }, "o")).toBe(false);
  });
  it("others receive only with company-wide export access, so the file never shows them more than they could open", () => {
    expect(recipientMayReceive({ id: "r", access: tenant }, "o")).toBe(true);
    expect(recipientMayReceive({ id: "r", access: { scope: "team", canExport: true } }, "o")).toBe(false);
    expect(recipientMayReceive({ id: "r", access: { scope: "scoped", canExport: true } }, "o")).toBe(false);
    expect(recipientMayReceive({ id: "r", access: { scope: "tenant", canExport: false } }, "o")).toBe(false);
    expect(recipientMayReceive({ id: "r", access: null }, "o")).toBe(false);
  });
});
