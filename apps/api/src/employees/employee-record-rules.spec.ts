import { assertSaneMoney, assertValidGender, fileMatchesDeclaredType, orderedDays, requireText, saneDay } from "./employee-record-rules";

const msg = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    return JSON.stringify((e as { getResponse: () => unknown }).getResponse());
  }
  return null;
};

describe("employee record rules", () => {
  const today = new Date("2026-10-30T09:00:00Z");
  it("text that is only spaces is refused; not being set is fine", () => {
    expect(msg(() => requireText("  ", "title", "Title"))).toContain("cannot be empty");
    expect(msg(() => requireText(undefined, "title", "Title"))).toBeNull();
    expect(msg(() => requireText("BS", "title", "Title"))).toBeNull();
  });
  it("dates: not before 1920; not in the future unless the field is naturally ahead; ahead limit can be set", () => {
    expect(msg(() => saneDay("1800-01-01", "d", "Date", { today }))).toContain("too far in the past");
    expect(msg(() => saneDay("2027-01-01", "d", "Date", { today }))).toContain("cannot be in the future");
    expect(msg(() => saneDay("2027-01-01", "d", "Date", { today, allowFuture: true }))).toBeNull();
    expect(msg(() => saneDay("2090-01-01", "d", "Date", { today, allowFuture: true, maxYearsAhead: 10 }))).toContain("too far ahead");
    expect(msg(() => saneDay("2034-01-01", "d", "Date", { today, allowFuture: true, maxYearsAhead: 10 }))).toBeNull();
    expect(msg(() => saneDay(undefined, "d", "Date", { today }))).toBeNull();
  });
  it("an end cannot come before its start, and a missing side is skipped", () => {
    expect(msg(() => orderedDays("2020-01-01", "2015-01-01", "end", "bad"))).toContain("bad");
    expect(msg(() => orderedDays("2020-01-01", "2020-01-01", "end", "bad"))).toBeNull();
    expect(msg(() => orderedDays(null, "2015-01-01", "end", "bad"))).toBeNull();
    expect(msg(() => orderedDays(new Date("2020-05-01T00:00:00Z"), "2020-04-30", "end", "bad"))).toContain("bad");
  });
  it("gender is one of the known values, any case", () => {
    for (const ok of ["male", "Female", "OTHER", "transgender", "", undefined]) expect(msg(() => assertValidGender(ok))).toBeNull();
    expect(msg(() => assertValidGender("xyz"))).toContain("Gender must be");
  });
  it("money: two decimals at most and not absurd", () => {
    expect(msg(() => assertSaneMoney(1500.5, "amount", "Amount"))).toBeNull();
    expect(msg(() => assertSaneMoney(100.005, "amount", "Amount"))).toContain("two decimal places");
    expect(msg(() => assertSaneMoney(5e9, "amount", "Amount"))).toContain("too large");
  });
  it("a file's first bytes must match PDF, PNG and JPEG; other types and empty files are judged simply", () => {
    expect(fileMatchesDeclaredType(Buffer.from("%PDF-1.7 ..."), "application/pdf")).toBe(true);
    expect(fileMatchesDeclaredType(Buffer.from("hello"), "application/pdf")).toBe(false);
    expect(fileMatchesDeclaredType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]), "image/png")).toBe(true);
    expect(fileMatchesDeclaredType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg")).toBe(true);
    expect(fileMatchesDeclaredType(Buffer.from("x"), "image/jpeg")).toBe(false);
    expect(fileMatchesDeclaredType(Buffer.from("PK"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(true);
    expect(fileMatchesDeclaredType(Buffer.alloc(0), "application/pdf")).toBe(false);
  });
});
