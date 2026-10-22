import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { sensitive } from "../crypto/sensitive-fields";
import { isPayrollAreaInScope, resolvePayrollAreaAccess } from "./payroll-area-access";
import type { PayrollStatutoryReportKind, PayrollStatutoryReportView } from "@aihxm/shared-types";

const MODULE_KEY = "payroll" as const;
const VIEW_BASES = ["payroll.calculate", "payroll.finalize", "payroll.disburse"];
const FINAL_STATUSES = ["finalized", "accounting", "payment_released", "reconciled", "closed", "reopened"];
const r2 = (n: number) => Math.round(n * 100) / 100;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const day = (v: any): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

type Def = { title: string; columns: Array<{ key: string; label: string; column: string }>; keep: string[] };

/** What each report lists and which payslip figures it takes. No rate or threshold lives here: the figures are those the run calculated. */
const REPORTS: Record<PayrollStatutoryReportKind, Def> = {
  income_tax: {
    title: "Income tax withheld from salary",
    columns: [
      { key: "grossPay", label: "Gross pay", column: "gross_pay" },
      { key: "taxableIncome", label: "Taxable income this period", column: "taxable_gross_this_period" },
      { key: "taxWithheld", label: "Tax withheld", column: "income_tax_monthly" },
    ],
    keep: [],
  },
  eobi: {
    title: "EOBI contributions",
    columns: [
      { key: "employee", label: "Employee share", column: "eobi_employee_contribution" },
      { key: "employer", label: "Employer share", column: "eobi_employer_contribution" },
    ],
    keep: ["eobi_employee_contribution", "eobi_employer_contribution"],
  },
  social_security: {
    title: "Social security contributions",
    columns: [{ key: "employer", label: "Employer contribution", column: "social_security_employer_contribution" }],
    keep: ["social_security_employer_contribution"],
  },
};

export const STATUTORY_REPORT_KINDS = Object.keys(REPORTS) as PayrollStatutoryReportKind[];

/**
 * Statutory reports for a finalised run (income tax withholding statement, EOBI, social security), built from the payslips as they were
 * finalised. Read only; the figures are never recomputed here, so a report always agrees with the payslips and the journal.
 */
@Injectable()
export class PayrollStatutoryReportsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async get(claims: RequestClaims, runId: string, kind: string): Promise<PayrollStatutoryReportView> {
    const def = REPORTS[kind as PayrollStatutoryReportKind];
    if (!def) throw new BadRequestException(`Unknown report "${kind}"; use ${STATUTORY_REPORT_KINDS.join(", ")}`);
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const access = await resolvePayrollAreaAccess(this.db, this.rbac, claims, VIEW_BASES);
    if (!access) throw new ForbiddenException("Not permitted to view statutory payroll reports");
    return this.db.withClaims(claims, async (client) => {
      const run = await client.query("SELECT id, status, period_start, period_end, payroll_area_id, run_type FROM payroll_runs WHERE id = $1", [runId]);
      if (!run.rowCount) throw new NotFoundException("Payroll run not found");
      const row = run.rows[0];
      if (!isPayrollAreaInScope(access, row.payroll_area_id)) {
        throw access.unrestricted ? new NotFoundException("Payroll run not found") : new ForbiddenException("This payroll run is outside your payroll area scope");
      }
      if (!FINAL_STATUSES.includes(row.status)) {
        throw new BadRequestException("A statutory report is only available for a finalised run, because it reports what was actually withheld");
      }
      const slips = await client.query(
        `SELECT p.company_id, p.employee_number, e.first_name, e.last_name, e.cnic, ${def.columns.map((c) => `p.${c.column}`).join(", ")}
           FROM payslips p JOIN employees e ON e.id = p.employee_id
          WHERE p.payroll_run_id = $1 ORDER BY p.employee_number`,
        [runId]
      );
      const rows = [];
      let omitted = 0;
      let missingCnic = 0;
      const totals = def.columns.map(() => 0);
      for (const s of slips.rows) {
        const values = def.columns.map((c) => r2(Number(s[c.column] ?? 0)));
        if (def.keep.length > 0 && !def.columns.some((c, i) => def.keep.includes(c.column) && values[i] !== 0)) {
          omitted += 1;
          continue;
        }
        const cnic = sensitive.decrypt(s.company_id, s.cnic);
        if (!cnic) missingCnic += 1;
        values.forEach((v, i) => (totals[i] += v));
        rows.push({ employeeNumber: s.employee_number as string, employeeName: `${s.first_name} ${s.last_name}`.trim(), cnic: cnic ?? null, values });
      }
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_statutory_report.view",
        target: runId,
        metadata: { kind, rows: rows.length },
      });
      return {
        kind: kind as PayrollStatutoryReportKind,
        title: def.title,
        payrollRunId: runId,
        periodStart: day(row.period_start),
        periodEnd: day(row.period_end),
        columns: def.columns.map(({ key, label }) => ({ key, label })),
        rows,
        totals: totals.map(r2),
        omittedCount: omitted,
        missingCnicCount: missingCnic,
      };
    });
  }

  async csv(claims: RequestClaims, runId: string, kind: string): Promise<string> {
    const report = await this.get(claims, runId, kind);
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      // a leading = + - @ would be read as a formula by a spreadsheet; names and CNICs never need one
      const safe = /^[=+@]/.test(s) ? `'${s}` : s;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const lines: string[][] = [["period_start", "period_end", "employee_number", "employee_name", "cnic", ...report.columns.map((c) => c.label)]];
    for (const r of report.rows) {
      lines.push([report.periodStart, report.periodEnd, r.employeeNumber, r.employeeName, r.cnic ?? "", ...r.values.map((v) => v.toFixed(2))]);
    }
    lines.push([report.periodStart, report.periodEnd, "", "TOTAL", "", ...report.totals.map((v) => v.toFixed(2))]);
    return lines.map((l) => l.map(esc).join(",")).join("\n") + "\n";
  }
}
