import { BadRequestException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { TaxSlabView } from "@aihxm/shared-types";

/**
 * PAY-09 / PAY-10 - the data-driven side of income tax. When an employee has a tax profile in force on the run's period
 * end, the profile's own published slabs, exemptions, credits, surcharge and rounding replace the company-wide slab
 * table for that employee, and the previous employer's income and tax for the same tax year are added to the year to
 * date. Without a profile nothing changes: the company-wide `tax_slabs` flow is used exactly as before.
 *
 * Nothing here knows a statutory figure - every number comes from rows the tenant entered and published with a source
 * reference.
 */

export type TaxClaim = { id: string; code: string; name: string; type: string; annualCap: number | null; ratePercent: number | null; claimed: number };

export type EmployeeTaxContext = {
  employeeTaxProfileId: string;
  profileId: string;
  profileCode: string;
  profileName: string;
  taxYearLabel: string;
  filerStatus: string;
  taxResidency: string;
  provincialScheme: string | null;
  slabs: TaxSlabView[];
  exemptions: TaxClaim[];
  credits: TaxClaim[];
  surchargeThreshold: number | null;
  surchargeRatePercent: number | null;
  roundingMode: "none" | "nearest" | "up" | "down";
  roundingIncrement: number;
  /** Only the previous-employer figures that belong to the tax year being calculated. */
  previousEmployerIncome: number;
  previousEmployerTax: number;
};

export type AnnualTaxResult = {
  taxableForSlabs: number;
  exemptionsApplied: Array<{ code: string; amount: number }>;
  slabTax: number;
  creditsApplied: Array<{ code: string; amount: number }>;
  surcharge: number;
  annualTax: number;
};

const num = (v: unknown) => Number(v);
const dateStr = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/** The tax context of an employee for a period, or null when the employee has no tax profile assigned. */
export async function loadEmployeeTaxContext(
  client: PoolClient,
  employeeId: string,
  periodStart: string,
  periodEnd: string,
  taxYearEndingLabel: number
): Promise<EmployeeTaxContext | null> {
  const assignment = await client.query(
    `SELECT * FROM employee_tax_profiles WHERE employee_id = $1 AND effective_from <= $2 AND (effective_to IS NULL OR effective_to >= $2)`,
    [employeeId, periodEnd]
  );
  if (assignment.rowCount === 0) return null;
  const a = assignment.rows[0];
  if (!a.tax_profile_id) return null; // only filer status / previous employer details recorded, no profile chosen

  const profileRow = await client.query(
    `SELECT p.*, y.label AS year_label, y.start_date AS year_start, y.end_date AS year_end, y.status AS year_status
       FROM tax_profiles p JOIN tax_years y ON y.id = p.tax_year_id WHERE p.id = $1`,
    [a.tax_profile_id]
  );
  const p = profileRow.rows[0];
  if (!p) throw new BadRequestException("The employee's tax profile no longer exists");
  if (p.status === "draft" || p.year_status === "draft") {
    throw new BadRequestException(`Tax profile "${p.name}" has not been published yet; publish it or assign another profile`);
  }
  if (dateStr(p.year_start) > periodEnd || dateStr(p.year_end) < periodEnd) {
    throw new BadRequestException(
      `Tax profile "${p.name}" belongs to tax year ${p.year_label} (${dateStr(p.year_start)} to ${dateStr(p.year_end)}), which does not cover this period; assign the profile of the right tax year`
    );
  }

  const slabs = await client.query("SELECT * FROM tax_profile_slabs WHERE tax_profile_id = $1 ORDER BY min_annual_income", [p.id]);
  if (slabs.rowCount === 0) throw new BadRequestException(`Tax profile "${p.name}" has no slabs`);
  const [exemptions, credits] = await Promise.all([
    client.query("SELECT * FROM tax_exemptions WHERE tax_profile_id = $1", [p.id]),
    client.query("SELECT * FROM tax_credits WHERE tax_profile_id = $1", [p.id]),
  ]);
  const claims = (list: unknown, key: "exemptionId" | "creditId", rows: Array<Record<string, any>>, typeColumn: string): TaxClaim[] => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const out: TaxClaim[] = [];
    for (const entry of Array.isArray(list) ? (list as Array<Record<string, unknown>>) : []) {
      const def = rows.find((r) => r.id === entry[key]);
      if (!def) continue; // a claim for something of another profile is ignored, never applied
      out.push({
        id: def.id,
        code: def.code,
        name: def.name,
        type: def[typeColumn],
        annualCap: def.annual_cap === null ? null : num(def.annual_cap),
        ratePercent: def.rate_percent === null ? null : num(def.rate_percent),
        claimed: num(entry.amount ?? 0),
      });
    }
    return out;
  };

  const prevApplies = a.previous_employer_tax_year !== null && Number(a.previous_employer_tax_year) === taxYearEndingLabel;
  return {
    employeeTaxProfileId: a.id,
    profileId: p.id,
    profileCode: p.code,
    profileName: p.name,
    taxYearLabel: p.year_label,
    filerStatus: a.filer_status,
    taxResidency: a.tax_residency,
    provincialScheme: a.provincial_scheme ?? null,
    slabs: slabs.rows.map((s) => ({
      id: s.id,
      companyId: s.company_id,
      minAnnualIncome: num(s.min_annual_income),
      maxAnnualIncome: s.max_annual_income === null ? null : num(s.max_annual_income),
      baseTax: num(s.base_tax),
      ratePercent: num(s.rate_percent),
      effectiveFrom: dateStr(p.year_start),
      effectiveTo: dateStr(p.year_end),
    })),
    exemptions: claims(a.claimed_exemptions, "exemptionId", exemptions.rows, "exemption_type"),
    credits: claims(a.claimed_credits, "creditId", credits.rows, "credit_type"),
    surchargeThreshold: p.surcharge_threshold === null ? null : num(p.surcharge_threshold),
    surchargeRatePercent: p.surcharge_rate_percent === null ? null : num(p.surcharge_rate_percent),
    roundingMode: p.rounding_mode,
    roundingIncrement: num(p.rounding_increment),
    previousEmployerIncome: prevApplies ? num(a.previous_employer_income) : 0,
    previousEmployerTax: prevApplies ? num(a.previous_employer_tax) : 0,
  };
}

function round(value: number, mode: EmployeeTaxContext["roundingMode"], increment: number): number {
  if (mode === "none" || increment <= 0) return value;
  const q = value / increment;
  return (mode === "up" ? Math.ceil(q) : mode === "down" ? Math.floor(q) : Math.round(q)) * increment;
}

/** The annual tax of an estimated taxable income under a profile: exemptions, slabs, credits, surcharge, rounding. */
export function computeAnnualTax(ctx: EmployeeTaxContext, income: number, taxFromSlabs: (income: number, slabs: TaxSlabView[]) => number): AnnualTaxResult {
  const exemptionsApplied = ctx.exemptions.map((e) => {
    const raw = e.type === "percentage_of_income" ? ((e.ratePercent ?? 0) / 100) * income : e.claimed;
    return { code: e.code, amount: Math.max(0, Math.min(raw, e.annualCap ?? Number.POSITIVE_INFINITY)) };
  });
  const taxableForSlabs = Math.max(0, income - exemptionsApplied.reduce((a, e) => a + e.amount, 0));
  const slabTax = taxFromSlabs(taxableForSlabs, ctx.slabs);
  const creditsApplied = ctx.credits.map((c) => {
    const raw = c.type === "percentage_of_amount" ? ((c.ratePercent ?? 0) / 100) * c.claimed : c.claimed;
    return { code: c.code, amount: Math.max(0, Math.min(raw, c.annualCap ?? Number.POSITIVE_INFINITY)) };
  });
  const afterCredits = Math.max(0, slabTax - creditsApplied.reduce((a, c) => a + c.amount, 0));
  const surcharge =
    ctx.surchargeThreshold !== null && ctx.surchargeRatePercent !== null && taxableForSlabs > ctx.surchargeThreshold ? (afterCredits * ctx.surchargeRatePercent) / 100 : 0;
  const annualTax = Math.max(0, round(afterCredits + surcharge, ctx.roundingMode, ctx.roundingIncrement));
  return { taxableForSlabs, exemptionsApplied, slabTax, creditsApplied, surcharge, annualTax };
}

export function taxProfileTrace(ctx: EmployeeTaxContext, result: AnnualTaxResult): Record<string, unknown> {
  return {
    profile: { id: ctx.profileId, code: ctx.profileCode, name: ctx.profileName, taxYear: ctx.taxYearLabel },
    filerStatus: ctx.filerStatus,
    taxResidency: ctx.taxResidency,
    provincialScheme: ctx.provincialScheme,
    previousEmployer: { income: ctx.previousEmployerIncome, tax: ctx.previousEmployerTax },
    exemptionsApplied: result.exemptionsApplied,
    creditsApplied: result.creditsApplied,
    surcharge: result.surcharge,
    taxableForSlabs: result.taxableForSlabs,
    slabTax: result.slabTax,
  };
}
