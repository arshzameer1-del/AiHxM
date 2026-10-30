import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AnnualSalaryStatementView,
  LevyWorksheetView,
  MinimumWageRateView,
  SaveLevyWorksheetRequest,
  SaveMinimumWageRequest,
} from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { sensitive } from "../crypto/sensitive-fields";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { isPayrollAreaInScope, resolvePayrollAreaAccess } from "../payroll/payroll-area-access";
import { RbacService } from "../rbac/rbac.service";

const FINAL_STATUSES = ["finalized", "accounting", "payment_released", "reconciled", "closed", "reopened"];
const VIEW_BASES = ["payroll.calculate", "payroll.finalize", "payroll.disburse"];
const r2 = (n: number) => Math.round(n * 100) / 100;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const day = (v: any): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Statutory working papers. The minimum-wage table and the levy worksheets are typed in by the company: no rate, threshold or
 * province ships with the product. The annual salary statement is a straight total of the payslips already finalised, never recomputed.
 */
@Injectable()
export class ComplianceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  // ------------------------------------------------------------ minimum wage
  async listMinimumWages(claims: RequestClaims): Promise<MinimumWageRateView[]> {
    await this.require(claims, "minimum_wage.manage", "payroll");
    return this.db.withClaims(claims, async (c) => {
      const r = await c.query("SELECT * FROM minimum_wage_rates WHERE company_id = $1 ORDER BY lower(province), effective_from DESC", [claims.company_id]);
      return r.rows.map((x) => ({ id: x.id, province: x.province, monthlyAmount: Number(x.monthly_amount), effectiveFrom: day(x.effective_from), sourceNote: x.source_note }));
    });
  }

  async saveMinimumWage(claims: RequestClaims, input: SaveMinimumWageRequest): Promise<MinimumWageRateView[]> {
    await this.require(claims, "minimum_wage.manage", "payroll");
    const province = (input.province ?? "").trim();
    if (!province || province.length > 80) throw new BadRequestException("Enter the province or area this minimum wage applies to");
    if (!(Number(input.monthlyAmount) > 0)) throw new BadRequestException("The monthly minimum wage must be more than zero");
    if (!DATE.test(input.effectiveFrom ?? "")) throw new BadRequestException("Enter the date this minimum wage starts");
    const note = input.sourceNote?.trim() || null;
    if (note && note.length > 500) throw new BadRequestException("The source note is too long");
    await this.db.withClaims(claims, async (c) => {
      const exists = await c.query("SELECT 1 FROM minimum_wage_rates WHERE company_id = $1 AND lower(btrim(province)) = lower($2) AND effective_from = $3", [claims.company_id, province, input.effectiveFrom]);
      if (exists.rowCount) throw new ConflictException("A minimum wage for this province and date is already recorded. Delete it first to change it.");
      const r = await c.query(
        "INSERT INTO minimum_wage_rates (company_id, province, monthly_amount, effective_from, source_note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [claims.company_id, province, Number(input.monthlyAmount).toFixed(2), input.effectiveFrom, note, claims.sub ?? null]
      );
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "minimum_wage.create", target: r.rows[0].id, metadata: { province, effectiveFrom: input.effectiveFrom } });
    });
    return this.listMinimumWages(claims);
  }

  async deleteMinimumWage(claims: RequestClaims, id: string): Promise<MinimumWageRateView[]> {
    await this.require(claims, "minimum_wage.manage", "payroll");
    await this.db.withClaims(claims, async (c) => {
      const r = await c.query("DELETE FROM minimum_wage_rates WHERE id = $1 RETURNING province, effective_from", [id]);
      if (!r.rowCount) throw new NotFoundException("Minimum wage entry not found");
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "minimum_wage.delete", target: id, metadata: { province: r.rows[0].province } });
    });
    return this.listMinimumWages(claims);
  }

  // ------------------------------------------------------------ levy worksheets
  async listLevies(claims: RequestClaims): Promise<LevyWorksheetView[]> {
    await this.require(claims, "levy.manage", "payroll");
    return this.db.withClaims(claims, async (c) => {
      const r = await c.query("SELECT * FROM levy_worksheets WHERE company_id = $1 ORDER BY created_at DESC LIMIT 200", [claims.company_id]);
      return r.rows.map(toLevy);
    });
  }

  /** The amount is simply base x rate, shown for a person to review. Nothing is deducted, posted or paid from it. */
  async createLevy(claims: RequestClaims, input: SaveLevyWorksheetRequest): Promise<LevyWorksheetView> {
    await this.require(claims, "levy.manage", "payroll");
    if (!["wwf", "wppf"].includes(input.kind)) throw new BadRequestException("kind must be wwf or wppf");
    const fiscalYear = (input.fiscalYear ?? "").trim();
    const baseLabel = (input.baseLabel ?? "").trim();
    if (!fiscalYear || fiscalYear.length > 20) throw new BadRequestException("Enter the year this worksheet is for, for example 2025-26");
    if (!baseLabel || baseLabel.length > 120) throw new BadRequestException("Say what the base figure is, for example profit before tax");
    const base = Number(input.baseAmount);
    const rate = Number(input.ratePercent);
    if (!Number.isFinite(base) || base < 0) throw new BadRequestException("The base amount cannot be negative");
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new BadRequestException("The rate must be between 0 and 100 percent");
    const notes = input.notes?.trim() || null;
    if (notes && notes.length > 1000) throw new BadRequestException("The notes are too long");
    return this.db.withClaims(claims, async (c) => {
      const r = await c.query(
        `INSERT INTO levy_worksheets (company_id, kind, fiscal_year, base_label, base_amount, rate_percent, amount, notes, prepared_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [claims.company_id, input.kind, fiscalYear, baseLabel, base.toFixed(2), rate.toFixed(3), r2((base * rate) / 100).toFixed(2), notes, claims.sub ?? null]
      );
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "levy_worksheet.create", target: r.rows[0].id, metadata: { kind: input.kind, fiscalYear } });
      return toLevy(r.rows[0]);
    });
  }

  async finalizeLevy(claims: RequestClaims, id: string): Promise<LevyWorksheetView> {
    await this.require(claims, "levy.manage", "payroll");
    return this.db.withClaims(claims, async (c) => {
      const cur = (await c.query("SELECT * FROM levy_worksheets WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!cur) throw new NotFoundException("Worksheet not found");
      if (cur.status === "final") throw new ConflictException("This worksheet is already final");
      const r = await c.query("UPDATE levy_worksheets SET status = 'final', finalized_at = now() WHERE id = $1 RETURNING *", [id]);
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "levy_worksheet.finalize", target: id, metadata: { kind: cur.kind } });
      return toLevy(r.rows[0]);
    });
  }

  async deleteLevy(claims: RequestClaims, id: string): Promise<void> {
    await this.require(claims, "levy.manage", "payroll");
    await this.db.withClaims(claims, async (c) => {
      const cur = (await c.query("SELECT status FROM levy_worksheets WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!cur) throw new NotFoundException("Worksheet not found");
      if (cur.status === "final") throw new ConflictException("A final worksheet cannot be deleted");
      await c.query("DELETE FROM levy_worksheets WHERE id = $1", [id]);
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "levy_worksheet.delete", target: id, metadata: {} });
    });
  }

  // ------------------------------------------------------------ annual salary statement
  /** Pakistan's tax year runs 1 July to 30 June. `startYear` is the year it begins in. */
  async annualSalaryStatement(claims: RequestClaims, startYear: number): Promise<AnnualSalaryStatementView> {
    if (!Number.isInteger(startYear) || startYear < 2000 || startYear > 2100) throw new BadRequestException("Enter the year the tax year starts in, for example 2025");
    if (!(await this.entitlements.isModuleEnabled(claims, "payroll"))) throw new NotFoundException();
    const access = await resolvePayrollAreaAccess(this.db, this.rbac, claims, VIEW_BASES);
    if (!access) throw new ForbiddenException("Not permitted to view statutory payroll reports");
    const start = `${startYear}-07-01`;
    const end = `${startYear + 1}-06-30`;
    return this.db.withClaims(claims, async (c) => {
      const runs = await c.query(
        "SELECT id, payroll_area_id FROM payroll_runs WHERE company_id = $1 AND run_type IN ('regular','off_cycle') AND status = ANY($2) AND period_start >= $3 AND period_start <= $4",
        [claims.company_id, FINAL_STATUSES, start, end]
      );
      const ids = runs.rows.filter((r) => isPayrollAreaInScope(access, r.payroll_area_id)).map((r) => r.id as string);
      const rows: AnnualSalaryStatementView["rows"] = [];
      let missing = 0;
      if (ids.length) {
        const s = await c.query(
          `SELECT p.company_id, p.employee_number, e.first_name, e.last_name, e.cnic,
                  count(DISTINCT p.payroll_run_id)::int AS months, sum(p.gross_pay) AS gross, sum(p.taxable_gross_this_period) AS taxable,
                  sum(p.income_tax_monthly) AS tax, sum(p.eobi_employee_contribution) AS eobi
             FROM payslips p JOIN employees e ON e.id = p.employee_id
            WHERE p.payroll_run_id = ANY($1)
            GROUP BY p.company_id, p.employee_number, e.first_name, e.last_name, e.cnic ORDER BY p.employee_number`,
          [ids]
        );
        for (const x of s.rows) {
          const cnic = sensitive.decrypt(x.company_id, x.cnic) ?? null;
          if (!cnic) missing += 1;
          rows.push({
            employeeNumber: x.employee_number,
            employeeName: `${x.first_name} ${x.last_name}`.trim(),
            cnic,
            monthsPaid: x.months,
            grossPay: r2(Number(x.gross)),
            taxableIncome: r2(Number(x.taxable)),
            taxWithheld: r2(Number(x.tax)),
            eobiEmployee: r2(Number(x.eobi)),
          });
        }
      }
      const sum = (k: "grossPay" | "taxableIncome" | "taxWithheld" | "eobiEmployee") => r2(rows.reduce((a, r) => a + r[k], 0));
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "annual_salary_statement.view", target: start, metadata: { rows: rows.length, runs: ids.length } });
      return {
        taxYearStart: start,
        taxYearEnd: end,
        runCount: ids.length,
        rows,
        totals: { grossPay: sum("grossPay"), taxableIncome: sum("taxableIncome"), taxWithheld: sum("taxWithheld"), eobiEmployee: sum("eobiEmployee") },
        missingCnicCount: missing,
        note: "Totals of the payslips in finalised runs for this tax year. Check them against the layout your tax adviser or the authority's portal asks for before filing; this is a working file, not a filed return.",
      };
    });
  }

  async annualSalaryStatementCsv(claims: RequestClaims, startYear: number): Promise<string> {
    const v = await this.annualSalaryStatement(claims, startYear);
    const esc = (x: unknown) => {
      const s = x === null || x === undefined ? "" : String(x);
      const safe = /^[=+@]/.test(s) ? `'${s}` : s;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const lines = [["tax_year_start", "tax_year_end", "employee_number", "employee_name", "cnic", "months_paid", "gross_pay", "taxable_income", "tax_withheld", "eobi_employee"]];
    for (const r of v.rows) lines.push([v.taxYearStart, v.taxYearEnd, r.employeeNumber, r.employeeName, r.cnic ?? "", String(r.monthsPaid), r.grossPay.toFixed(2), r.taxableIncome.toFixed(2), r.taxWithheld.toFixed(2), r.eobiEmployee.toFixed(2)]);
    lines.push([v.taxYearStart, v.taxYearEnd, "", "TOTAL", "", "", v.totals.grossPay.toFixed(2), v.totals.taxableIncome.toFixed(2), v.totals.taxWithheld.toFixed(2), v.totals.eobiEmployee.toFixed(2)]);
    return lines.map((l) => l.map(esc).join(",")).join("\n") + "\n";
  }

  private async require(claims: RequestClaims, permission: string, module: "payroll" | "employee"): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, module))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, permission))) throw new ForbiddenException("Not permitted");
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toLevy(x: any): LevyWorksheetView {
  return {
    id: x.id,
    kind: x.kind,
    fiscalYear: x.fiscal_year,
    baseLabel: x.base_label,
    baseAmount: Number(x.base_amount),
    ratePercent: Number(x.rate_percent),
    amount: Number(x.amount),
    notes: x.notes,
    status: x.status,
    finalizedAt: x.finalized_at ? x.finalized_at.toISOString() : null,
    createdAt: x.created_at.toISOString(),
  };
}
