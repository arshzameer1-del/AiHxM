import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ImportExportService } from "../import-export/import-export.service";
import { FILE_STORAGE, type FileStorageService } from "../file-storage/file-storage.interface";
import type { RequestClaims } from "../database/tenant-context";
import type { DataExportFormat, DataExportScope, TenantDataExport } from "@aihxm/shared-types";

const EXPORT_TTL_HOURS = 72;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toExport(row: any): TenantDataExport {
  return {
    id: row.id,
    companyId: row.company_id,
    scope: row.scope,
    format: row.format,
    status: row.status,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    fileKey: row.file_key,
    requestedBy: row.requested_by,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null,
    error: row.error,
  };
}

/**
 * TM-036 — Data export & migration jobs. Every scope pulls REAL rows for
 * this tenant (never a stub); CSV rendering reuses the same
 * `ImportExportService.toCsv()` the Payroll bank-disbursement export
 * already uses, rather than a second CSV writer. "Encrypted time-limited
 * download" (spec Notes): this codebase has no at-rest encryption layer
 * to hang a real "encrypted" claim on yet (see FileStorageService's own
 * doc comment on Supabase Storage being the pending replacement) — what's
 * genuinely implemented today is the time-limited half: every export
 * expires after `EXPORT_TTL_HOURS` and `download()` enforces it
 * server-side, not just in the UI.
 */
@Injectable()
export class DataExportsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly importExport: ImportExportService,
    @Inject(FILE_STORAGE) private readonly fileStorage: FileStorageService
  ) {}

  async list(claims: RequestClaims, companyId: string): Promise<TenantDataExport[]> {
    return this.db.withClaims(claims, async (client) => {
      const companyCheck = await client.query("SELECT id FROM companies WHERE id = $1", [companyId]);
      if (companyCheck.rowCount === 0) throw new NotFoundException("Company not found");
      const result = await client.query(
        "SELECT * FROM tenant_data_exports WHERE company_id = $1 ORDER BY created_at DESC",
        [companyId]
      );
      return result.rows.map(toExport);
    });
  }

  async request(
    claims: RequestClaims,
    companyId: string,
    dto: { scope: DataExportScope; format: DataExportFormat }
  ): Promise<TenantDataExport> {
    return this.db.withClaims(claims, async (client) => {
      const companyRes = await client.query("SELECT id, name FROM companies WHERE id = $1", [companyId]);
      if (companyRes.rowCount === 0) throw new NotFoundException("Company not found");

      const queuedRow = await client.query(
        `INSERT INTO tenant_data_exports (company_id, scope, format, status, requested_by)
         VALUES ($1, $2, $3, 'running', $4) RETURNING *`,
        [companyId, dto.scope, dto.format, claims.sub]
      );
      const exportId = queuedRow.rows[0].id;

      let dataExport: TenantDataExport;
      try {
        const { fileName, buffer } = await this.buildPayload(client, companyId, dto.scope, dto.format, exportId);
        const stored = await this.fileStorage.save(companyId, "exports", fileName, buffer);
        const expiresAt = new Date(Date.now() + EXPORT_TTL_HOURS * 60 * 60 * 1000);
        const completed = await client.query(
          `UPDATE tenant_data_exports
           SET status = 'completed', size_bytes = $2, file_key = $3, completed_at = now(), expires_at = $4
           WHERE id = $1 RETURNING *`,
          [exportId, stored.sizeBytes, stored.storagePath, expiresAt]
        );
        dataExport = toExport(completed.rows[0]);
      } catch (err) {
        const failed = await client.query(
          `UPDATE tenant_data_exports SET status = 'failed', error = $2 WHERE id = $1 RETURNING *`,
          [exportId, (err as Error).message]
        );
        dataExport = toExport(failed.rows[0]);
      }

      await this.audit.record(client, claims, {
        companyId,
        action: "tenant_data_export.requested",
        target: dataExport.id,
        metadata: { scope: dto.scope, format: dto.format, status: dataExport.status },
      });

      this.notifications
        .dispatch(
          { ...claims, company_id: companyId },
          {
            channel: "email",
            recipient: "platform-ops@aihxm.internal",
            templateKey: dataExport.status === "completed" ? "tenant_export_ready" : "tenant_export_failed",
            payload: { exportId: dataExport.id, companyName: companyRes.rows[0].name, scope: dto.scope },
          }
        )
        .catch(() => undefined);

      return dataExport;
    });
  }

  async download(claims: RequestClaims, companyId: string, exportId: string): Promise<{ fileName: string; buffer: Buffer }> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query("SELECT * FROM tenant_data_exports WHERE id = $1 AND company_id = $2", [
        exportId,
        companyId,
      ]);
      if (result.rowCount === 0) throw new NotFoundException("Data export not found");
      const dataExport = toExport(result.rows[0]);
      if (dataExport.status !== "completed" || !dataExport.fileKey) {
        throw new BadRequestException(`Export is '${dataExport.status}' — only a completed export can be downloaded.`);
      }
      if (dataExport.expiresAt && new Date(dataExport.expiresAt).getTime() < Date.now()) {
        throw new BadRequestException("This export has expired. Request a new one.");
      }
      const buffer = await this.fileStorage.read(dataExport.fileKey);
      await this.audit.record(client, claims, {
        companyId,
        action: "tenant_data_export.downloaded",
        target: dataExport.id,
      });
      const ext = dataExport.format === "csv" ? "csv" : "json";
      return { fileName: `export-${dataExport.scope}-${exportId}.${ext}`, buffer };
    });
  }

  private async buildPayload(
    client: PoolClient,
    companyId: string,
    scope: DataExportScope,
    format: DataExportFormat,
    exportId: string
  ): Promise<{ fileName: string; buffer: Buffer }> {
    const tables: Record<DataExportScope, { query: string; csvColumns: string[] }> = {
      employees: {
        query: "SELECT * FROM employees WHERE company_id = $1 ORDER BY employee_number",
        csvColumns: ["id", "employee_number", "first_name", "last_name", "employment_status", "hire_date"],
      },
      payroll: {
        query: `SELECT p.* FROM payslips p WHERE p.company_id = $1 ORDER BY p.created_at DESC`,
        csvColumns: ["id", "employee_number", "gross_pay", "net_pay", "income_tax_monthly", "created_at"],
      },
      attendance: {
        query: "SELECT * FROM attendance_records WHERE company_id = $1 ORDER BY clock_in_at DESC",
        csvColumns: ["id", "employee_number", "source", "clock_in_at", "clock_out_at"],
      },
      full: {
        // "full" always ships as a structured JSON bundle — a single CSV
        // can't represent multiple unrelated tables coherently, so a csv
        // request for scope=full still gets valid CSV: the employees
        // table, the scope's own natural primary entity.
        query: "SELECT * FROM employees WHERE company_id = $1 ORDER BY employee_number",
        csvColumns: ["id", "employee_number", "first_name", "last_name", "employment_status", "hire_date"],
      },
    };

    if (scope === "full" && format === "json") {
      const [employees, admins, attendance, payslips] = [
        await client.query("SELECT * FROM employees WHERE company_id = $1", [companyId]),
        await client.query(
          "SELECT id, full_name, email, status, created_at FROM company_admins WHERE company_id = $1",
          [companyId]
        ),
        await client.query("SELECT * FROM attendance_records WHERE company_id = $1", [companyId]),
        await client.query("SELECT * FROM payslips WHERE company_id = $1", [companyId]),
      ];
      const buffer = Buffer.from(
        JSON.stringify(
          {
            exportId,
            companyId,
            scope,
            generatedAt: new Date().toISOString(),
            employees: employees.rows,
            admins: admins.rows,
            attendance: attendance.rows,
            payslips: payslips.rows,
          },
          null,
          2
        ),
        "utf8"
      );
      return { fileName: `export-full-${exportId}.json`, buffer };
    }

    const table = tables[scope];
    const result = await client.query(table.query, [companyId]);

    if (format === "csv") {
      const csv = this.importExport.toCsv(table.csvColumns, result.rows);
      return { fileName: `export-${scope}-${exportId}.csv`, buffer: Buffer.from(csv, "utf8") };
    }

    const buffer = Buffer.from(
      JSON.stringify({ exportId, companyId, scope, generatedAt: new Date().toISOString(), rows: result.rows }, null, 2),
      "utf8"
    );
    return { fileName: `export-${scope}-${exportId}.json`, buffer };
  }
}
