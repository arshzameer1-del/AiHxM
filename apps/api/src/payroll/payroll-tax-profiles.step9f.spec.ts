import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { buildPayrollFixture, type PayrollFixture } from "./testing/payroll-fixture";
import { PayrollTaxService } from "./payroll-tax.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import type { TaxProfileView } from "@aihxm/shared-types";

/**
 * Gap Register Step 9F - PAY-09 (tax years, profiles, exemptions, credits, evidence and publication) and PAY-10
 * (employee tax profile). Every rate, slab, cap and threshold below is an ILLUSTRATIVE TEST FIGURE chosen to make the
 * arithmetic easy to check - none of them is a statutory value and none is shipped anywhere.
 */
describe("Tax years, tax profiles and employee tax profiles (Step 9F)", () => {
  let f: PayrollFixture;
  let other: PayrollFixture;
  let tax: PayrollTaxService;
  let yearId: string;
  let base: TaxProfileView; // published: 0-100,000 at 0%, above at 10%, no extras
  let rich: TaxProfileView; // published: base slabs + exemption + credit + surcharge + rounding

  const SLABS = [
    { minAnnualIncome: 0, maxAnnualIncome: 100000, baseTax: 0, ratePercent: 0 },
    { minAnnualIncome: 100000, maxAnnualIncome: null, baseTax: 0, ratePercent: 10 },
  ];
  // the period the payroll tests run in: 2041-08 belongs to the tax year labelled 2042 (July 2041 - June 2042)
  const PERIOD = { periodStart: "2041-08-01", periodEnd: "2041-08-31" };
  const ELAPSED = 62 / 365; // 1 July - 31 August of a 365-day tax year

  beforeAll(async () => {
    f = await buildPayrollFixture("tax");
    other = await buildPayrollFixture("tax2");
    tax = new PayrollTaxService(f.db, f.rbac, f.entitlements, f.audit, new EffectiveDatingEngine());

    const year = await tax.createYear(f.hr, { label: "FY-T1", startDate: "2041-07-01", endDate: "2042-06-30" });
    yearId = year.id;
    await tax.publishYear(f.approver, yearId, { sourceReference: "Test notification 1/2041" });

    const mk = async (code: string) => {
      const p = await tax.createProfile(f.hr, { taxYearId: yearId, code, name: `Profile ${code}` });
      await tax.setProfileSlabs(f.hr, p.id, SLABS);
      return p;
    };
    const b = await mk("base");
    base = await tax.publishProfile(f.approver, b.id, { sourceReference: "Test schedule A" });

    const r = await mk("rich");
    await tax.updateProfile(f.hr, r.id, { surchargeThreshold: 100000, surchargeRatePercent: 10, roundingMode: "nearest", roundingIncrement: 100 });
    await tax.addExemption(f.hr, r.id, { code: "rent", name: "Rent relief", exemptionType: "fixed_amount", annualCap: 50000, requiresEvidence: true });
    await tax.addExemption(f.hr, r.id, { code: "pct", name: "Share of income", exemptionType: "percentage_of_income", ratePercent: 5, annualCap: 8000 });
    await tax.addCredit(f.hr, r.id, { code: "donation", name: "Donation credit", creditType: "fixed_amount", annualCap: 2000 });
    rich = await tax.publishProfile(f.approver, r.id, { sourceReference: "Test schedule B" });
  }, 120000);

  afterAll(async () => {
    await f.cleanup();
    await other.cleanup();
  });

  describe("publication lifecycle (PAY-09)", () => {
    it("keeps unpublished figures out of use and demands a source reference and the approval permission", async () => {
      const year = await tax.createYear(f.hr, { label: "FY-LC", startDate: "2051-07-01", endDate: "2052-06-30" });
      expect(year.status).toBe("draft");
      await expect(tax.createYear(f.hr, { label: "FY-LC", startDate: "2051-07-01", endDate: "2052-06-30" })).rejects.toBeInstanceOf(ConflictException);
      await expect(tax.createYear(f.hr, { label: "FY-BAD", startDate: "2052-06-30", endDate: "2051-07-01" })).rejects.toBeInstanceOf(BadRequestException);

      const profile = await tax.createProfile(f.hr, { taxYearId: year.id, code: "lc", name: "Lifecycle" });
      await expect(tax.publishProfile(f.approver, profile.id, { sourceReference: "Source doc 7" })).rejects.toThrow(/slabs/);
      await expect(tax.setProfileSlabs(f.hr, profile.id, [{ minAnnualIncome: 0, maxAnnualIncome: 100, baseTax: 0, ratePercent: 1 }])).rejects.toThrow(/null maxAnnualIncome/);
      await expect(
        tax.setProfileSlabs(f.hr, profile.id, [
          { minAnnualIncome: 0, maxAnnualIncome: 100, baseTax: 0, ratePercent: 1 },
          { minAnnualIncome: 200, maxAnnualIncome: null, baseTax: 0, ratePercent: 2 },
        ])
      ).rejects.toThrow(/contiguous/);
      await tax.setProfileSlabs(f.hr, profile.id, SLABS);
      await expect(tax.publishProfile(f.approver, profile.id, { sourceReference: "Source doc 7" })).rejects.toThrow(/Publish tax year/);
      await expect(tax.publishYear(f.approver, year.id, { sourceReference: "no" })).rejects.toBeInstanceOf(BadRequestException);
      await expect(tax.publishYear(f.staff, year.id, { sourceReference: "Source doc 8" })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(tax.publishYear(f.hr, year.id, { sourceReference: "Source doc 8" })).rejects.toBeInstanceOf(ForbiddenException); // the maker cannot approve
      const published = await tax.publishYear(f.approver, year.id, { sourceReference: "Source doc 8" });
      expect(published).toMatchObject({ status: "published", sourceReference: "Source doc 8" });
      expect(published.approvedBy).toBe(f.approver.sub);

      const live = await tax.publishProfile(f.approver, profile.id, { sourceReference: "Source doc 9" });
      expect(live).toMatchObject({ status: "published", sourceReference: "Source doc 9", approvedBy: f.approver.sub });
      // published = immutable
      await expect(tax.updateProfile(f.hr, profile.id, { name: "Changed" })).rejects.toThrow(/clone/);
      await expect(tax.setProfileSlabs(f.hr, profile.id, SLABS)).rejects.toThrow(/clone/);
      await expect(tax.addCredit(f.hr, profile.id, { code: "cc", name: "C", creditType: "fixed_amount" })).rejects.toThrow(/clone/);
      await expect(tax.updateYear(f.hr, year.id, { label: "X" })).rejects.toBeInstanceOf(BadRequestException);

      const copy = await tax.cloneProfile(f.hr, profile.id, { code: "lc_v2" });
      expect(copy).toMatchObject({ status: "draft", code: "lc_v2" });
      expect(copy.slabs.map((s) => s.ratePercent)).toEqual([0, 10]);
      expect((await tax.retireProfile(f.approver, profile.id)).status).toBe("retired");
      expect((await tax.retireYear(f.approver, year.id)).status).toBe("retired");
    });

    it("refuses overlapping published tax years of one jurisdiction", async () => {
      const clash = await tax.createYear(f.hr, { label: "FY-CLASH", startDate: "2041-12-01", endDate: "2042-12-01" });
      await expect(tax.publishYear(f.approver, clash.id, { sourceReference: "Source doc 10" })).rejects.toBeInstanceOf(ConflictException);
    });

    it("validates exemptions and credits, and rows carry the status/evidence columns in the database", async () => {
      const draft = await tax.createProfile(f.hr, { taxYearId: yearId, code: "validate", name: "Validate" });
      await expect(tax.addExemption(f.hr, draft.id, { code: "xx", name: "X", exemptionType: "percentage_of_income" })).rejects.toThrow(/ratePercent/);
      await expect(tax.addCredit(f.hr, draft.id, { code: "Bad Code", name: "C", creditType: "fixed_amount" })).rejects.toBeInstanceOf(BadRequestException);
      const withCredit = await tax.addCredit(f.hr, draft.id, { code: "c1", name: "C1", creditType: "percentage_of_amount", ratePercent: 20 });
      await expect(tax.addCredit(f.hr, draft.id, { code: "c1", name: "C1 again", creditType: "fixed_amount" })).rejects.toBeInstanceOf(ConflictException);
      expect((await tax.removeCredit(f.hr, draft.id, withCredit.credits[0].id)).credits).toHaveLength(0);

      const legacy = await f.sql<{ status: string }>("SELECT status FROM tax_slabs WHERE company_id = $1", [f.companyId]);
      expect(legacy.every((r) => r.status === "published")).toBe(true);
      const cols = await f.sql("SELECT column_name FROM information_schema.columns WHERE table_name = 'tax_slabs' AND column_name IN ('tax_year_id','status','source_reference','approved_by','approved_at')");
      expect(cols).toHaveLength(5);
    });
  });

  describe("employee tax profile (PAY-10)", () => {
    it("assigns only a published profile, validates claims and keeps effective-dated history", async () => {
      const draft = await tax.createProfile(f.hr, { taxYearId: yearId, code: "unpub", name: "Unpublished" });
      const e = await f.createEmployee({ monthlySalary: 50000 });
      await expect(tax.setEmployeeTaxProfile(f.hr, e.id, { effectiveFrom: "2041-07-01", taxProfileId: draft.id })).rejects.toThrow(/published/);
      await expect(tax.setEmployeeTaxProfile(f.staff, e.id, { effectiveFrom: "2041-07-01", taxProfileId: base.id })).rejects.toBeInstanceOf(ForbiddenException);

      // evidence is required where the exemption says so; a claim must belong to the profile
      const rent = rich.exemptions.find((x) => x.code === "rent")!;
      await expect(
        tax.setEmployeeTaxProfile(f.hr, e.id, { effectiveFrom: "2041-07-01", taxProfileId: rich.id, claimedExemptions: [{ exemptionId: rent.id, amount: 10000 }] })
      ).rejects.toThrow(/evidence/);
      await expect(
        tax.setEmployeeTaxProfile(f.hr, e.id, { effectiveFrom: "2041-07-01", taxProfileId: base.id, claimedExemptions: [{ exemptionId: rent.id, amount: 10000, evidenceRef: "R-1" }] })
      ).rejects.toThrow(/does not belong/);
      await expect(tax.setEmployeeTaxProfile(f.hr, e.id, { effectiveFrom: "2041-07-01", previousEmployerIncome: 1000 })).rejects.toThrow(/tax year/);
      await expect(
        tax.setEmployeeTaxProfile(f.hr, e.id, { effectiveFrom: "2041-07-01", previousEmployerIncome: 1000, previousEmployerTax: 2000, previousEmployerTaxYear: 2042 })
      ).rejects.toThrow(/exceed/);

      const first = await tax.setEmployeeTaxProfile(f.hr, e.id, {
        effectiveFrom: "2041-07-01", taxProfileId: rich.id, filerStatus: "filer", taxResidency: "resident", provincialScheme: "sessi",
        claimedExemptions: [{ exemptionId: rent.id, amount: 30000, evidenceRef: "R-77" }],
      });
      expect(first).toMatchObject({ taxProfileId: rich.id, taxProfileCode: "rich", filerStatus: "filer", provincialScheme: "sessi", effectiveTo: null });
      // an omitted field keeps its value; a change supersedes the row
      const second = await tax.setEmployeeTaxProfile(f.hr, e.id, { effectiveFrom: "2041-09-01", filerStatus: "non_filer" });
      expect(second).toMatchObject({ filerStatus: "non_filer", taxProfileId: rich.id, provincialScheme: "sessi" });
      expect(second.claimedExemptions).toHaveLength(1);
      const history = await tax.getEmployeeTaxProfileHistory(f.hr, e.id);
      expect(history.map((h) => [h.effectiveFrom, h.effectiveTo])).toEqual([["2041-09-01", null], ["2041-07-01", "2041-08-31"]]);
      expect((await tax.getEmployeeTaxProfile(f.hr, e.id))!.filerStatus).toBe("non_filer");
    });
  });

  describe("the payroll uses the profile (PAY-09, PAY-10)", () => {
    const people: Record<string, string> = {};
    let runId: string;

    async function incomeTax(employeeId: string) {
      const slips = await f.payroll.listPayslips(f.hr, { payrollRunId: runId });
      const slip = slips.find((s) => s.employeeId === employeeId)!;
      const detail = await f.payroll.getPayslipDetail(f.hr, slip.id);
      const line = detail.components.find((c) => c.key === "income_tax")!;
      return { amount: -line.amount, trace: line.trace as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    }

    beforeAll(async () => {
      const rent = rich.exemptions.find((x) => x.code === "rent")!;
      const donation = rich.credits.find((x) => x.code === "donation")!;
      const make = async (key: string, input: Parameters<PayrollTaxService["setEmployeeTaxProfile"]>[2] | null) => {
        const e = await f.createEmployee({ monthlySalary: 20000 });
        people[key] = e.id;
        if (input) await tax.setEmployeeTaxProfile(f.hr, e.id, input);
      };
      await make("plain", null);
      await make("base", { effectiveFrom: "2020-01-01", taxProfileId: base.id });
      await make("exempt", { effectiveFrom: "2020-01-01", taxProfileId: base.id });
      await make("rich", {
        effectiveFrom: "2020-01-01", taxProfileId: rich.id,
        claimedExemptions: [{ exemptionId: rent.id, amount: 30000, evidenceRef: "R-1" }],
        claimedCredits: [{ creditId: donation.id, amount: 5000 }],
      });
      await make("previous", { effectiveFrom: "2020-01-01", taxProfileId: base.id, previousEmployerIncome: 100000, previousEmployerTax: 5000, previousEmployerTaxYear: 2042 });
      await make("staleYear", { effectiveFrom: "2020-01-01", taxProfileId: base.id, previousEmployerIncome: 100000, previousEmployerTax: 5000, previousEmployerTaxYear: 2041 });
      runId = (await f.payroll.createRun(f.hr, PERIOD)).id;
      await f.payroll.calculateRun(f.hr, runId);
    }, 120000);

    it("leaves an employee without a profile on the company-wide slabs, exactly as before", async () => {
      const { trace } = await incomeTax(people.plain);
      expect(trace.taxProfile).toBeUndefined();
    });

    it("works the tax out from the profile's own slabs", async () => {
      const { amount, trace } = await incomeTax(people.base);
      const estimate = trace.estimatedAnnualTaxableIncome as number;
      expect(trace.taxProfile.profile).toMatchObject({ code: "base", taxYear: "FY-T1" });
      expect(amount).toBeCloseTo(Math.max(0, (estimate - 100000) * 0.1) * ELAPSED, 1);
      expect(trace.bracket).toMatchObject({ min: 100000, ratePercent: 10 });
    });

    it("applies claimed exemptions, credits, surcharge and rounding in that order", async () => {
      const { amount, trace } = await incomeTax(people.rich);
      const estimate = trace.estimatedAnnualTaxableIncome as number;
      expect(trace.taxProfile.exemptionsApplied).toEqual([{ code: "rent", amount: 30000 }]); // only what the employee claimed
      const taxable = Math.max(0, estimate - 30000);
      const afterCredit = Math.max(0, (taxable - 100000) * 0.1 - 2000); // claimed 5,000 but the credit is capped at 2,000
      const annual = Math.round((afterCredit * 1.1) / 100) * 100; // surcharge above the threshold, then round to the nearest 100
      expect(trace.taxProfile.creditsApplied).toEqual([{ code: "donation", amount: 2000 }]);
      expect(trace.slabAnnualTax).toBe(annual);
      expect(amount).toBeCloseTo(annual * ELAPSED, 1);
    });

    it("adds the previous employer's income and tax of the same tax year, and ignores another year's", async () => {
      const prev = await incomeTax(people.previous);
      expect(prev.trace.priorYtdTaxable).toBe(100000);
      expect(prev.trace.priorYtdTaxWithheld).toBe(5000);
      const estimate = prev.trace.estimatedAnnualTaxableIncome as number;
      expect(estimate).toBeGreaterThan(100000);
      expect(prev.amount).toBeCloseTo(Math.max(0, ((estimate - 100000) * 0.1) * ELAPSED - 5000), 1);

      const stale = await incomeTax(people.staleYear);
      expect(stale.trace.priorYtdTaxable).toBe(0);
      expect(stale.trace.priorYtdTaxWithheld).toBe(0);
    });

    it("records the profile in the payslip's input snapshot", async () => {
      const slips = await f.payroll.listPayslips(f.hr, { payrollRunId: runId });
      const slip = slips.find((s) => s.employeeId === people.rich)!;
      const snap = (await f.sql<{ snapshot: { tax: { profile: { code: string; filerStatus: string } | null } } }>("SELECT snapshot FROM payroll_input_snapshots WHERE payslip_id = $1", [slip.id]))[0];
      expect(snap.snapshot.tax.profile).toMatchObject({ code: "rich", filerStatus: "filer" });
    });

    it("reports a profile whose tax year does not cover the period instead of using wrong slabs", async () => {
      const late = await f.payroll.createRun(f.hr, { periodStart: "2043-01-01", periodEnd: "2043-01-31" });
      const res = await f.payroll.calculateRun(f.hr, late.id);
      const mine = res.errors.find((e) => e.employeeId === people.base);
      expect(mine?.message).toMatch(/does not cover this period/);
      // the employee with no profile is unaffected
      expect(res.errors.find((e) => e.employeeId === people.plain)).toBeUndefined();
    });
  });

  describe("isolation and schema", () => {
    it("keeps tax configuration inside its tenant", async () => {
      await expect(tax.getProfile(other.hr, base.id)).rejects.toBeInstanceOf(NotFoundException);
      expect(await tax.listYears(other.hr)).toEqual([]);
      const seen = await other.db.withClaims(other.hr, async (c) =>
        (await c.query("SELECT (SELECT COUNT(*) FROM tax_profiles) AS p, (SELECT COUNT(*) FROM employee_tax_profiles) AS e, (SELECT COUNT(*) FROM tax_exemptions) AS x")).rows[0]
      );
      expect(Number(seen.p) + Number(seen.e) + Number(seen.x)).toBe(0);
    });

    it("opens payroll_formulas.formula_key to a key-format check and forces row security on the new tables", async () => {
      await f.sql("INSERT INTO payroll_formulas (company_id, formula_key, expression, effective_from) VALUES ($1, 'custom_statutory_key', '{\"const\":1}'::jsonb, '2041-01-01')", [f.companyId]);
      await expect(f.sql("INSERT INTO payroll_formulas (company_id, formula_key, expression, effective_from) VALUES ($1, 'Bad Key', '{\"const\":1}'::jsonb, '2042-01-01')", [f.companyId])).rejects.toThrow();
      const rls = await f.sql<{ relname: string; relforcerowsecurity: boolean }>(
        "SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('tax_years','tax_profiles','tax_profile_slabs','tax_exemptions','tax_credits','employee_tax_profiles')"
      );
      expect(rls).toHaveLength(6);
      expect(rls.every((r) => r.relforcerowsecurity)).toBe(true);
    });
  });
});
