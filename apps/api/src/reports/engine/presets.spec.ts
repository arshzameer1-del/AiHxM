import { previousRange, resolvePreset } from "./presets";

describe("date presets", () => {
  // 2026-10-07 is a Wednesday
  const today = "2026-10-07";
  it.each([
    ["today", "2026-10-07", "2026-10-07"],
    ["yesterday", "2026-10-06", "2026-10-06"],
    ["thisWeek", "2026-10-05", "2026-10-07"],
    ["lastWeek", "2026-09-28", "2026-10-04"],
    ["last7Days", "2026-10-01", "2026-10-07"],
    ["last30Days", "2026-09-08", "2026-10-07"],
    ["thisMonth", "2026-10-01", "2026-10-07"],
    ["lastMonth", "2026-09-01", "2026-09-30"],
    ["quarterToDate", "2026-10-01", "2026-10-07"],
    ["lastQuarter", "2026-07-01", "2026-09-30"],
    ["yearToDate", "2026-01-01", "2026-10-07"],
    ["lastYear", "2025-01-01", "2025-12-31"],
  ] as const)("%s", (preset, from, to) => {
    expect(resolvePreset(preset, today)).toEqual({ from, to });
  });
  it("handles January for last month / last quarter", () => {
    expect(resolvePreset("lastMonth", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(resolvePreset("lastQuarter", "2026-02-10")).toEqual({ from: "2025-10-01", to: "2025-12-31" });
  });
  it("custom has no range of its own", () => expect(resolvePreset("custom", today)).toBeNull());
  it("previous period has the same length and ends the day before", () => {
    expect(previousRange({ from: "2026-10-01", to: "2026-10-07" })).toEqual({ from: "2026-09-24", to: "2026-09-30" });
    expect(previousRange({ from: "2026-09-01", to: "2026-09-30" })).toEqual({ from: "2026-08-02", to: "2026-08-31" });
    expect(previousRange({ from: "2026-10-07", to: "2026-10-07" })).toEqual({ from: "2026-10-06", to: "2026-10-06" });
  });
});
