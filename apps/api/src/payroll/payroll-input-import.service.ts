import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { BackgroundJobsService } from "../background-jobs/background-jobs.service";
import { ImportExportService } from "../import-export/import-export.service";
import { EmployeeCompensationService } from "../employees/employee-compensation.service";
import { EmployeeAdditionalPaymentsService } from "../employees/employee-additional-payments.service";
import { isPayrollAreaInScope, resolvePayrollAreaAccess } from "./payroll-area-access";
import type { DryRunPayrollInputRequest, PayrollInputBatchView, PayrollInputImportType, PayrollInputRowView, PayrollInputTemplateView } from "@aihxm/shared-types";

export const PAYROLL_INPUT_IMPORT_JOB = "payroll_input_import";
const MODULE_KEY = "payroll" as const;
const CONFIG_PERMISSION = "payroll.calculate";
const MAX_ROWS = 5000;
const MAX_CSV_BYTES = 5 * 1024 * 1024;
const TYPES: PayrollInputImportType[] = ["payroll_components", "payroll_payments"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** value keys nulled out of stored rows once a batch has finished */
const SENSITIVE_KEYS = ["amount", "percentage", "units"];

type RowError = { field?: string; message: string };
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : ((v as string | null) ?? null));
const isRealDate = (v: string) => {
  if (!DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toBatch(r: any): PayrollInputBatchView {
  return {
    id: r.id,
    importType: r.import_type,
    status: r.status,
    fileName: r.file_name,
    totalRows: r.total_rows,
    validRows: r.valid_rows,
    invalidRows: r.invalid_rows,
    importedRows: r.imported_rows,
    failedRows: r.failed_rows,
    checkpointRow: r.checkpoint_row,
    allowPartial: r.allow_partial,
    backgroundJobId: r.background_job_id,
    createdAt: iso(r.created_at) as string,
    executedAt: iso(r.executed_at),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    lastError: r.last_error,
  };
}

export const PAYROLL_INPUT_TEMPLATES: PayrollInputTemplateView[] = [
  {
    importType: "payroll_components",
    columns: [
      { name: "employeeNumber", required: true, description: "The employee's number" },
      { name: "componentKey", required: true, description: "Key of an active pay component (salary, allowance, recurring deduction, ...)" },
      { name: "effectiveFrom", required: true, description: "YYYY-MM-DD the amount applies from" },
      { name: "amount", required: false, description: "Amount (or rate per unit for a per-unit component)" },
      { name: "percentage", required: false, description: "Percentage of the component's basis, instead of an amount" },
      { name: "units", required: false, description: "Units, for a per-unit component" },
    ],
    example: "employeeNumber,componentKey,effectiveFrom,amount\nEMP0001,basic_salary,2026-11-01,120000\n",
  },
  {
    importType: "payroll_payments",
    columns: [
      { name: "employeeNumber", required: true, description: "The employee's number" },
      { name: "paymentType", required: true, description: "earning (bonus, one-time payment) or deduction" },
      { name: "amount", required: true, description: "Amount, greater than zero" },
      { name: "effectiveDate", required: true, description: "YYYY-MM-DD; paid in the run whose period contains it" },
      { name: "componentKey", required: false, description: "Pay component to pay it under (supplies label and tax treatment)" },
      { name: "label", required: false, description: "Payslip label; required when no componentKey is given" },
      { name: "isTaxable", required: false, description: "true / false (an earning defaults to the component's setting)" },
      { name: "reasonNote", required: false, description: "Why" },
    ],
    example: "employeeNumber,paymentType,amount,effectiveDate,label\nEMP0001,earning,25000,2026-11-15,Performance bonus\n",
  },
];

/**
 * PAY-26 - bulk payroll input tables (salary and recurring components; one-time bonuses and deductions) on the same
 * batch machinery as the bulk hiring import (LIF-11): a dry run stores a verdict per row and creates nothing, execute
 * queues a background job that applies the valid rows one transaction at a time with a checkpoint, a bad row never
 * stops the rest, a crashed worker resumes after the checkpoint, and the failed rows can be retried. Each row goes
 * through the same service a person would use (so effective dating, tax-treatment rules and approval workflows apply),
 * acting as the user who started the import - a permission they lose mid-run fails the row, not the batch.
 */
@Injectable()
export class PayrollInputImportService {
  private readonly logger = new Logger(PayrollInputImportService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly jobs: BackgroundJobsService,
    private readonly compensation: EmployeeCompensationService,
    private readonly additionalPayments: EmployeeAdditionalPaymentsService,
    private readonly importExport: ImportExportService = new ImportExportService()
  ) {}

  templates(): PayrollInputTemplateView[] {
    return PAYROLL_INPUT_TEMPLATES;
  }

  private async require(claims: RequestClaims): Promise<string> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!claims.company_id) throw new ForbiddenException();
    if (!(await resolvePayrollAreaAccess(this.db, this.rbac, claims, [CONFIG_PERMISSION])) && !(await this.rbac.can(claims, "payroll.manage.all"))) {
      throw new ForbiddenException("Not permitted to import payroll inputs");
    }
    return claims.company_id;
  }

  /** What a dry run was validated against; a change to the component catalog invalidates it. */
  private async configHash(client: PoolClient): Promise<{ hash: string; snapshot: Record<string, unknown> }> {
    const r = await client.query("SELECT id, key, is_active, calculation_type, component_type FROM compensation_components ORDER BY key");
    const snapshot = { components: r.rows.map((c) => [c.id, c.key, c.is_active, c.calculation_type, c.component_type]) };
    return { hash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"), snapshot: { componentCount: r.rowCount } };
  }

  async dryRun(claims: RequestClaims, input: DryRunPayrollInputRequest, idempotencyKey?: string): Promise<PayrollInputBatchView> {
    const companyId = await this.require(claims);
    if (!TYPES.includes(input.importType)) throw new BadRequestException(`importType must be one of ${TYPES.join(", ")}`);
    if (typeof input.csv !== "string" || !input.csv.trim()) throw new BadRequestException("The file is empty.");
    if (Buffer.byteLength(input.csv, "utf8") > MAX_CSV_BYTES) throw new BadRequestException("The file is larger than 5 MB.");
    const sourceHash = createHash("sha256").update(input.csv).digest("hex");

    return this.db.withClaims(claims, async (client) => {
      if (idempotencyKey) {
        const existing = await client.query("SELECT * FROM import_batches WHERE company_id = $1 AND import_type = $2 AND idempotency_key = $3", [companyId, input.importType, idempotencyKey]);
        if (existing.rowCount) {
          if (existing.rows[0].source_hash !== sourceHash) throw new ConflictException("This Idempotency-Key was already used for a different file.");
          return toBatch(existing.rows[0]);
        }
      }
      const { header, rows } = this.importExport.parseCsv(input.csv);
      const template = PAYROLL_INPUT_TEMPLATES.find((t) => t.importType === input.importType)!;
      const missing = template.columns.filter((c) => c.required && !header.includes(c.name)).map((c) => c.name);
      if (missing.length) throw new BadRequestException(`Missing required column(s): ${missing.join(", ")}`);
      const unknown = header.filter((h) => h && !template.columns.some((c) => c.name === h));
      if (unknown.length) throw new BadRequestException(`Unknown column(s): ${unknown.join(", ")}`);
      if (rows.length === 0) throw new BadRequestException("The file has no data rows.");
      if (rows.length > MAX_ROWS) throw new BadRequestException(`A single import is limited to ${MAX_ROWS} rows.`);

      const cfg = await this.configHash(client);
      const access = await resolvePayrollAreaAccess(this.db, this.rbac, claims, [CONFIG_PERMISSION, "payroll.manage"]);
      const verdicts = await this.validate(client, input.importType, header, rows, access);
      const valid = verdicts.filter((v) => v.errors.length === 0).length;
      const batch = await client.query(
        `INSERT INTO import_batches (company_id, import_type, file_name, source_hash, config_hash, config_snapshot, total_rows, valid_rows, invalid_rows, allow_partial, idempotency_key, created_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [companyId, input.importType, input.fileName ?? null, sourceHash, cfg.hash, JSON.stringify(cfg.snapshot), rows.length, valid, rows.length - valid, input.allowPartial ?? false, idempotencyKey ?? null, claims.sub]
      );
      const batchId = batch.rows[0].id as string;
      for (const v of verdicts) {
        await client.query(
          "INSERT INTO import_rows (batch_id, company_id, row_number, status, payload, errors, employee_id) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)",
          [batchId, companyId, v.rowNumber, v.errors.length === 0 ? "valid" : "invalid", JSON.stringify(v.payload), JSON.stringify(v.errors), v.employeeId]
        );
      }
      await this.audit.record(client, claims, {
        companyId,
        action: "payroll_input_import.dry_run",
        target: batchId,
        metadata: { importType: input.importType, totalRows: rows.length, validRows: valid, invalidRows: rows.length - valid },
      });
      return toBatch(batch.rows[0]);
    });
  }

  private async validate(
    client: PoolClient,
    type: PayrollInputImportType,
    header: string[],
    rows: string[][],
    access: Awaited<ReturnType<typeof resolvePayrollAreaAccess>>
  ): Promise<Array<{ rowNumber: number; payload: Record<string, unknown>; errors: RowError[]; employeeId: string | null }>> {
    const emps = await client.query("SELECT id, employee_number, payroll_area_id, date_of_joining, termination_date FROM employees");
    const byNumber = new Map(emps.rows.map((e) => [String(e.employee_number).toLowerCase(), e]));
    const comps = await client.query("SELECT id, key, is_active, component_type, calculation_type FROM compensation_components");
    const byKey = new Map(comps.rows.map((c) => [c.key as string, c]));
    const seen = new Map<string, number>();
    const out: Array<{ rowNumber: number; payload: Record<string, unknown>; errors: RowError[]; employeeId: string | null }> = [];

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 2;
      const rec: Record<string, string> = {};
      header.forEach((col, ci) => { rec[col] = (rows[i][ci] ?? "").trim(); });
      const errors: RowError[] = [];
      const bad = (field: string, message: string) => errors.push({ field, message });

      const emp = rec.employeeNumber ? byNumber.get(rec.employeeNumber.toLowerCase()) : undefined;
      if (!rec.employeeNumber) bad("employeeNumber", "Employee number is required");
      else if (!emp) bad("employeeNumber", `No employee with the number "${rec.employeeNumber}"`);
      else if (access && !isPayrollAreaInScope(access, emp.payroll_area_id)) bad("employeeNumber", "This employee is outside your payroll area scope");

      const num = (field: string, label: string, positive: boolean) => {
        if (rec[field] === "" || rec[field] === undefined) return undefined;
        const n = Number(rec[field]);
        if (!Number.isFinite(n) || n < 0 || (positive && n <= 0)) { bad(field, `${label} must be a ${positive ? "positive" : "non-negative"} number`); return undefined; }
        return n;
      };

      let payload: Record<string, unknown>;
      if (type === "payroll_components") {
        const comp = byKey.get(rec.componentKey);
        if (!rec.componentKey) bad("componentKey", "Component key is required");
        else if (!comp) bad("componentKey", `No pay component with the key "${rec.componentKey}"`);
        else if (!comp.is_active) bad("componentKey", `The component "${rec.componentKey}" is inactive`);
        if (!isRealDate(rec.effectiveFrom ?? "")) bad("effectiveFrom", "effectiveFrom must be a real date (YYYY-MM-DD)");
        const amount = num("amount", "Amount", false);
        const percentage = num("percentage", "Percentage", false);
        const units = num("units", "Units", false);
        if (amount === undefined && percentage === undefined && units === undefined && !errors.some((e) => ["amount", "percentage", "units"].includes(e.field ?? ""))) {
          bad("amount", "Give an amount, a percentage or units");
        }
        if (amount !== undefined && percentage !== undefined) bad("percentage", "Give an amount or a percentage, not both");
        if (emp && isRealDate(rec.effectiveFrom ?? "") && emp.termination_date && rec.effectiveFrom > String(emp.termination_date instanceof Date ? emp.termination_date.toISOString() : emp.termination_date).slice(0, 10)) {
          bad("effectiveFrom", "The employee has already left on that date");
        }
        const sig = `${rec.employeeNumber?.toLowerCase()}|${rec.componentKey}|${rec.effectiveFrom}`;
        if (seen.has(sig)) bad("componentKey", `Same employee, component and date as row ${seen.get(sig)}`);
        else seen.set(sig, rowNumber);
        payload = { employeeNumber: rec.employeeNumber, componentKey: rec.componentKey, componentId: comp?.id, effectiveFrom: rec.effectiveFrom, amount, percentage, units };
      } else {
        if (rec.paymentType !== "earning" && rec.paymentType !== "deduction") bad("paymentType", "paymentType must be earning or deduction");
        const amount = num("amount", "Amount", true);
        if (amount === undefined && !errors.some((e) => e.field === "amount")) bad("amount", "Amount is required");
        if (!isRealDate(rec.effectiveDate ?? "")) bad("effectiveDate", "effectiveDate must be a real date (YYYY-MM-DD)");
        const comp = rec.componentKey ? byKey.get(rec.componentKey) : undefined;
        if (rec.componentKey && !comp) bad("componentKey", `No pay component with the key "${rec.componentKey}"`);
        if (comp && !comp.is_active) bad("componentKey", `The component "${rec.componentKey}" is inactive`);
        if (!rec.componentKey && !rec.label) bad("label", "A label or a component key is required");
        if (rec.isTaxable && !["true", "false"].includes(rec.isTaxable.toLowerCase())) bad("isTaxable", "isTaxable must be true or false");
        const sig = `${rec.employeeNumber?.toLowerCase()}|${rec.paymentType}|${rec.componentKey || rec.label}|${rec.effectiveDate}|${rec.amount}`;
        if (seen.has(sig)) bad("amount", `Identical to row ${seen.get(sig)}`);
        else seen.set(sig, rowNumber);
        payload = {
          employeeNumber: rec.employeeNumber, paymentType: rec.paymentType, amount, effectiveDate: rec.effectiveDate, componentId: comp?.id, label: rec.label || undefined,
          isTaxable: rec.isTaxable ? rec.isTaxable.toLowerCase() === "true" : undefined, reasonNote: rec.reasonNote || undefined,
        };
      }
      out.push({ rowNumber, payload, errors, employeeId: emp?.id ?? null });
    }
    return out;
  }

  async execute(claims: RequestClaims, batchId: string, idempotencyKey?: string): Promise<PayrollInputBatchView> {
    const companyId = await this.require(claims);
    return this.db.withClaims(claims, async (client) => {
      const batch = await this.lock(client, companyId, batchId);
      if (batch.status !== "dry_run_complete") {
        if (["queued", "running", "completed", "completed_with_errors"].includes(batch.status)) return toBatch(batch);
        throw new ConflictException(`A batch in status "${batch.status}" cannot be executed`);
      }
      if (batch.valid_rows === 0) throw new BadRequestException("No valid rows to import");
      if (batch.invalid_rows > 0 && !batch.allow_partial) {
        throw new BadRequestException(`${batch.invalid_rows} row(s) failed validation. Fix the file and run a new dry run, or re-run the dry run with allowPartial to import only the valid rows.`);
      }
      const cfg = await this.configHash(client);
      if (cfg.hash !== batch.config_hash) throw new ConflictException("The pay component catalog changed since this dry run. Run the dry run again before importing.");
      const job = await this.jobs.enqueue(client, claims, { companyId, jobType: PAYROLL_INPUT_IMPORT_JOB, payload: { batchId }, idempotencyKey: idempotencyKey ?? `batch:${batchId}`, maxAttempts: 5 });
      const updated = await client.query(
        "UPDATE import_batches SET status = 'queued', background_job_id = $2, executed_at = now(), executed_by_user_account_id = $3 WHERE id = $1 RETURNING *",
        [batchId, job.id, claims.sub]
      );
      await this.audit.record(client, claims, { companyId, action: "payroll_input_import.execute", target: batchId, metadata: { jobId: job.id, importType: batch.import_type, validRows: batch.valid_rows } });
      return toBatch(updated.rows[0]);
    });
  }

  /** Worker entry point: applies the batch's pending valid rows after checkpoint_row. */
  async processBatch(batchId: string, onProgress?: (percent: number, note: string) => Promise<void>): Promise<PayrollInputBatchView> {
    const svc: RequestClaims = { is_platform_admin: false, is_service: true, sub: "payroll-input-import-worker" };
    const head = await this.db.withClaims(svc, async (client) => {
      const r = await client.query("SELECT * FROM import_batches WHERE id = $1 AND import_type = ANY($2::text[]) FOR UPDATE", [batchId, TYPES]);
      if (!r.rowCount) throw new NotFoundException("Import batch not found");
      const b = r.rows[0];
      if (!["cancelled", "completed", "completed_with_errors"].includes(b.status)) {
        await client.query("UPDATE import_batches SET status = 'running', started_at = COALESCE(started_at, now()) WHERE id = $1", [batchId]);
      }
      return b;
    });
    if (["cancelled", "completed", "completed_with_errors"].includes(head.status)) return this.db.withClaims(svc, async (c) => toBatch((await c.query("SELECT * FROM import_batches WHERE id = $1", [batchId])).rows[0]));
    const actor: RequestClaims = { is_platform_admin: false, company_id: head.company_id, sub: head.executed_by_user_account_id ?? head.created_by_user_account_id };
    const type = head.import_type as PayrollInputImportType;

    const pending = await this.db.withClaims(svc, async (c) =>
      (await c.query("SELECT id, row_number, payload, employee_id FROM import_rows WHERE batch_id = $1 AND status = 'valid' AND row_number > $2 ORDER BY row_number", [batchId, head.checkpoint_row])).rows
    );
    let done = 0;
    for (const row of pending) {
      const state = await this.db.withClaims(svc, async (c) => (await c.query("SELECT status FROM import_batches WHERE id = $1", [batchId])).rows[0]?.status);
      if (state === "cancelled") break;
      let failure: string | null = null;
      try {
        await this.applyRow(actor, type, row.employee_id, row.payload);
      } catch (err) {
        failure = err instanceof Error ? err.message : "Row could not be imported";
        if (failure.length > 500) failure = failure.slice(0, 500);
      }
      await this.db.withClaims(svc, async (c) => {
        if (!failure) {
          await c.query("UPDATE import_rows SET status = 'imported', processed_at = now() WHERE id = $1", [row.id]);
          await c.query("UPDATE import_batches SET imported_rows = imported_rows + 1, checkpoint_row = $2 WHERE id = $1", [batchId, row.row_number]);
        } else {
          await c.query("UPDATE import_rows SET status = 'failed', errors = $2::jsonb, processed_at = now() WHERE id = $1", [row.id, JSON.stringify([{ message: failure }])]);
          await c.query("UPDATE import_batches SET failed_rows = failed_rows + 1, checkpoint_row = $2 WHERE id = $1", [batchId, row.row_number]);
        }
      });
      done += 1;
      if (onProgress && (done % 10 === 0 || done === pending.length)) await onProgress(Math.round((done / Math.max(pending.length, 1)) * 100), `${done}/${pending.length} rows`);
    }

    return this.db.withClaims(svc, async (c) => {
      const cur = await c.query("SELECT status FROM import_batches WHERE id = $1", [batchId]);
      if (cur.rows[0].status === "cancelled") {
        await this.scrub(c, batchId, true);
        return toBatch((await c.query("SELECT * FROM import_batches WHERE id = $1", [batchId])).rows[0]);
      }
      const r = await c.query(
        "UPDATE import_batches SET status = CASE WHEN failed_rows > 0 THEN 'completed_with_errors' ELSE 'completed' END, finished_at = now(), last_error = NULL WHERE id = $1 RETURNING *",
        [batchId]
      );
      await this.scrub(c, batchId, false);
      await this.audit.record(c, svc, { companyId: head.company_id, action: "payroll_input_import.finish", target: batchId, metadata: { importType: type, imported: r.rows[0].imported_rows, failed: r.rows[0].failed_rows } });
      return toBatch(r.rows[0]);
    });
  }

  private async applyRow(actor: RequestClaims, type: PayrollInputImportType, employeeId: string, p: Record<string, unknown>): Promise<void> {
    if (type === "payroll_components") {
      await this.compensation.setCompensationComponents(actor, {
        employeeId,
        effectiveFrom: String(p.effectiveFrom),
        components: [{ componentId: String(p.componentId), amount: p.amount as number | undefined, percentage: p.percentage as number | undefined, units: p.units as number | undefined }],
        changeReasonNote: "Bulk payroll input import",
      });
      return;
    }
    await this.additionalPayments.create(actor, {
      employeeId,
      paymentType: p.paymentType as "earning" | "deduction",
      amount: Number(p.amount),
      effectiveDate: String(p.effectiveDate),
      componentId: (p.componentId as string | undefined) ?? null,
      label: p.label as string | undefined,
      isTaxable: p.isTaxable as boolean | undefined,
      reasonNote: (p.reasonNote as string | undefined) ?? "Bulk payroll input import",
    });
  }

  private async scrub(client: PoolClient, batchId: string, includeFailed: boolean): Promise<void> {
    const expr = SENSITIVE_KEYS.map((k) => ` - '${k}'`).join("");
    await client.query(`UPDATE import_rows SET payload = payload${expr} WHERE batch_id = $1 AND ($2::boolean OR status <> 'failed')`, [batchId, includeFailed]);
  }

  async recordJobFailure(batchId: string, message: string, finalAttempt: boolean): Promise<void> {
    const svc: RequestClaims = { is_platform_admin: false, is_service: true, sub: "payroll-input-import-worker" };
    await this.db.withClaims(svc, (c) =>
      c.query(
        `UPDATE import_batches SET last_error = left($2, 2000), status = CASE WHEN $3::boolean THEN 'failed' ELSE 'queued' END, finished_at = CASE WHEN $3::boolean THEN now() ELSE NULL END
          WHERE id = $1 AND status IN ('queued', 'running')`,
        [batchId, message, finalAttempt]
      )
    );
  }

  async cancel(claims: RequestClaims, batchId: string): Promise<PayrollInputBatchView> {
    const companyId = await this.require(claims);
    return this.db.withClaims(claims, async (client) => {
      const b = await this.lock(client, companyId, batchId);
      if (!["dry_run_complete", "queued", "running", "failed"].includes(b.status)) throw new ConflictException(`A batch in status "${b.status}" cannot be cancelled`);
      if (b.status === "queued" && b.background_job_id) await client.query("UPDATE background_jobs SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status = 'queued'", [b.background_job_id]);
      const r = await client.query("UPDATE import_batches SET status = 'cancelled', finished_at = now() WHERE id = $1 RETURNING *", [batchId]);
      if (b.status !== "running") await this.scrub(client, batchId, true);
      await this.audit.record(client, claims, { companyId, action: "payroll_input_import.cancel", target: batchId, metadata: { from: b.status } });
      return toBatch(r.rows[0]);
    });
  }

  async retryFailed(claims: RequestClaims, batchId: string): Promise<PayrollInputBatchView> {
    const companyId = await this.require(claims);
    return this.db.withClaims(claims, async (client) => {
      const b = await this.lock(client, companyId, batchId);
      if (b.status !== "completed_with_errors" && b.status !== "failed") throw new ConflictException("Only a batch that finished with errors can be retried");
      const reset = await client.query("UPDATE import_rows SET status = 'valid', errors = '[]'::jsonb, processed_at = NULL WHERE batch_id = $1 AND status = 'failed' RETURNING id", [batchId]);
      if (!reset.rowCount) throw new BadRequestException("There are no failed rows to retry");
      const job = await this.jobs.enqueue(client, claims, { companyId, jobType: PAYROLL_INPUT_IMPORT_JOB, payload: { batchId }, idempotencyKey: `batch:${batchId}:retry:${Date.now()}`, maxAttempts: 5 });
      const r = await client.query("UPDATE import_batches SET status = 'queued', failed_rows = 0, checkpoint_row = 0, finished_at = NULL, background_job_id = $2 WHERE id = $1 RETURNING *", [batchId, job.id]);
      await this.audit.record(client, claims, { companyId, action: "payroll_input_import.retry_failed", target: batchId, metadata: { rows: reset.rowCount } });
      return toBatch(r.rows[0]);
    });
  }

  async get(claims: RequestClaims, batchId: string): Promise<PayrollInputBatchView> {
    const companyId = await this.require(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT * FROM import_batches WHERE id = $1 AND company_id = $2 AND import_type = ANY($3::text[])", [batchId, companyId, TYPES]);
      if (!r.rowCount) throw new NotFoundException("Import batch not found");
      return toBatch(r.rows[0]);
    });
  }

  async list(claims: RequestClaims, limit = 50): Promise<PayrollInputBatchView[]> {
    const companyId = await this.require(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT * FROM import_batches WHERE company_id = $1 AND import_type = ANY($2::text[]) ORDER BY created_at DESC LIMIT $3", [companyId, TYPES, Math.min(Math.max(limit, 1), 200)]);
      return r.rows.map(toBatch);
    });
  }

  async rows(claims: RequestClaims, batchId: string, filter: { status?: string; limit?: number; offset?: number } = {}): Promise<PayrollInputRowView[]> {
    await this.get(claims, batchId);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        "SELECT * FROM import_rows WHERE batch_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY row_number LIMIT $3 OFFSET $4",
        [batchId, filter.status ?? null, Math.min(Math.max(filter.limit ?? 200, 1), 1000), Math.max(filter.offset ?? 0, 0)]
      );
      return r.rows.map((x) => ({ rowNumber: x.row_number, status: x.status, payload: x.payload, errors: x.errors, employeeId: x.employee_id }));
    });
  }

  async errorReportCsv(claims: RequestClaims, batchId: string): Promise<string> {
    const batch = await this.get(claims, batchId);
    const template = PAYROLL_INPUT_TEMPLATES.find((t) => t.importType === batch.importType)!;
    const rows = [...(await this.rows(claims, batchId, { status: "invalid", limit: 1000 })), ...(await this.rows(claims, batchId, { status: "failed", limit: 1000 }))];
    rows.sort((a, b) => a.rowNumber - b.rowNumber);
    return this.importExport.toCsv(
      ["row", "status", "errors", ...template.columns.map((c) => c.name)],
      rows.map((r) => ({ row: r.rowNumber, status: r.status, errors: r.errors.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message)).join("; "), ...r.payload }))
    );
  }

  /** Daily hygiene: unexecuted dry runs of these types expire, and failed rows lose their values, after IMPORT_BATCH_RETENTION_DAYS (default 7). */
  async expireStaleBatches(days = Number(process.env.IMPORT_BATCH_RETENTION_DAYS ?? 7)): Promise<number> {
    const keep = Number.isFinite(days) && days > 0 ? days : 7;
    const svc: RequestClaims = { is_platform_admin: false, is_service: true, sub: "payroll-input-import-worker" };
    const expr = SENSITIVE_KEYS.map((k) => ` - '${k}'`).join("");
    return this.db.withClaims(svc, async (c) => {
      await c.query(
        `UPDATE import_rows r SET payload = r.payload${expr} FROM import_batches b
          WHERE r.batch_id = b.id AND b.import_type = ANY($2::text[]) AND r.status = 'failed' AND b.finished_at IS NOT NULL AND b.finished_at < now() - ($1 || ' days')::interval`,
        [String(keep), TYPES]
      );
      const stale = await c.query(
        `UPDATE import_batches SET status = 'cancelled', finished_at = now(), last_error = 'expired before execution'
          WHERE import_type = ANY($2::text[]) AND status = 'dry_run_complete' AND created_at < now() - ($1 || ' days')::interval RETURNING id`,
        [String(keep), TYPES]
      );
      for (const r of stale.rows) await this.scrub(c, r.id, true);
      if (stale.rowCount) this.logger.log(`Expired ${stale.rowCount} stale payroll input dry run(s)`);
      return stale.rowCount ?? 0;
    });
  }

  private async lock(client: PoolClient, companyId: string, batchId: string) {
    const r = await client.query("SELECT * FROM import_batches WHERE id = $1 AND company_id = $2 AND import_type = ANY($3::text[]) FOR UPDATE", [batchId, companyId, TYPES]);
    if (!r.rowCount) throw new NotFoundException("Import batch not found");
    return r.rows[0];
  }
}
