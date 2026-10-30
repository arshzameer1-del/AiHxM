import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { createHash } from "crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../database/database.service";
import type { RequestClaims } from "../../database/tenant-context";
import { RbacService } from "../../rbac/rbac.service";
import { EntitlementsService } from "../../entitlements/entitlements.service";
import { AuditService } from "../../audit/audit.service";
import { BackgroundJobsService } from "../../background-jobs/background-jobs.service";
import { ImportExportService } from "../../import-export/import-export.service";
import { EmployeeNumberingService } from "../employee-numbering.service";
import { EmployeesService } from "../employees.service";
import type { CreateEmployeeRequest } from "@aihxm/shared-types";

export const EMPLOYEE_IMPORT_JOB = "employee_import";
const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";
const MAX_ROWS = 5000;
const MAX_CSV_BYTES = 5 * 1024 * 1024;
const BUILTIN_EMPLOYMENT_TYPES = ["permanent", "contract", "probation", "intern"];
/** keys nulled out of import_rows.payload once a batch is finished (SEC-04 style hygiene) */
export const SENSITIVE_IMPORT_KEYS = ["cnic", "bankAccountNumber", "dateOfBirth", "salaryBand"] as const;

export type ImportRowError = { field?: string; message: string };
export type ImportBatchView = {
  id: string;
  importType: "employees";
  status: string;
  fileName: string | null;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  importedRows: number;
  failedRows: number;
  checkpointRow: number;
  allowPartial: boolean;
  configHash: string;
  backgroundJobId: string | null;
  createdAt: string;
  executedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
};
export type ImportRowView = {
  rowNumber: number;
  status: "valid" | "invalid" | "imported" | "failed";
  payload: Record<string, unknown>;
  errors: ImportRowError[];
  employeeId: string | null;
};

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : ((v as string | null) ?? null));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toBatch(r: any): ImportBatchView {
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
    configHash: r.config_hash,
    backgroundJobId: r.background_job_id,
    createdAt: iso(r.created_at) as string,
    executedAt: iso(r.executed_at),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    lastError: r.last_error,
  };
}

const isRealDate = (v: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Gap Register LIF-11 -- bulk hiring as a validated, resumable batch.
 * dryRun() stores a per-row verdict without creating anything; execute()
 * queues a background job that creates the valid rows one transaction at a
 * time and records a checkpoint, so a crash resumes instead of restarting
 * and a bad row never aborts the rest. The legacy synchronous
 * EmployeesService.bulkImportEmployees() is untouched.
 */
@Injectable()
export class EmployeeImportService {
  private readonly logger = new Logger(EmployeeImportService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly jobs: BackgroundJobsService,
    private readonly employees: EmployeesService,
    private readonly numbering: EmployeeNumberingService,
    private readonly importExport: ImportExportService = new ImportExportService()
  ) {}

  private async requireManage(claims: RequestClaims): Promise<string> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) throw new ForbiddenException("Not permitted to manage employee records");
    if (!claims.company_id) throw new ForbiddenException();
    return claims.company_id;
  }

  /** What the dry run was validated against; a change invalidates the dry run. */
  async currentConfig(client: PoolClient, companyId: string): Promise<{ hash: string; snapshot: Record<string, unknown> }> {
    const policy = await this.numbering.loadPolicy(client, companyId);
    const cards = await client.query(
      `SELECT card_key, is_enabled, is_required, config_version, config_status
         FROM core_employee_card_definitions WHERE company_id = $1 ORDER BY card_key`,
      [companyId]
    );
    const fields = await client.query(
      `SELECT card_key, field_key, is_enabled, is_required
         FROM core_employee_card_field_definitions WHERE company_id = $1 ORDER BY card_key, field_key`,
      [companyId]
    );
    const snapshot = {
      numbering: {
        generationTiming: policy.generationTiming,
        resetPolicy: policy.resetPolicy,
        allowManual: policy.allowManual,
        manualPattern: policy.manualPattern,
      },
      cards: cards.rows,
      fields: fields.rows,
    };
    return { hash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"), snapshot };
  }

  // ----------------------------------------------------------------- dry run
  async dryRun(
    claims: RequestClaims,
    input: { csv: string; fileName?: string; allowPartial?: boolean },
    idempotencyKey?: string
  ): Promise<ImportBatchView> {
    const companyId = await this.requireManage(claims);
    if (Buffer.byteLength(input.csv, "utf8") > MAX_CSV_BYTES) throw new BadRequestException("The file is larger than 5 MB.");
    const sourceHash = createHash("sha256").update(input.csv).digest("hex");

    return this.db.withClaims(claims, async (client) => {
      if (idempotencyKey) {
        const existing = await client.query(
          "SELECT * FROM import_batches WHERE company_id = $1 AND import_type = 'employees' AND idempotency_key = $2",
          [companyId, idempotencyKey]
        );
        if (existing.rowCount) {
          if (existing.rows[0].source_hash !== sourceHash) {
            throw new ConflictException("This Idempotency-Key was already used for a different file.");
          }
          return toBatch(existing.rows[0]);
        }
      }

      const { header, rows } = this.importExport.parseCsv(input.csv);
      const missing = ["firstName", "lastName"].filter((c) => !header.includes(c));
      if (missing.length > 0) throw new BadRequestException(`Missing required column(s): ${missing.join(", ")}`);
      if (rows.length === 0) throw new BadRequestException("The file has no data rows.");
      if (rows.length > MAX_ROWS) throw new BadRequestException(`A single import is limited to ${MAX_ROWS} rows.`);

      const cfg = await this.currentConfig(client, companyId);
      const policy = await this.numbering.loadPolicy(client, companyId);
      const verdicts = await this.validateRows(client, companyId, header, rows, policy);

      const valid = verdicts.filter((v) => v.errors.length === 0).length;
      const batch = await client.query(
        `INSERT INTO import_batches (company_id, file_name, source_hash, config_hash, config_snapshot, total_rows, valid_rows, invalid_rows,
                                     allow_partial, idempotency_key, created_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [
          companyId,
          input.fileName ?? null,
          sourceHash,
          cfg.hash,
          JSON.stringify(cfg.snapshot),
          rows.length,
          valid,
          rows.length - valid,
          input.allowPartial ?? false,
          idempotencyKey ?? null,
          claims.sub,
        ]
      );
      const batchId = batch.rows[0].id as string;
      for (const v of verdicts) {
        await client.query(
          `INSERT INTO import_rows (batch_id, company_id, row_number, status, payload, errors)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
          [batchId, companyId, v.rowNumber, v.errors.length === 0 ? "valid" : "invalid", JSON.stringify(v.payload), JSON.stringify(v.errors)]
        );
      }
      await this.audit.record(client, claims, {
        companyId,
        action: "employee_import.dry_run",
        target: batchId,
        metadata: { totalRows: rows.length, validRows: valid, invalidRows: rows.length - valid },
      });
      return toBatch(batch.rows[0]);
    });
  }

  private async validateRows(
    client: PoolClient,
    companyId: string,
    header: string[],
    rows: string[][],
    policy: { allowManual: boolean; manualPattern: string }
  ): Promise<Array<{ rowNumber: number; payload: CreateEmployeeRequest & Record<string, unknown>; errors: ImportRowError[] }>> {
    const catalog = await client.query<{ code: string }>(
      "SELECT code FROM hr_reference_catalog_items WHERE company_id = $1 AND catalog_type = 'employment_type' AND is_active",
      [companyId]
    );
    const employmentTypes = new Set<string>([...BUILTIN_EMPLOYMENT_TYPES, ...catalog.rows.map((r) => r.code)]);
    let manualRe: RegExp | null = null;
    try {
      manualRe = new RegExp(policy.manualPattern);
    } catch {
      manualRe = null;
    }

    const exists = async (table: string, id: string) => {
      const r = await client.query(`SELECT 1 FROM ${table} WHERE id = $1 AND company_id = $2`, [id, companyId]);
      return (r.rowCount ?? 0) > 0;
    };

    const seenNumbers = new Map<string, number>();
    const seenSignatures = new Map<string, number>();
    const out: Array<{ rowNumber: number; payload: CreateEmployeeRequest & Record<string, unknown>; errors: ImportRowError[] }> = [];

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 2;
      const rec: Record<string, string> = {};
      header.forEach((col, ci) => {
        rec[col] = (rows[i][ci] ?? "").trim();
      });
      const errors: ImportRowError[] = [];
      const payload = {
        firstName: rec.firstName,
        lastName: rec.lastName,
        employeeNumber: rec.employeeNumber || undefined,
        email: rec.email || undefined,
        phone: rec.phone || undefined,
        cnic: rec.cnic || undefined,
        dateOfBirth: rec.dateOfBirth || undefined,
        gender: rec.gender ? ({ m: "male", f: "female" } as Record<string, string>)[rec.gender.trim().toLowerCase()] ?? rec.gender.trim() : undefined,
        maritalStatus: rec.maritalStatus || undefined,
        department: rec.department || undefined,
        orgUnitId: rec.orgUnitId || undefined,
        designation: rec.designation || undefined,
        location: rec.location || undefined,
        locationId: rec.locationId || undefined,
        employmentType: rec.employmentType || undefined,
        managerId: rec.managerId || undefined,
        dateOfJoining: rec.dateOfJoining || undefined,
        salaryBand: rec.salaryBand || undefined,
        bankAccountNumber: rec.bankAccountNumber || undefined,
      } as CreateEmployeeRequest & Record<string, unknown>;

      if (!payload.firstName) errors.push({ field: "firstName", message: "First name is required" });
      if (!payload.lastName) errors.push({ field: "lastName", message: "Last name is required" });
      if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) errors.push({ field: "email", message: "Not a valid email address" });
      if (payload.cnic && !/^\d{5}-?\d{7}-?\d$/.test(payload.cnic)) errors.push({ field: "cnic", message: "CNIC must be 13 digits (e.g. 35202-1234567-1)" });
      for (const f of ["dateOfBirth", "dateOfJoining"] as const) {
        const v = payload[f] as string | undefined;
        if (v && !isRealDate(v)) errors.push({ field: f, message: "Use a real date in YYYY-MM-DD format" });
      }
      if (payload.employmentType && !employmentTypes.has(payload.employmentType)) {
        errors.push({ field: "employmentType", message: `Unknown employment type "${payload.employmentType}"` });
      }
      for (const [field, table] of [["orgUnitId", "org_units"], ["locationId", "locations"], ["managerId", "employees"]] as const) {
        const v = payload[field] as string | undefined;
        if (!v) continue;
        if (!UUID_RE.test(v)) errors.push({ field, message: "Must be an id (UUID)" });
        else if (!(await exists(table, v))) errors.push({ field, message: "Not found in this company" });
      }

      const num = payload.employeeNumber;
      if (num) {
        if (!policy.allowManual) errors.push({ field: "employeeNumber", message: "Manual employee numbers are not allowed; leave it blank" });
        else if (manualRe && !manualRe.test(num)) errors.push({ field: "employeeNumber", message: "Does not match the allowed employee number pattern" });
        const key = num.toLowerCase();
        if (seenNumbers.has(key)) errors.push({ field: "employeeNumber", message: `Same employee number as row ${seenNumbers.get(key)}` });
        else seenNumbers.set(key, rowNumber);
        const used = await client.query(
          `SELECT 1 FROM employee_numbers WHERE company_id = $1 AND employee_number = $2
           UNION ALL SELECT 1 FROM employees WHERE company_id = $1 AND employee_number = $2 LIMIT 1`,
          [companyId, num]
        );
        if (used.rowCount) errors.push({ field: "employeeNumber", message: "This employee number is already issued, reserved or retired" });
      }

      const signature = JSON.stringify(
        Object.entries(payload)
          .filter(([k]) => k !== "employeeNumber")
          .map(([, v]) => String(v ?? "").trim().toLowerCase())
      );
      if (seenSignatures.has(signature)) errors.push({ message: `Identical to row ${seenSignatures.get(signature)} (duplicate row)` });
      else seenSignatures.set(signature, rowNumber);

      out.push({ rowNumber, payload, errors });
    }
    return out;
  }

  // -------------------------------------------------------------- execution
  async execute(claims: RequestClaims, batchId: string, idempotencyKey?: string): Promise<ImportBatchView> {
    const companyId = await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const cur = await client.query("SELECT * FROM import_batches WHERE id = $1 AND company_id = $2 AND import_type = 'employees' FOR UPDATE", [batchId, companyId]);
      if (!cur.rowCount) throw new NotFoundException("Import batch not found");
      const batch = cur.rows[0];
      if (batch.status !== "dry_run_complete") {
        // a retried execute of an already-queued/finished batch returns it unchanged
        if (["queued", "running", "completed", "completed_with_errors"].includes(batch.status)) return toBatch(batch);
        throw new ConflictException(`A batch in status "${batch.status}" cannot be executed`);
      }
      if (batch.valid_rows === 0) throw new BadRequestException("No valid rows to import");
      if (batch.invalid_rows > 0 && !batch.allow_partial) {
        throw new BadRequestException(
          `${batch.invalid_rows} row(s) failed validation. Fix the file and run a new dry run, or re-run the dry run with allowPartial to import only the valid rows.`
        );
      }
      const cfg = await this.currentConfig(client, companyId);
      if (cfg.hash !== batch.config_hash) {
        throw new ConflictException("Employee configuration changed since this dry run. Run the dry run again before importing.");
      }
      const job = await this.jobs.enqueue(client, claims, {
        companyId,
        jobType: EMPLOYEE_IMPORT_JOB,
        payload: { batchId },
        idempotencyKey: idempotencyKey ?? `batch:${batchId}`,
        maxAttempts: 5,
      });
      const updated = await client.query(
        `UPDATE import_batches SET status = 'queued', background_job_id = $2, executed_at = now(), executed_by_user_account_id = $3
          WHERE id = $1 RETURNING *`,
        [batchId, job.id, claims.sub]
      );
      await this.audit.record(client, claims, {
        companyId,
        action: "employee_import.execute",
        target: batchId,
        metadata: { jobId: job.id, validRows: batch.valid_rows },
      });
      return toBatch(updated.rows[0]);
    });
  }

  /**
   * Worker entry point: creates the batch's pending valid rows, resuming after
   * checkpoint_row. Acts as the user who started the import, so their
   * permissions are re-checked per row (a revoked permission fails the row).
   */
  async processBatch(batchId: string, onProgress?: (percent: number, note: string) => Promise<void>): Promise<ImportBatchView> {
    const svc: RequestClaims = { is_platform_admin: false, is_service: true, sub: "employee-import-worker" };
    const head = await this.db.withClaims(svc, async (client) => {
      const r = await client.query("SELECT * FROM import_batches WHERE id = $1 FOR UPDATE", [batchId]);
      if (!r.rowCount) throw new NotFoundException("Import batch not found");
      const b = r.rows[0];
      if (b.status === "cancelled" || b.status === "completed" || b.status === "completed_with_errors") return b;
      await client.query("UPDATE import_batches SET status = 'running', started_at = COALESCE(started_at, now()) WHERE id = $1", [batchId]);
      return b;
    });
    if (["cancelled", "completed", "completed_with_errors"].includes(head.status)) {
      return this.db.withClaims(svc, async (c) => toBatch((await c.query("SELECT * FROM import_batches WHERE id = $1", [batchId])).rows[0]));
    }
    const actor: RequestClaims = { is_platform_admin: false, company_id: head.company_id, sub: head.executed_by_user_account_id ?? head.created_by_user_account_id };

    const pending = await this.db.withClaims(svc, async (c) =>
      (await c.query("SELECT id, row_number, payload FROM import_rows WHERE batch_id = $1 AND status = 'valid' AND row_number > $2 ORDER BY row_number", [batchId, head.checkpoint_row])).rows
    );
    let done = 0;
    for (const row of pending) {
      // a cancel issued mid-run stops at the next row boundary
      const state = await this.db.withClaims(svc, async (c) => (await c.query("SELECT status FROM import_batches WHERE id = $1", [batchId])).rows[0]?.status);
      if (state === "cancelled") break;

      let employeeId: string | null = null;
      let failure: string | null = null;
      try {
        const created = await this.employees.create(actor, row.payload as CreateEmployeeRequest);
        employeeId = created.id;
      } catch (err) {
        failure = err instanceof Error ? err.message : "Row could not be imported";
        if (failure.length > 500) failure = failure.slice(0, 500);
      }
      await this.db.withClaims(svc, async (c) => {
        if (employeeId) {
          await c.query("UPDATE import_rows SET status = 'imported', employee_id = $2, processed_at = now() WHERE id = $1", [row.id, employeeId]);
          await c.query("UPDATE import_batches SET imported_rows = imported_rows + 1, checkpoint_row = $2 WHERE id = $1", [batchId, row.row_number]);
        } else {
          await c.query(
            "UPDATE import_rows SET status = 'failed', errors = $2::jsonb, processed_at = now() WHERE id = $1",
            [row.id, JSON.stringify([{ message: failure }])]
          );
          await c.query("UPDATE import_batches SET failed_rows = failed_rows + 1, checkpoint_row = $2 WHERE id = $1", [batchId, row.row_number]);
        }
      });
      done += 1;
      if (onProgress && (done % 10 === 0 || done === pending.length)) {
        await onProgress(Math.round((done / Math.max(pending.length, 1)) * 100), `${done}/${pending.length} rows`);
      }
    }

    return this.db.withClaims(svc, async (c) => {
      const cur = await c.query("SELECT status, failed_rows FROM import_batches WHERE id = $1", [batchId]);
      if (cur.rows[0].status === "cancelled") {
        await this.scrub(c, batchId, true);
        return toBatch((await c.query("SELECT * FROM import_batches WHERE id = $1", [batchId])).rows[0]);
      }
      const r = await c.query(
        `UPDATE import_batches
            SET status = CASE WHEN failed_rows > 0 THEN 'completed_with_errors' ELSE 'completed' END, finished_at = now(), last_error = NULL
          WHERE id = $1 RETURNING *`,
        [batchId]
      );
      await this.scrub(c, batchId);
      await this.audit.record(c, svc, {
        companyId: head.company_id,
        action: "employee_import.finish",
        target: batchId,
        metadata: { imported: r.rows[0].imported_rows, failed: r.rows[0].failed_rows },
      });
      return toBatch(r.rows[0]);
    });
  }

  /** Nulls the sensitive keys in a finished batch's stored rows. */
  private async scrub(client: PoolClient, batchId: string, includeFailed = false): Promise<void> {
    // failed rows keep their values so retryFailed() can re-run them; they are
    // scrubbed on cancel and by expireStaleBatches() after the retention period
    await client.query(
      `UPDATE import_rows SET payload = payload - 'cnic' - 'bankAccountNumber' - 'dateOfBirth' - 'salaryBand'
        WHERE batch_id = $1 AND ($2::boolean OR status <> 'failed')`,
      [batchId, includeFailed]
    );
  }

  /** Marks a failed attempt on the batch (called by the worker when the job itself throws). */
  async recordJobFailure(batchId: string, message: string, finalAttempt: boolean): Promise<void> {
    const svc: RequestClaims = { is_platform_admin: false, is_service: true, sub: "employee-import-worker" };
    await this.db.withClaims(svc, async (c) => {
      await c.query(
        `UPDATE import_batches SET last_error = left($2, 2000),
                status = CASE WHEN $3::boolean THEN 'failed' ELSE 'queued' END,
                finished_at = CASE WHEN $3::boolean THEN now() ELSE NULL END
          WHERE id = $1 AND status IN ('queued', 'running')`,
        [batchId, message, finalAttempt]
      );
    });
  }

  // ------------------------------------------------------------- management
  async cancel(claims: RequestClaims, batchId: string): Promise<ImportBatchView> {
    const companyId = await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const cur = await client.query("SELECT * FROM import_batches WHERE id = $1 AND company_id = $2 AND import_type = 'employees' FOR UPDATE", [batchId, companyId]);
      if (!cur.rowCount) throw new NotFoundException("Import batch not found");
      const b = cur.rows[0];
      if (!["dry_run_complete", "queued", "running", "failed"].includes(b.status)) {
        throw new ConflictException(`A batch in status "${b.status}" cannot be cancelled`);
      }
      if (b.status === "queued" && b.background_job_id) {
        await client.query("UPDATE background_jobs SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status = 'queued'", [b.background_job_id]);
      }
      const r = await client.query("UPDATE import_batches SET status = 'cancelled', finished_at = now() WHERE id = $1 RETURNING *", [batchId]);
      // a running batch is scrubbed by the worker when it stops; the rest now
      if (b.status !== "running") await this.scrub(client, batchId, true);
      await this.audit.record(client, claims, { companyId, action: "employee_import.cancel", target: batchId, metadata: { from: b.status } });
      return toBatch(r.rows[0]);
    });
  }

  /** Re-queues the rows that failed (not the invalid ones) as a fresh execution of the same batch. */
  async retryFailed(claims: RequestClaims, batchId: string): Promise<ImportBatchView> {
    const companyId = await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const cur = await client.query("SELECT * FROM import_batches WHERE id = $1 AND company_id = $2 AND import_type = 'employees' FOR UPDATE", [batchId, companyId]);
      if (!cur.rowCount) throw new NotFoundException("Import batch not found");
      const b = cur.rows[0];
      if (b.status !== "completed_with_errors" && b.status !== "failed") {
        throw new ConflictException("Only a batch that finished with errors can be retried");
      }
      // failed rows still hold their original values (see scrub()), unless the retention period already passed
      if (b.finished_at && Date.now() - new Date(b.finished_at).getTime() > this.retentionDays() * 86_400_000) {
        throw new ConflictException("This batch is past its retention period; upload the corrected rows again");
      }
      const reset = await client.query("UPDATE import_rows SET status = 'valid', errors = '[]'::jsonb, processed_at = NULL WHERE batch_id = $1 AND status = 'failed' RETURNING id", [batchId]);
      if (!reset.rowCount) throw new BadRequestException("There are no failed rows to retry");
      const job = await this.jobs.enqueue(client, claims, {
        companyId,
        jobType: EMPLOYEE_IMPORT_JOB,
        payload: { batchId },
        idempotencyKey: `batch:${batchId}:retry:${Date.now()}`,
        maxAttempts: 5,
      });
      const r = await client.query(
        `UPDATE import_batches SET status = 'queued', failed_rows = 0, checkpoint_row = 0, finished_at = NULL, background_job_id = $2 WHERE id = $1 RETURNING *`,
        [batchId, job.id]
      );
      await this.audit.record(client, claims, { companyId, action: "employee_import.retry_failed", target: batchId, metadata: { rows: reset.rowCount } });
      return toBatch(r.rows[0]);
    });
  }

  async get(claims: RequestClaims, batchId: string): Promise<ImportBatchView> {
    const companyId = await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT * FROM import_batches WHERE id = $1 AND company_id = $2 AND import_type = 'employees'", [batchId, companyId]);
      if (!r.rowCount) throw new NotFoundException("Import batch not found");
      return toBatch(r.rows[0]);
    });
  }

  async list(claims: RequestClaims, limit = 50): Promise<ImportBatchView[]> {
    const companyId = await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT * FROM import_batches WHERE company_id = $1 AND import_type = 'employees' ORDER BY created_at DESC LIMIT $2", [companyId, Math.min(Math.max(limit, 1), 200)]);
      return r.rows.map(toBatch);
    });
  }

  async rows(claims: RequestClaims, batchId: string, filter: { status?: string; limit?: number; offset?: number } = {}): Promise<ImportRowView[]> {
    await this.get(claims, batchId);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT * FROM import_rows WHERE batch_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY row_number LIMIT $3 OFFSET $4`,
        [batchId, filter.status ?? null, Math.min(Math.max(filter.limit ?? 200, 1), 1000), Math.max(filter.offset ?? 0, 0)]
      );
      return r.rows.map((x) => ({ rowNumber: x.row_number, status: x.status, payload: x.payload, errors: x.errors, employeeId: x.employee_id }));
    });
  }

  /** CSV of every invalid / failed row with its error text, ready to fix and re-upload. */
  async errorReportCsv(claims: RequestClaims, batchId: string): Promise<string> {
    const rows = [...(await this.rows(claims, batchId, { status: "invalid", limit: 1000 })), ...(await this.rows(claims, batchId, { status: "failed", limit: 1000 }))];
    rows.sort((a, b) => a.rowNumber - b.rowNumber);
    const header = ["row", "status", "errors", "firstName", "lastName", "employeeNumber", "email", "phone", "department", "designation", "employmentType", "dateOfJoining"];
    return this.importExport.toCsv(
      header,
      rows.map((r) => ({
        row: r.rowNumber,
        status: r.status,
        errors: r.errors.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message)).join("; "),
        ...r.payload,
      }))
    );
  }

  private retentionDays(): number {
    const d = Number(process.env.IMPORT_BATCH_RETENTION_DAYS ?? 7);
    return Number.isFinite(d) && d > 0 ? d : 7;
  }

  /** Daily hygiene: dry runs nobody executed are cancelled and scrubbed, and failed rows lose their values, after IMPORT_BATCH_RETENTION_DAYS (default 7). */
  async expireStaleBatches(days = this.retentionDays()): Promise<number> {
    const svc: RequestClaims = { is_platform_admin: false, is_service: true, sub: "employee-import-worker" };
    const keep = Number.isFinite(days) && days > 0 ? days : 7;
    return this.db.withClaims(svc, async (c) => {
      await c.query(
        `UPDATE import_rows r SET payload = r.payload - 'cnic' - 'bankAccountNumber' - 'dateOfBirth' - 'salaryBand'
           FROM import_batches b
          WHERE r.batch_id = b.id AND b.import_type = 'employees' AND r.status = 'failed' AND b.finished_at IS NOT NULL
            AND b.finished_at < now() - ($1 || ' days')::interval`,
        [String(keep)]
      );
      const stale = await c.query(
        `UPDATE import_batches SET status = 'cancelled', finished_at = now(), last_error = 'expired before execution'
          WHERE import_type = 'employees' AND status = 'dry_run_complete' AND created_at < now() - ($1 || ' days')::interval RETURNING id`,
        [String(keep)]
      );
      for (const r of stale.rows) await this.scrub(c, r.id, true);
      if (stale.rowCount) this.logger.log(`Expired ${stale.rowCount} stale import dry run(s)`);
      return stale.rowCount ?? 0;
    });
  }
}
