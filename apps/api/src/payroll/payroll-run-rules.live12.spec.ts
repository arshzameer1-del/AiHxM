import { buildPayrollFixture, type PayrollFixture } from "./testing/payroll-fixture";
import { PayrollRunControlService } from "./payroll-run-control.service";
import { HrBusinessPolicyService } from "../hr-administration/hr-business-policy.service";
import { ConfigurationRuleMappingService } from "../hr-administration/configuration-rule-mapping.service";

/** LIVE-12: overlapping regular runs are refused, and a tenant can forbid finalising a period that has not started. */
describe("Payroll run rules (LIVE-12)", () => {
  let f: PayrollFixture;

  beforeAll(async () => {
    f = await buildPayrollFixture("live12");
    await f.createEmployee({ userAccountId: f.staff.uid, monthlySalary: 150000 });
  }, 60000);
  afterAll(async () => {
    await f.cleanup();
  });

  it("refuses a regular run whose period overlaps an active regular run, but allows adjacent, cancelled and simulation cases", async () => {
    const first = await f.payroll.createRun(f.hr, { periodStart: "2041-09-01", periodEnd: "2041-09-30" });
    await expect(f.payroll.createRun(f.hr, { periodStart: "2041-09-29", periodEnd: "2041-10-28" })).rejects.toThrow(/overlaps an existing regular payroll run/);
    await expect(f.payroll.createRun(f.hr, { periodStart: "2041-09-10", periodEnd: "2041-09-12" })).rejects.toThrow(/overlaps/);
    // the day after the end is fine
    const next = await f.payroll.createRun(f.hr, { periodStart: "2041-10-01", periodEnd: "2041-10-31" });
    expect(next.status).toBe("draft");
    // simulations never count
    const sim = await f.payroll.createRun(f.hr, { periodStart: "2041-09-15", periodEnd: "2041-10-15", isSimulation: true });
    expect(sim.isSimulation).toBe(true);
    // once the first run is cancelled its period is free again
    await f.control.cancel(f.hr, first.id, "created by mistake");
    const again = await f.payroll.createRun(f.hr, { periodStart: "2041-09-29", periodEnd: "2041-09-30" });
    expect(again.status).toBe("draft");
  });

  it("with the payroll policy on, a run cannot be finalized before its period starts; without it nothing changes", async () => {
    const future = await f.payroll.createRun(f.hr, { periodStart: "2042-01-01", periodEnd: "2042-01-31" });
    await f.payroll.calculateRun(f.hr, future.id);
    await f.payroll.submitForApproval(f.hr, future.id);
    await f.payroll.decideApproval(f.approver, future.id, { decision: "approved" });

    await f.sql(
      `INSERT INTO hr_business_policies (company_id, policy_type, code, name, rules, is_default) VALUES ($1,'payroll','default','Payroll','{"blockFinalizeBeforePeriodStart": true}'::jsonb, true)`,
      [f.companyId]
    );
    const strictControl = new PayrollRunControlService(f.db, f.rbac, f.entitlements, f.audit, new HrBusinessPolicyService(f.db, f.rbac, f.entitlements, f.audit, new ConfigurationRuleMappingService(f.db, f.rbac, f.entitlements, f.audit)));
    const { PayrollService } = await import("./payroll.service");
    const { ImportExportService } = await import("../import-export/import-export.service");
    const { EffectiveDatingEngine } = await import("../effective-dating/effective-dating.engine");
    const strict = new PayrollService(
      f.db, f.rbac, f.entitlements, f.audit, new ImportExportService(), new EffectiveDatingEngine(), f.workflow,
      f.leaveRequests, f.overtime, f.workSchedule, undefined, undefined, f.loans, f.additionalPayments, f.offCyclePayments, strictControl
    );
    await expect(strict.finalizeRun(f.hr, future.id)).rejects.toThrow(/cannot be finalized yet: its period starts on 2042-01-01/);
    // the default service (no policy wired) still finalizes, so existing tenants are unaffected
    const done = await f.payroll.finalizeRun(f.hr, future.id);
    expect(done.status).toBe("finalized");
  });
});
