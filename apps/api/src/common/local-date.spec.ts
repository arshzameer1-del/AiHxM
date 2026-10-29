import { localToday } from "./local-date";

describe("localToday", () => {
  it("is the next calendar day in Karachi during the first five hours of the day there", () => {
    expect(localToday("Asia/Karachi", new Date("2026-10-28T20:30:00Z"))).toBe("2026-10-29"); // 01:30 on the 29th in Karachi
    expect(localToday("UTC", new Date("2026-10-28T20:30:00Z"))).toBe("2026-10-28");
  });
  it("falls back to UTC for an unknown zone", () => {
    expect(localToday("Not/AZone", new Date("2026-10-28T20:30:00Z"))).toBe("2026-10-28");
  });
});
