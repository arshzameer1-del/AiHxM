import { BadRequestException } from "@nestjs/common";
import { assertValidEmail, assertValidEmploymentDates, assertValidPersonName, assertValidPhone } from "./employee-input-rules";

const today = new Date("2026-10-30T09:00:00Z");
const field = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    return (e as BadRequestException).getResponse() as { field: string; message: string };
  }
  return null;
};

describe("employee input rules", () => {
  it("names must have something in them and a sensible length", () => {
    expect(field(() => assertValidPersonName("Ayesha", "firstName", "First name"))).toBeNull();
    expect(field(() => assertValidPersonName(undefined, "firstName", "First name"))).toBeNull();
    expect(field(() => assertValidPersonName("   ", "firstName", "First name"))?.field).toBe("firstName");
    expect(field(() => assertValidPersonName("A".repeat(101), "lastName", "Last name"))?.message).toContain("at most 100");
    expect(field(() => assertValidPersonName("A".repeat(100), "lastName", "Last name"))).toBeNull();
  });

  it("email must look like an email; empty means not given", () => {
    for (const ok of ["a@b.com", "first.last@company.com.pk", ""]) expect(field(() => assertValidEmail(ok))).toBeNull();
    for (const bad of ["not-an-email", "a@b", "a b@c.com", "@x.com", "a@.com"]) expect(field(() => assertValidEmail(bad))?.field).toBe("email");
  });

  it("phone accepts the usual Pakistani ways of writing a number and refuses letters or too few digits", () => {
    for (const ok of ["0300-1234567", "+92 300 1234567", "(042) 3512 3456", "03001234567"]) expect(field(() => assertValidPhone(ok))).toBeNull();
    for (const bad of ["abc", "123", "0300-ABC4567", "1".repeat(16)]) expect(field(() => assertValidPhone(bad))?.field).toBe("phone");
  });

  it("date of birth cannot be in the future, absurdly old, after joining, or make the person under 14 on joining", () => {
    const run = (dob: string | null, doj: string | null, birth = true, joining = true) => field(() => assertValidEmploymentDates({ dateOfBirth: dob, dateOfJoining: doj }, { birth, joining }, today));
    expect(run("1990-05-01", "2024-01-15")).toBeNull();
    expect(run("2090-01-01", "2024-01-15")?.message).toContain("future");
    expect(run("1900-01-01", "2024-01-15")?.message).toContain("before 1920");
    expect(run("2024-06-01", "2024-01-15")?.message).toContain("before the date of joining");
    expect(run("2020-01-01", "2024-01-15")?.message).toContain("younger than 14");
    // exactly 14 on the joining day is allowed, one day short is not
    expect(run("2010-01-15", "2024-01-15")).toBeNull();
    expect(run("2010-01-16", "2024-01-15")?.message).toContain("younger than 14");
  });

  it("joining date: a hire may be entered ahead, but not years ahead or before 1960", () => {
    const run = (doj: string) => field(() => assertValidEmploymentDates({ dateOfJoining: doj }, { birth: false, joining: true }, today));
    expect(run("2026-12-01")).toBeNull();
    expect(run("2100-01-01")?.field).toBe("dateOfJoining");
    expect(run("1900-01-01")?.field).toBe("dateOfJoining");
  });

  it("an edit that changes neither date does not re-judge old stored values", () => {
    expect(field(() => assertValidEmploymentDates({ dateOfBirth: "2090-01-01", dateOfJoining: "1900-01-01" }, { birth: false, joining: false }, today))).toBeNull();
  });
});
