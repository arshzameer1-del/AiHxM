import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ImportExportService } from "../import-export/import-export.service";
import { FILE_STORAGE, type FileStorageService } from "../file-storage/file-storage.interface";
import type { RequestClaims } from "../database/tenant-context";
import type { DataExportFormat, DataExportScope, RequestDataExportRequest, TenantDataExport } from "@aihxm/shared-types";
import { decryptExportPayload, encryptExportPayload } from "./export-crypto";
import { TenantExportKeyService } from "./tenant-export-key.service";

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
    isPasswordProtected: row.is_password_protected,
  };
}

/**
 * TM-036 — Data export & migration jobs. Every scope pulls REAL rows for
 * this tenant (never a stub); CSV rendering reuses the same
 * `ImportExportService.toCsv()` the Payroll bank-disbursement export
 * already uses, rather than a second CSV writer. Every export expires
 * after `EXPORT_TTL_HOURS` and `download()` enforces it server-side, not
 * just in the UI.
 *
 * "Encrypted... password-protection" (Phase 2 gap-fill item #6): the
 * rendered payload is ALWAYS encrypted (AES-256-GCM, via
 * `export-crypto.ts`) before it ever reaches `FileStorageService` — this
 * used to be an honest gap (this class's own former comment: "no at-rest
 * encryption layer to hang a real 'encrypted' claim on yet"), now closed.
 * A requester can additionally supply a `password` at request time, which
 * re-keys the encryption to that password instead of the server's own
 * key — see export-crypto.ts's own doc comment for exactly what that
 * does and does not protect against, and why the password itself is
 * never persisted anywhere.
 *
 * Phase 3 item #5 — a tenant with a dedicated, enabled export encryption
 * key (`TenantExportKeyService`) gets its exports encrypted under THAT
 * key instead of the platform's shared server key, whenever no explicit
 * per-export `password` was supplied. Precedence, deliberately: an
 * explicit `password` always wins — a requester who asks for a one-off
 * password-protected export gets exactly that, regardless of whatever
 * standing tenant key exists, the same way a more specific setting always
 * overrides a more general default elsewhere in this codebase.
 */
@Injectable()
export class DataExportsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly importExport: ImportExportService,
    private readonly tenantExportKey: TenantExportKeyService,
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

  async request(claims: RequestClaims, companyId: string, dto: RequestDataExportRequest): Promise<TenantDataExport> {
    return this.db.withClaims(claims, async (client) => {
      const companyRes = await client.query("SELECT id, name FROM companies WHERE id = $1", [companyId]);
      if (companyRes.rowCount === 0) throw new NotFoundException("Company not found");

      const isPasswordProtected = Boolean(dto.password);
      const queuedRow = await client.query(
        `INSERT INTO tenant_data_exports (company_id, scope, format, status, requested_by, is_password_protected)
         VALUES ($1, $2, $3, 'running', $4, $5) RETURNING *`,
        [companyId, dto.scope, dto.format, claims.sub, isPasswordProtected]
      );
      const exportId = queuedRow.rows[0].id;

      let dataExport: TenantDataExport;
      try {
        const { fileName, buffer } = await this.buildPayload(client, companyId, dto.scope, dto.format, exportId);
        // Real data never touches storage in plaintext, regardless of
        // which of the three modes ends up keying it — see this class's
        // own doc comment and export-crypto.ts. An explicit password
        // always takes priority; only when none was supplied do we check
        // for a dedicated tenant key (Phase 3 item #5).
        const tenantKey = dto.password ? null : await this.tenantExportKey.resolveActiveKey(client, companyId);
        const encrypted = encryptExportPayload(buffer, dto.password, tenantKey ?? undefined);
        const stored = await this.fileStorage.save(companyId, "exports", fileName, encrypted);
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

  async download(
    claims: RequestClaims,
    companyId: string,
    exportId: string,
    password?: string
  ): Promise<{ fileName: string; buffer: Buffer }> {
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
      const encrypted = await this.fileStorage.read(dataExport.fileKey);
      let buffer: Buffer;
      if (encrypted[0] === 2) {
        // Phase 3 item #5 — envelope mode 2: this export was encrypted
        // under a tenant-dedicated key. There is no way to tell from the
        // envelope alone whether it was the tenant's CURRENT key or the
        // previous one (still valid, briefly, right after a rotation) —
        // see TenantExportKeyService.resolveKeyForDecryption()'s own doc
        // comment — so try current first, then previous within its grace
        // period, before giving up.
        const { current, previous } = await this.tenantExportKey.resolveKeyForDecryption(client, companyId);
        buffer = this.tryDecryptWithTenantKeys(encrypted, current, previous);
      } else {
        try {
          buffer = decryptExportPayload(encrypted, password);
        } catch (err) {
          const code = (err as Error).message;
          if (code === "PASSWORD_REQUIRED") {
            throw new BadRequestException("This export is password-protected — supply the password to download it.");
          }
          if (code === "INCORRECT_PASSWORD") {
            throw new BadRequestException("Incorrect password.");
          }
          throw new BadRequestException("This export could not be decrypted.");
        }
      }
      await this.audit.record(client, claims, {
        companyId,
        action: "tenant_data_export.downloaded",
        target: dataExport.id,
      });
      const ext = dataExport.format === "csv" ? "csv" : "json";
      return { fileName: `export-${dataExport.scope}-${exportId}.${ext}`, buffer };
    });
  }

  /**
   * Phase 3 item #5 — tries the tenant's current key, then its previous
   * one (if still within its rotation grace period), and only THEN gives
   * up — mirroring the existing PASSWORD_REQUIRED/INCORRECT_PASSWORD
   * error-code pattern with a mode-2-specific message, since "wrong
   * password" would be a misleading thing to tell a caller here (there is
   * no password involved at all in this mode).
   */
  private tryDecryptWithTenantKeys(encrypted: Buffer, current: Buffer | null, previous: Buffer | null): Buffer {
    for (const candidate of [current, previous]) {
      if (!candidate) continue;
      try {
        return decryptExportPayload(encrypted, undefined, candidate);
      } catch {
        // try the next candidate key, if any
      }
    }
    throw new BadRequestException(
      "This export was encrypted with this tenant's dedicated key, which could not be resolved for decryption."
    );
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
