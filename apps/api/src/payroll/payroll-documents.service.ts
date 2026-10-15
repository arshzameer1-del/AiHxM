import { createHash } from "node:crypto";
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { sensitive } from "../crypto/sensitive-fields";
import { currentCorrelationId } from "../common/request-context";
import { isPayrollAreaInScope, resolvePayrollAreaAccess } from "./payroll-area-access";
import { payrollRunHooks, type RunRow } from "./payroll-run-hooks";
import type {
  GeneratedDocumentView,
  GenerateSalaryCertificateRequest,
  GenerateTaxCertificateRequest,
  PayrollDocumentPlaceholderView,
  PayrollDocumentSettingsView,
  PayrollDocumentType,
  UpdatePayrollDocumentSettingsRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "payroll" as const;
const CONFIG_PERMISSION = "payroll.calculate.all";
const ACT_BASE = "payroll.finalize";
const VIEW_BASES = ["payroll.calculate", "payroll.finalize", "payroll.disburse"];
const SELF_VIEW_PERMISSION = "payroll_review.view.self";
const DOCUMENT_TYPES: PayrollDocumentType[] = ["payslip", "tax_certificate", "salary_certificate"];
const ISSUABLE_RUN_STATUSES = ["finalized", "accounting", "payment_released", "reconciled", "closed", "reopened"];

const money = (n: number | string, currency = "PKR") => {
  const v = Number(n);
  const [whole, frac] = Math.abs(v).toFixed(2).split(".");
  return `${v < 0 ? "-" : ""}${currency} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const day = (v: any): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const iso = (v: any): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));
const pad = (s: string, w: number) => (s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length));
const padL = (s: string, w: number) => (s.length >= w ? s : " ".repeat(w - s.length) + s);

/** Tax years are labelled by the calendar year they end in; 1 July - 30 June (the same convention as the payroll engine). */
export function taxYearBounds(label: number): { start: string; end: string } {
  return { start: `${label - 1}-07-01`, end: `${label}-06-30` };
}

/** The `{{placeholder}}` catalogue each document type offers to a custom template. */
export const DOCUMENT_PLACEHOLDERS: Record<PayrollDocumentType, Array<{ key: string; description: string }>> = {
  payslip: [
    { key: "companyName", description: "Employer name" },
    { key: "employeeName", description: "Employee name" },
    { key: "employeeNumber", description: "Employee number" },
    { key: "periodStart", description: "First day of the pay period" },
    { key: "periodEnd", description: "Last day of the pay period" },
    { key: "paidDays", description: "Days paid in the period" },
    { key: "daysInPeriod", description: "Days in the period" },
    { key: "grossPay", description: "Gross pay" },
    { key: "incomeTax", description: "Income tax withheld" },
    { key: "netPay", description: "Net pay" },
    { key: "earningsTable", description: "One line per earning" },
    { key: "deductionsTable", description: "One line per deduction" },
    { key: "issueDate", description: "Date the document was generated" },
  ],
  tax_certificate: [
    { key: "companyName", description: "Employer name" },
    { key: "employeeName", description: "Employee name" },
    { key: "employeeNumber", description: "Employee number" },
    { key: "employeeCnic", description: "Employee CNIC, when on file" },
    { key: "employeeNtn", description: "Employee NTN, when on file" },
    { key: "taxYear", description: "Tax year label (the calendar year it ends in)" },
    { key: "taxYearStart", description: "First day of the tax year" },
    { key: "taxYearEnd", description: "Last day of the tax year" },
    { key: "grossPay", description: "Gross pay in the tax year" },
    { key: "taxableGross", description: "Taxable gross in the tax year" },
    { key: "incomeTax", description: "Income tax withheld in the tax year" },
    { key: "eobiEmployee", description: "Employee EOBI contributions" },
    { key: "netPay", description: "Net pay in the tax year" },
    { key: "payslipCount", description: "Payslips in the tax year" },
    { key: "monthlyTable", description: "One line per pay period: gross and tax" },
    { key: "issueDate", description: "Date the document was generated" },
  ],
  salary_certificate: [
    { key: "companyName", description: "Employer name" },
    { key: "employeeName", description: "Employee name" },
    { key: "employeeNumber", description: "Employee number" },
    { key: "designation", description: "Position title / designation" },
    { key: "dateOfJoining", description: "Date of joining" },
    { key: "monthlyGross", description: "Current monthly gross (sum of earning components)" },
    { key: "componentTable", description: "One line per earning component" },
    { key: "addressedTo", description: "Who the certificate is addressed to" },
    { key: "purpose", description: "Stated purpose" },
    { key: "issueDate", description: "Date the document was generated" },
  ],
};

const BUILT_IN_BODIES: Record<PayrollDocumentType, { title: string; body: string }> = {
  payslip: {
    title: "Payslip {{periodStart}} to {{periodEnd}}",
    body: [
      "{{companyName}}",
      "PAYSLIP  {{periodStart}} to {{periodEnd}}",
      "",
      "Employee: {{employeeName}} ({{employeeNumber}})",
      "Paid days: {{paidDays}} of {{daysInPeriod}}",
      "",
      "EARNINGS",
      "{{earningsTable}}",
      "Gross pay: {{grossPay}}",
      "",
      "DEDUCTIONS",
      "{{deductionsTable}}",
      "",
      "NET PAY: {{netPay}}",
      "",
      "Generated {{issueDate}}",
    ].join("\n"),
  },
  tax_certificate: {
    title: "Annual tax certificate - tax year {{taxYear}}",
    body: [
      "{{companyName}}",
      "CERTIFICATE OF SALARY AND TAX DEDUCTED - TAX YEAR {{taxYear}} ({{taxYearStart}} to {{taxYearEnd}})",
      "",
      "This is to certify that {{employeeName}} (employee {{employeeNumber}}, CNIC {{employeeCnic}}, NTN {{employeeNtn}}) was paid the following by {{companyName}} in the tax year, from which income tax was withheld.",
      "",
      "Gross salary:   {{grossPay}}",
      "Taxable salary: {{taxableGross}}",
      "Tax withheld:   {{incomeTax}}",
      "Net paid:       {{netPay}}",
      "Payslips:       {{payslipCount}}",
      "",
      "{{monthlyTable}}",
      "",
      "Issued {{issueDate}}",
    ].join("\n"),
  },
  salary_certificate: {
    title: "Salary certificate - {{employeeName}}",
    body: [
      "{{companyName}}",
      "SALARY CERTIFICATE",
      "",
      "To: {{addressedTo}}",
      "",
      "This is to certify that {{employeeName}} (employee {{employeeNumber}}) is employed with {{companyName}} as {{designation}} since {{dateOfJoining}}. The current monthly gross salary is {{monthlyGross}}:",
      "",
      "{{componentTable}}",
      "",
      "This certificate is issued at the employee's request for: {{purpose}}.",
      "",
      "Issued {{issueDate}}",
    ].join("\n"),
  },
};

/** `{{key}}` substitution - the same minimal engine DocumentTemplatesService uses; an unknown key renders empty. */
export function renderPlaceholders(body: string, data: Record<string, string>): string {
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => data[key] ?? "");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(r: any, withContent: boolean): GeneratedDocumentView {
  return {
    id: r.id,
    documentType: r.document_type,
    employeeId: r.employee_id,
    employeeNumber: r.employee_number ?? null,
    employeeName: r.employee_name ?? null,
    payrollRunId: r.payroll_run_id ?? null,
    payslipId: r.payslip_id ?? null,
    taxYear: r.tax_year === null || r.tax_year === undefined ? null : Number(r.tax_year),
    templateKey: r.template_key ?? null,
    templateSource: r.template_source,
    title: r.title,
    status: r.status,
    publishedAt: iso(r.published_at),
    generatedAt: iso(r.generated_at) as string,
    contentHash: r.content_hash,
    revokeReason: r.revoke_reason ?? null,
    ...(withContent ? { content: r.content } : {}),
  };
}

/**
 * PAY-20 - payslips and certificates as documents. What an employee is given is a stored, hashed, immutable rendering
 * made from a template the tenant chose (or the built-in body), not a view recomputed on request:
 *
 *   payslip            one per payslip, generated for a finalised run; visible to the employee once published when the
 *                      tenant requires publication (otherwise as soon as the run is finalised, as before)
 *   tax_certificate    the employee's tax year totals (from the year-to-date record) with a month-by-month table
 *   salary_certificate the employee's current earning components
 *
 * A re-generated document supersedes the earlier one; a revoked document stays on record but is never shown to the
 * employee. Reversing a run revokes its payslip documents.
 */
@Injectable()
export class PayrollDocumentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {
    payrollRunHooks.register("payroll-documents", {
      onReversed: async (client, claims, run) => {
        const r = await client.query(
          `UPDATE generated_documents SET status = 'revoked', revoked_at = now(), revoked_by = $2, revoke_reason = 'Payroll run reversed'
            WHERE payroll_run_id = $1 AND document_type = 'payslip' AND status = 'issued'`,
          [run.id, claims.sub ?? null]
        );
        void r;
      },
    });
  }

  // ------------------------------------------------------------------ settings and templates

  placeholders(): PayrollDocumentPlaceholderView[] {
    return DOCUMENT_TYPES.map((documentType) => ({ documentType, placeholders: DOCUMENT_PLACEHOLDERS[documentType] }));
  }

  async getSettings(claims: RequestClaims): Promise<PayrollDocumentSettingsView> {
    await this.requireModule(claims);
    if (!(await this.canStaffView(claims))) throw new ForbiddenException("Not permitted to view payroll document settings");
    return this.db.withClaims(claims, (client) => this.loadSettings(client));
  }

  async updateSettings(claims: RequestClaims, input: UpdatePayrollDocumentSettingsRequest): Promise<PayrollDocumentSettingsView> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, CONFIG_PERMISSION)) && !(await this.rbac.can(claims, "payroll.manage.all"))) {
      throw new ForbiddenException("Not permitted to configure payroll documents");
    }
    return this.db.withClaims(claims, async (client) => {
      if (input.requirePublication !== undefined) {
        await client.query(
          `INSERT INTO payroll_document_settings (company_id, require_publication, updated_by) VALUES ($1, $2, $3)
           ON CONFLICT (company_id) DO UPDATE SET require_publication = EXCLUDED.require_publication, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [claims.company_id, input.requirePublication, claims.sub]
        );
      }
      for (const c of input.templateChoices ?? []) {
        if (!DOCUMENT_TYPES.includes(c.documentType)) throw new BadRequestException(`Unknown document type ${c.documentType}`);
        if (c.templateKey === null) {
          await client.query("DELETE FROM payroll_document_template_choices WHERE document_type = $1", [c.documentType]);
          continue;
        }
        const exists = await client.query("SELECT 1 FROM document_templates WHERE key = $1", [c.templateKey]);
        if (!exists.rowCount) throw new BadRequestException(`No document template with the key "${c.templateKey}"`);
        await client.query(
          `INSERT INTO payroll_document_template_choices (company_id, document_type, template_key, updated_by) VALUES ($1, $2, $3, $4)
           ON CONFLICT (company_id, document_type) DO UPDATE SET template_key = EXCLUDED.template_key, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [claims.company_id, c.documentType, c.templateKey, claims.sub]
        );
      }
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_document_settings.update",
        target: claims.company_id!,
        metadata: { requirePublication: input.requirePublication ?? null, templateChoices: input.templateChoices ?? null },
      });
      return this.loadSettings(client);
    });
  }

  private async loadSettings(client: PoolClient): Promise<PayrollDocumentSettingsView> {
    const s = await client.query("SELECT require_publication FROM payroll_document_settings LIMIT 1");
    const c = await client.query("SELECT document_type, template_key FROM payroll_document_template_choices");
    const t = await client.query("SELECT key, name FROM document_templates ORDER BY name");
    return {
      requirePublication: !!s.rows[0]?.require_publication,
      templateChoices: DOCUMENT_TYPES.map((documentType) => ({ documentType, templateKey: c.rows.find((x) => x.document_type === documentType)?.template_key ?? null })),
      availableTemplates: t.rows.map((x) => ({ key: x.key, name: x.name })),
    };
  }

  // ------------------------------------------------------------------ generation

  /** Generates the payslip document of every payslip of a finalised run that has none (or, with `replace`, re-issues all). */
  async generatePayslips(claims: RequestClaims, runId: string, opts: { replace?: boolean; publish?: boolean } = {}): Promise<{ generated: number; skipped: number; published: number }> {
    return this.db.withClaims(claims, async (client) => {
      const run = await this.requireRunAccess(claims, client, runId, [ACT_BASE], "Not permitted to generate payslip documents");
      if (!ISSUABLE_RUN_STATUSES.includes(run.status)) throw new BadRequestException(`Payroll run is ${run.status}; payslip documents are generated for a finalised run`);
      const tpl = await this.resolveTemplate(client, "payslip");
      const company = (await client.query("SELECT name FROM companies WHERE id = $1", [claims.company_id])).rows[0];
      const slips = await client.query(
        `SELECT p.*, e.first_name, e.last_name FROM payslips p JOIN employees e ON e.id = p.employee_id
          WHERE p.payroll_run_id = $1 AND p.status <> 'voided' ORDER BY p.employee_number`,
        [runId]
      );
      const lines = await client.query(
        "SELECT payslip_id, label, amount, affects, category FROM payroll_component_results WHERE payroll_run_id = $1 ORDER BY payslip_id, line_no",
        [runId]
      );
      const currency = run.currency_code ?? "PKR";
      let generated = 0;
      let skipped = 0;
      let published = 0;
      for (const p of slips.rows) {
        const live = await client.query("SELECT id FROM generated_documents WHERE payslip_id = $1 AND document_type = 'payslip' AND status = 'issued'", [p.id]);
        if (live.rowCount && !opts.replace) { skipped += 1; continue; }
        const mine = lines.rows.filter((l) => l.payslip_id === p.id);
        const earn = mine.filter((l) => l.affects === "gross" && Number(l.amount) >= 0);
        const ded = mine.filter((l) => l.affects === "net" || (l.affects === "gross" && Number(l.amount) < 0));
        const table = (rows: typeof mine, sign: number) => (rows.length ? rows.map((l) => `  ${pad(l.label, 40)}${padL(money(Number(l.amount) * sign, currency), 18)}`).join("\n") : "  (none)");
        const data: Record<string, string> = {
          companyName: company?.name ?? "",
          employeeName: `${p.first_name} ${p.last_name}`.trim(),
          employeeNumber: p.employee_number,
          periodStart: day(run.period_start),
          periodEnd: day(run.period_end),
          paidDays: String(Number(p.paid_days)),
          daysInPeriod: String(p.days_in_period),
          grossPay: money(p.gross_pay, currency),
          incomeTax: money(p.income_tax_monthly, currency),
          netPay: money(p.net_pay, currency),
          earningsTable: table(earn, 1),
          deductionsTable: table(ded, -1),
          issueDate: new Date().toISOString().slice(0, 10),
        };
        const doc = await this.insertDocument(client, claims, tpl, data, {
          documentType: "payslip",
          employeeId: p.employee_id,
          payrollRunId: runId,
          payslipId: p.id,
          supersedesId: live.rows[0]?.id ?? null,
          metadata: { calculationSequence: Number(p.calculation_sequence), netPay: Number(p.net_pay) },
          publish: !!opts.publish,
        });
        generated += 1;
        if (doc.published_at) published += 1;
      }
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_document.generate_payslips",
        target: runId,
        metadata: { generated, skipped, published, replace: !!opts.replace },
      });
      return { generated, skipped, published };
    });
  }

  async generateTaxCertificate(claims: RequestClaims, input: GenerateTaxCertificateRequest): Promise<GeneratedDocumentView> {
    if (!Number.isInteger(input.taxYear) || input.taxYear < 2000 || input.taxYear > 2200) throw new BadRequestException("taxYear must be a year such as 2027");
    return this.db.withClaims(claims, async (client) => {
      const emp = await this.requireEmployeeAccess(claims, client, input.employeeId, "Not permitted to issue tax certificates");
      const ytd = await client.query("SELECT * FROM payroll_ytd WHERE employee_id = $1 AND tax_year = $2", [input.employeeId, String(input.taxYear)]);
      if (!ytd.rowCount || Number(ytd.rows[0].payslip_count) === 0) throw new BadRequestException(`${emp.first_name} ${emp.last_name} has no finalised payroll in tax year ${input.taxYear}`);
      const y = ytd.rows[0];
      const bounds = taxYearBounds(input.taxYear);
      const slips = await client.query(
        `SELECT pr.period_start, pr.period_end, p.gross_pay, p.income_tax_monthly
           FROM payslips p JOIN payroll_runs pr ON pr.id = p.payroll_run_id
          WHERE p.employee_id = $1 AND p.status <> 'voided' AND pr.status IN ('finalized','accounting','payment_released','reconciled','closed','reopened')
            AND pr.period_end BETWEEN $2 AND $3 ORDER BY pr.period_end, p.created_at`,
        [input.employeeId, bounds.start, bounds.end]
      );
      const person = emp.person_id ? (await client.query("SELECT ntn FROM persons WHERE id = $1", [emp.person_id])).rows[0] : null;
      const company = (await client.query("SELECT name FROM companies WHERE id = $1", [claims.company_id])).rows[0];
      const tpl = await this.resolveTemplate(client, "tax_certificate");
      const data: Record<string, string> = {
        companyName: company?.name ?? "",
        employeeName: `${emp.first_name} ${emp.last_name}`.trim(),
        employeeNumber: emp.employee_number,
        employeeCnic: sensitive.decrypt(claims.company_id!, emp.cnic) ?? "not on file",
        employeeNtn: (person ? sensitive.decrypt(claims.company_id!, person.ntn) : null) ?? "not on file",
        taxYear: String(input.taxYear),
        taxYearStart: bounds.start,
        taxYearEnd: bounds.end,
        grossPay: money(y.gross_pay),
        taxableGross: money(y.taxable_gross),
        incomeTax: money(y.income_tax),
        eobiEmployee: money(y.eobi_employee),
        netPay: money(y.net_pay),
        payslipCount: String(y.payslip_count),
        monthlyTable: ["  Period                       Gross pay             Tax withheld", ...slips.rows.map((s) => `  ${day(s.period_start)} - ${day(s.period_end)}${padL(money(s.gross_pay), 16)}${padL(money(s.income_tax_monthly), 22)}`)].join("\n"),
        issueDate: new Date().toISOString().slice(0, 10),
      };
      const live = await client.query("SELECT id FROM generated_documents WHERE employee_id = $1 AND tax_year = $2 AND document_type = 'tax_certificate' AND status = 'issued'", [input.employeeId, input.taxYear]);
      if (live.rowCount) await client.query("UPDATE generated_documents SET status = 'superseded' WHERE id = $1", [live.rows[0].id]);
      const doc = await this.insertDocument(client, claims, tpl, data, {
        documentType: "tax_certificate",
        employeeId: input.employeeId,
        taxYear: input.taxYear,
        supersedesId: live.rows[0]?.id ?? null,
        metadata: { payslipCount: Number(y.payslip_count), incomeTax: Number(y.income_tax) },
        publish: false,
      });
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_document.generate_tax_certificate",
        target: doc.id,
        metadata: { employeeId: input.employeeId, taxYear: input.taxYear, supersedes: live.rows[0]?.id ?? null },
      });
      return toView({ ...doc, employee_number: emp.employee_number, employee_name: `${emp.first_name} ${emp.last_name}`.trim() }, true);
    });
  }

  async generateSalaryCertificate(claims: RequestClaims, input: GenerateSalaryCertificateRequest): Promise<GeneratedDocumentView> {
    return this.db.withClaims(claims, async (client) => {
      const emp = await this.requireEmployeeAccess(claims, client, input.employeeId, "Not permitted to issue salary certificates");
      const comps = await client.query(
        `SELECT cc.name, cc.payslip_label, cc.display_order, ecc.amount, ecc.pay_frequency, ecc.currency_code
           FROM employee_compensation_components ecc JOIN compensation_components cc ON cc.id = ecc.component_id
          WHERE ecc.employee_id = $1 AND cc.component_type = 'earning' AND ecc.effective_from <= CURRENT_DATE
            AND (ecc.effective_to IS NULL OR ecc.effective_to >= CURRENT_DATE)
          ORDER BY cc.display_order, cc.name`,
        [input.employeeId]
      );
      if (!comps.rowCount) throw new BadRequestException("This employee has no current earning components, so there is no salary to certify");
      const monthly = (c: { amount: string; pay_frequency: string }) => (c.pay_frequency === "annual" ? Number(c.amount) / 12 : Number(c.amount));
      const total = comps.rows.reduce((a, c) => a + monthly(c), 0);
      const currency = comps.rows[0].currency_code ?? "PKR";
      const pos = emp.position_id ? (await client.query("SELECT position_title FROM positions WHERE id = $1", [emp.position_id])).rows[0] : null;
      const company = (await client.query("SELECT name FROM companies WHERE id = $1", [claims.company_id])).rows[0];
      const tpl = await this.resolveTemplate(client, "salary_certificate");
      const data: Record<string, string> = {
        companyName: company?.name ?? "",
        employeeName: `${emp.first_name} ${emp.last_name}`.trim(),
        employeeNumber: emp.employee_number,
        designation: pos?.position_title ?? emp.designation ?? "an employee",
        dateOfJoining: day(emp.date_of_joining),
        monthlyGross: money(total, currency),
        componentTable: comps.rows.map((c) => `  ${pad(c.payslip_label ?? c.name, 40)}${padL(money(monthly(c), currency), 18)}`).join("\n"),
        addressedTo: input.addressedTo?.trim() || "Whom it may concern",
        purpose: input.purpose?.trim() || "general purposes",
        issueDate: new Date().toISOString().slice(0, 10),
      };
      const doc = await this.insertDocument(client, claims, tpl, data, {
        documentType: "salary_certificate",
        employeeId: input.employeeId,
        supersedesId: null,
        metadata: { monthlyGross: Number(total.toFixed(2)), addressedTo: data.addressedTo },
        publish: false,
      });
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_document.generate_salary_certificate",
        target: doc.id,
        metadata: { employeeId: input.employeeId },
      });
      return toView({ ...doc, employee_number: emp.employee_number, employee_name: `${emp.first_name} ${emp.last_name}`.trim() }, true);
    });
  }

  // ------------------------------------------------------------------ publication / revocation

  /** Publishes (or withdraws) every issued payslip document of a run in one step. */
  async setRunPublication(claims: RequestClaims, runId: string, published: boolean): Promise<{ changed: number }> {
    return this.db.withClaims(claims, async (client) => {
      await this.requireRunAccess(claims, client, runId, [ACT_BASE], "Not permitted to publish payslips");
      const r = published
        ? await client.query(
            `UPDATE generated_documents SET published_at = now(), published_by = $2, unpublished_at = NULL, unpublished_by = NULL
              WHERE payroll_run_id = $1 AND document_type = 'payslip' AND status = 'issued' AND published_at IS NULL`,
            [runId, claims.sub]
          )
        : await client.query(
            `UPDATE generated_documents SET published_at = NULL, unpublished_at = now(), unpublished_by = $2
              WHERE payroll_run_id = $1 AND document_type = 'payslip' AND status = 'issued' AND published_at IS NOT NULL`,
            [runId, claims.sub]
          );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: published ? "payroll_document.publish_run" : "payroll_document.unpublish_run",
        target: runId,
        metadata: { changed: r.rowCount ?? 0 },
      });
      return { changed: r.rowCount ?? 0 };
    });
  }

  async setPublication(claims: RequestClaims, documentId: string, published: boolean): Promise<GeneratedDocumentView> {
    return this.db.withClaims(claims, async (client) => {
      const doc = await this.lockDocument(client, documentId);
      await this.requireEmployeeAccess(claims, client, doc.employee_id, "Not permitted to publish documents");
      if (doc.status !== "issued") throw new BadRequestException(`A ${doc.status} document cannot be ${published ? "published" : "withdrawn"}`);
      const r = published
        ? await client.query("UPDATE generated_documents SET published_at = COALESCE(published_at, now()), published_by = $2, unpublished_at = NULL, unpublished_by = NULL WHERE id = $1 RETURNING *", [documentId, claims.sub])
        : await client.query("UPDATE generated_documents SET published_at = NULL, unpublished_at = now(), unpublished_by = $2 WHERE id = $1 RETURNING *", [documentId, claims.sub]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: published ? "payroll_document.publish" : "payroll_document.unpublish",
        target: documentId,
        metadata: { documentType: doc.document_type, employeeId: doc.employee_id },
      });
      return toView(r.rows[0], false);
    });
  }

  async revoke(claims: RequestClaims, documentId: string, reason: string): Promise<GeneratedDocumentView> {
    const why = reason?.trim();
    if (!why || why.length < 3) throw new BadRequestException("A reason is required to revoke a document");
    return this.db.withClaims(claims, async (client) => {
      const doc = await this.lockDocument(client, documentId);
      await this.requireEmployeeAccess(claims, client, doc.employee_id, "Not permitted to revoke documents");
      if (doc.status === "revoked") throw new BadRequestException("This document is already revoked");
      const r = await client.query(
        "UPDATE generated_documents SET status = 'revoked', revoked_at = now(), revoked_by = $2, revoke_reason = $3 WHERE id = $1 RETURNING *",
        [documentId, claims.sub, why]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_document.revoke",
        target: documentId,
        metadata: { documentType: doc.document_type, employeeId: doc.employee_id, reason: why },
      });
      return toView(r.rows[0], false);
    });
  }

  // ------------------------------------------------------------------ reading

  async list(claims: RequestClaims, filter: { employeeId?: string; runId?: string; documentType?: PayrollDocumentType; status?: string } = {}): Promise<GeneratedDocumentView[]> {
    await this.requireModule(claims);
    if (filter.documentType && !DOCUMENT_TYPES.includes(filter.documentType)) throw new BadRequestException("Unknown document type");
    return this.db.withClaims(claims, async (client) => {
      const access = await resolvePayrollAreaAccess(this.db, this.rbac, claims, VIEW_BASES);
      if (!access) throw new ForbiddenException("Not permitted to view payroll documents");
      const r = await client.query(
        `SELECT d.*, e.employee_number, e.first_name || ' ' || e.last_name AS employee_name, e.payroll_area_id
           FROM generated_documents d JOIN employees e ON e.id = d.employee_id
          WHERE ($1::uuid IS NULL OR d.employee_id = $1) AND ($2::uuid IS NULL OR d.payroll_run_id = $2)
            AND ($3::text IS NULL OR d.document_type = $3) AND ($4::text IS NULL OR d.status = $4)
          ORDER BY d.generated_at DESC LIMIT 500`,
        [filter.employeeId ?? null, filter.runId ?? null, filter.documentType ?? null, filter.status ?? null]
      );
      return r.rows.filter((x) => isPayrollAreaInScope(access, x.payroll_area_id)).map((x) => toView(x, false));
    });
  }

  /** Staff read of one document (with its text), or the owning employee's read of a published, issued one. */
  async get(claims: RequestClaims, documentId: string): Promise<GeneratedDocumentView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT d.*, e.employee_number, e.first_name || ' ' || e.last_name AS employee_name, e.payroll_area_id, e.user_account_id
           FROM generated_documents d JOIN employees e ON e.id = d.employee_id WHERE d.id = $1`,
        [documentId]
      );
      if (!r.rowCount) throw new NotFoundException("Document not found");
      const row = r.rows[0];
      const access = await resolvePayrollAreaAccess(this.db, this.rbac, claims, VIEW_BASES);
      if (access && isPayrollAreaInScope(access, row.payroll_area_id)) return toView(row, true);
      const own = row.user_account_id === claims.sub && (await this.rbac.can(claims, SELF_VIEW_PERMISSION, { ownerId: row.user_account_id }));
      if (!own || row.status !== "issued" || !row.published_at) throw new NotFoundException("Document not found");
      return toView(row, true);
    });
  }

  /** The signed-in employee's own documents: issued and published only. */
  async listMine(claims: RequestClaims): Promise<GeneratedDocumentView[]> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, SELF_VIEW_PERMISSION, { ownerId: claims.sub }))) throw new ForbiddenException("Not permitted to view your payroll documents");
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT d.*, e.employee_number, e.first_name || ' ' || e.last_name AS employee_name
           FROM generated_documents d JOIN employees e ON e.id = d.employee_id
          WHERE e.user_account_id = $1 AND d.status = 'issued' AND d.published_at IS NOT NULL ORDER BY d.generated_at DESC LIMIT 200`,
        [claims.sub]
      );
      return r.rows.map((x) => toView(x, false));
    });
  }

  // ------------------------------------------------------------------ internals

  private async resolveTemplate(client: PoolClient, type: PayrollDocumentType): Promise<{ key: string | null; source: "built_in" | "custom"; title: string; body: string }> {
    const choice = await client.query("SELECT template_key FROM payroll_document_template_choices WHERE document_type = $1", [type]);
    if (choice.rowCount) {
      const t = await client.query("SELECT key, name, template_body FROM document_templates WHERE key = $1", [choice.rows[0].template_key]);
      if (t.rowCount) return { key: t.rows[0].key, source: "custom", title: t.rows[0].name, body: t.rows[0].template_body };
      // the chosen template was deleted: fall back to the built-in body rather than failing the run
    }
    return { key: null, source: "built_in", title: BUILT_IN_BODIES[type].title, body: BUILT_IN_BODIES[type].body };
  }

  private async insertDocument(
    client: PoolClient,
    claims: RequestClaims,
    tpl: { key: string | null; source: "built_in" | "custom"; title: string; body: string },
    data: Record<string, string>,
    meta: { documentType: PayrollDocumentType; employeeId: string; payrollRunId?: string; payslipId?: string; taxYear?: number; supersedesId: string | null; metadata: Record<string, unknown>; publish: boolean }
  ) {
    const content = renderPlaceholders(tpl.body, data);
    const title = renderPlaceholders(tpl.title, data);
    if (meta.supersedesId && meta.documentType === "payslip") await client.query("UPDATE generated_documents SET status = 'superseded' WHERE id = $1", [meta.supersedesId]);
    const r = await client.query(
      `INSERT INTO generated_documents (company_id, document_type, employee_id, payroll_run_id, payslip_id, tax_year, template_key, template_source, title, content, content_hash,
                                        supersedes_id, generated_by, metadata, correlation_id, published_at, published_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17) RETURNING *`,
      [
        claims.company_id, meta.documentType, meta.employeeId, meta.payrollRunId ?? null, meta.payslipId ?? null, meta.taxYear ?? null, tpl.key, tpl.source, title, content,
        createHash("sha256").update(content).digest("hex"), meta.supersedesId, claims.sub, JSON.stringify(meta.metadata), currentCorrelationId(),
        meta.publish ? new Date() : null, meta.publish ? claims.sub : null,
      ]
    );
    return r.rows[0];
  }

  private async lockDocument(client: PoolClient, id: string): Promise<RunRow> {
    const r = await client.query("SELECT * FROM generated_documents WHERE id = $1 FOR UPDATE", [id]);
    if (!r.rowCount) throw new NotFoundException("Document not found");
    return r.rows[0];
  }

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!claims.company_id) throw new ForbiddenException();
  }

  private async canStaffView(claims: RequestClaims): Promise<boolean> {
    return !!(await resolvePayrollAreaAccess(this.db, this.rbac, claims, VIEW_BASES));
  }

  private async requireRunAccess(claims: RequestClaims, client: PoolClient, runId: string, bases: string[], message: string): Promise<RunRow> {
    await this.requireModule(claims);
    const access = await resolvePayrollAreaAccess(this.db, this.rbac, claims, bases);
    if (!access) throw new ForbiddenException(message);
    const run = await client.query("SELECT * FROM payroll_runs WHERE id = $1", [runId]);
    if (!run.rowCount) throw new NotFoundException("Payroll run not found");
    if (!isPayrollAreaInScope(access, run.rows[0].payroll_area_id)) {
      throw access.unrestricted ? new NotFoundException("Payroll run not found") : new ForbiddenException("This payroll run is outside your payroll area scope");
    }
    return run.rows[0];
  }

  private async requireEmployeeAccess(claims: RequestClaims, client: PoolClient, employeeId: string, message: string): Promise<RunRow> {
    await this.requireModule(claims);
    const access = await resolvePayrollAreaAccess(this.db, this.rbac, claims, [ACT_BASE]);
    if (!access) throw new ForbiddenException(message);
    const e = await client.query("SELECT * FROM employees WHERE id = $1", [employeeId]);
    if (!e.rowCount) throw new NotFoundException("Employee not found");
    if (!isPayrollAreaInScope(access, e.rows[0].payroll_area_id)) {
      throw access.unrestricted ? new NotFoundException("Employee not found") : new ForbiddenException("This employee is outside your payroll area scope");
    }
    return e.rows[0];
  }
}
