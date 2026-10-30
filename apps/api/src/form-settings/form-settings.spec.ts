import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { FormSettingsService } from "./form-settings.service";

describe("Form settings", () => {
  let f: PayrollFixture;
  let other: PayrollFixture;
  let svc: FormSettingsService;
  let otherSvc: FormSettingsService;
  let staff: Awaited<ReturnType<PayrollFixture["makeUser"]>>;
  const mk = (fx: PayrollFixture) => new FormSettingsService(fx.db, fx.rbac, fx.entitlements, fx.audit);

  beforeAll(async () => {
    f = await buildPayrollFixture("fset1");
    other = await buildPayrollFixture("fset2");
    svc = mk(f);
    otherSvc = mk(other);
    staff = await f.makeUser("fsetstaff", ["employee_self_service"]);
  }, 120000);
  afterAll(async () => {
    await f.cleanup();
    await other.cleanup();
  }, 60000);

  it("starts from the form's own defaults and lists what each field may change", async () => {
    const leave = await svc.form(f.hr, "leave_request");
    const reason = leave.fields.find((x) => x.fieldKey === "reason")!;
    expect(reason).toMatchObject({ label: "New Note", required: false, hidden: false, customised: false, canHide: true, canRequire: true });
    const start = leave.fields.find((x) => x.fieldKey === "startDate")!;
    expect(start).toMatchObject({ required: true, canHide: false, canRequire: false });
    await expect(svc.form(f.hr, "nonsense")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("only a person with rights changes settings; anyone in the company can read them", async () => {
    await expect(svc.update(staff, "leave_request", "reason", { required: true })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.form(staff, "leave_request")).resolves.toBeTruthy();
  });

  it("relabels, explains and requires a field, and the server then refuses a request that leaves it empty", async () => {
    const v = await svc.update(f.hr, "leave_request", "reason", { label: "Reason for leave", helpText: "Tell your manager why", required: true });
    const reason = v.fields.find((x) => x.fieldKey === "reason")!;
    expect(reason).toMatchObject({ label: "Reason for leave", helpText: "Tell your manager why", required: true, customised: true, defaultLabel: "New Note" });
    await expect(svc.enforce(f.hr, "leave_request", { reason: "  " })).rejects.toThrow("Reason for leave is required");
    await expect(svc.enforce(f.hr, "leave_request", {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.enforce(f.hr, "leave_request", { reason: "Family event" })).resolves.toBeUndefined();
  });

  it("another company is not affected", async () => {
    await expect(otherSvc.enforce(other.hr, "leave_request", {})).resolves.toBeUndefined();
    expect((await otherSvc.form(other.hr, "leave_request")).fields.find((x) => x.fieldKey === "reason")!.customised).toBe(false);
  });

  it("a field the business always needs cannot be hidden or made optional, and a hidden field cannot be required", async () => {
    await expect(svc.update(f.hr, "leave_request", "startDate", { hidden: true })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update(f.hr, "leave_request", "startDate", { required: false })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update(f.hr, "leave_request", "reason", { hidden: true })).rejects.toThrow("hidden field cannot also be required");
    await expect(svc.update(f.hr, "leave_request", "nope", { label: "x" })).rejects.toBeInstanceOf(NotFoundException);
    // it can still be renamed
    const v = await svc.update(f.hr, "leave_request", "startDate", { label: "From" });
    expect(v.fields.find((x) => x.fieldKey === "startDate")!.label).toBe("From");
  });

  it("a hidden field is not asked for, and a length limit is enforced and capped at the form's own maximum", async () => {
    await svc.update(f.hr, "expense_claim", "description", { hidden: true });
    await expect(svc.enforce(f.hr, "expense_claim", {})).resolves.toBeUndefined();
    await svc.update(f.hr, "expense_claim", "description", { hidden: false, maxLength: 20 });
    await expect(svc.enforce(f.hr, "expense_claim", { description: "x".repeat(21) })).rejects.toThrow("at most 20");
    await expect(svc.update(f.hr, "expense_claim", "description", { maxLength: 5000 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update(f.hr, "expense_claim", "amount", { maxLength: 5 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("every change is kept, and restoring puts the field back as it was; the restore is itself recorded", async () => {
    await svc.update(f.hr, "helpdesk_ticket", "categoryId", { required: true });
    await svc.update(f.hr, "helpdesk_ticket", "categoryId", { label: "Topic" });
    let history = await svc.history(f.hr, "helpdesk_ticket");
    expect(history.length).toBe(2);
    const latest = history[0];
    expect(latest.after).toMatchObject({ label: "Topic" });
    const back = await svc.restore(f.hr, latest.id);
    const cat = back.fields.find((x) => x.fieldKey === "categoryId")!;
    expect(cat).toMatchObject({ label: "About", required: true });
    history = await svc.history(f.hr, "helpdesk_ticket");
    expect(history[0].action).toBe("restore");
    const reset = await svc.reset(f.hr, "helpdesk_ticket", "categoryId");
    expect(reset.fields.find((x) => x.fieldKey === "categoryId")).toMatchObject({ required: false, customised: false });
    const rows = await f.sql("SELECT 1 FROM audit_log WHERE action LIKE 'form_settings.%' AND target = 'helpdesk_ticket.categoryId'");
    expect(rows.length).toBeGreaterThanOrEqual(3);
    await expect(svc.history(staff)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("Form settings: the other forms", () => {
  let f: PayrollFixture;
  let svc: FormSettingsService;
  beforeAll(async () => {
    f = await buildPayrollFixture("fset3");
    svc = new FormSettingsService(f.db, f.rbac, f.entitlements, f.audit);
  }, 120000);
  afterAll(async () => {
    await f.cleanup();
  }, 60000);

  it("work away, attendance correction and travel follow the same rules", async () => {
    await svc.update(f.hr, "on_duty_request", "reason", { required: true });
    await expect(svc.enforce(f.hr, "on_duty_request", { reason: "" })).rejects.toThrow("Reason is required");
    await svc.update(f.hr, "on_duty_request", "location", { hidden: true });
    await expect(svc.enforce(f.hr, "on_duty_request", { reason: "Client visit" })).resolves.toBeUndefined();

    await svc.update(f.hr, "attendance_correction", "reason", { maxLength: 30 });
    await expect(svc.enforce(f.hr, "attendance_correction", { reason: "x".repeat(31) })).rejects.toThrow("at most 30");
    await expect(svc.update(f.hr, "attendance_correction", "reason", { hidden: true })).rejects.toBeInstanceOf(BadRequestException);

    await svc.update(f.hr, "travel_request", "estOtherCost", { required: true });
    await expect(svc.enforce(f.hr, "travel_request", { estOtherCost: null })).rejects.toThrow("Other expected costs (PKR) is required");
    await expect(svc.enforce(f.hr, "travel_request", { estOtherCost: 0 })).resolves.toBeUndefined();
    // the advance is always sent as a number, so "required" would mean nothing there and is not offered
    await expect(svc.update(f.hr, "travel_request", "advanceRequested", { required: true })).rejects.toBeInstanceOf(BadRequestException);
    await svc.update(f.hr, "travel_request", "advanceRequested", { hidden: true });
  });
});
