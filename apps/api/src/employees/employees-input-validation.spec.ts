import { BadRequestException } from "@nestjs/common";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { EmployeesService } from "./employees.service";

/** What is typed into a new or edited employee record is sense-checked by the server, not only by the screen. */
describe("Employee record input checks", () => {
  let f: PayrollFixture;
  let svc: EmployeesService;
  const good = { firstName: "Ayesha", lastName: "Khan", employmentType: "permanent", dateOfJoining: "2024-01-15" } as const;

  beforeAll(async () => {
    f = await buildPayrollFixture("empinput");
    svc = new EmployeesService(f.db, f.rbac, f.entitlements, f.audit, new LocalFileStorageService());
  }, 120000);
  afterAll(async () => {
    await f.cleanup();
  }, 60000);

  const refused = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      return (e as BadRequestException).getResponse() as { field?: string; message: string };
    }
    throw new Error("expected the request to be refused");
  };

  it("a hire with sensible details is accepted", async () => {
    const e = await svc.create(f.hr, { ...good, email: "ayesha@example.com", phone: "0300-1234567", dateOfBirth: "1992-04-02" });
    expect(e.firstName).toBe("Ayesha");
  });

  it("a hire with an empty or oversized name, a bad email or phone, or impossible dates is refused with the field named", async () => {
    expect((await refused(svc.create(f.hr, { ...good, firstName: "   " }))).field).toBe("firstName");
    expect((await refused(svc.create(f.hr, { ...good, lastName: "K".repeat(500) }))).field).toBe("lastName");
    expect((await refused(svc.create(f.hr, { ...good, email: "not-an-email" }))).field).toBe("email");
    expect((await refused(svc.create(f.hr, { ...good, phone: "abc" }))).field).toBe("phone");
    expect((await refused(svc.create(f.hr, { ...good, dateOfBirth: "2090-01-01" }))).field).toBe("dateOfBirth");
    expect((await refused(svc.create(f.hr, { ...good, dateOfBirth: "2023-01-01" }))).message).toContain("younger than 14");
    expect((await refused(svc.create(f.hr, { ...good, dateOfJoining: "2100-01-01" }))).field).toBe("dateOfJoining");
  });

  it("an edit is judged only on what it changes: bad details already on file do not block an unrelated edit", async () => {
    const id = (await f.createEmployee({ monthlySalary: null })).id;
    await f.sql("UPDATE employees SET phone = 'old-bad-value', email = 'also bad' WHERE id = $1", [id]);
    const renamed = await svc.update(f.hr, id, { firstName: "Renamed" });
    expect(renamed.firstName).toBe("Renamed");
    expect((await refused(svc.update(f.hr, id, { email: "still bad" }))).field).toBe("email");
    expect((await refused(svc.update(f.hr, id, { dateOfBirth: "2090-01-01" }))).field).toBe("dateOfBirth");
    // a joining date change is checked against the date of birth already on file
    await svc.update(f.hr, id, { dateOfBirth: "1990-01-01", dateOfJoining: "2015-01-01" });
    expect((await refused(svc.update(f.hr, id, { dateOfJoining: "1989-01-01" }))).field).toBe("dateOfBirth");
  });
});
