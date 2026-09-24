import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { FILE_STORAGE, type FileStorageService } from "../file-storage/file-storage.interface";
import type { RequestClaims } from "../database/tenant-context";
import type { TenantBackup } from "@aihxm/shared-types";

const INELIGIBLE_STATUSES = new Set(["archived", "churned"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toBackup(row: any): TenantBackup {
  return {
    id: row.id,
    companyId: row.company_id,
    status: row.status,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    fileKey: row.file_key,
    requestedBy: row.requested_by,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    error: row.error,
  };
}

/**
 * TM-035 — Backups. A real logical backup: a JSON snapshot of this
 * tenant's own rows (company profile, employees, admins, configuration,
 * module/feature entitlements, subscription history) written through
 * FileStorageService — the same interface the document vault uses — not
 * a fake row with a made-up size. There's no job queue in this codebase
 * (see CompaniesLifecycleScheduler's doc comment on why), so the backup
 * runs synchronously within the request; the `status` column still
 * exists so a future async worker is a service-internal change, not an
 * API/schema change.
 */
@Injectable()
export class BackupsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(FILE_STORAGE) private readonly fileStorage: FileStorageService
  ) {}

  async list(claims: RequestClaims, companyId: string): Promise<TenantBackup[]> {
    return this.db.withClaims(claims, async (client) => {
      const companyCheck = await client.query("SELECT id FROM companies WHERE id = $1", [companyId]);
      if (companyCheck.rowCount === 0) throw new NotFoundException("Company not found");
      const result = await client.query("SELECT * FROM tenant_backups WHERE company_id = $1 ORDER BY created_at DESC", [
        companyId,
      ]);
      return result.rows.map(toBackup);
    });
  }

  async create(claims: RequestClaims, companyId: string): Promise<TenantBackup> {
    return this.db.withClaims(claims, async (client) => {
      const companyRes = await client.query("SELECT id, name, status FROM companies WHERE id = $1", [companyId]);
      if (companyRes.rowCount === 0) throw new NotFoundException("Company not found");
      if (INELIGIBLE_STATUSES.has(companyRes.rows[0].status)) {
        throw new BadRequestException(`Tenant is not eligible for backup while status is '${companyRes.rows[0].status}'`);
      }

      const queuedRow = await client.query(
        `INSERT INTO tenant_backups (company_id, status, requested_by) VALUES ($1, 'running', $2) RETURNING *`,
        [companyId, claims.sub]
      );
      const backupId = queuedRow.rows[0].id;

      // A PoolClient is a single connection — these must run sequentially,
      // never Promise.all'd, or pg logs "query already executing" and can
      // interleave results unpredictably.
      const employees = await client.query("SELECT * FROM employees WHERE company_id = $1", [companyId]);
      const admins = await client.query(
        "SELECT id, full_name, email, status, created_at FROM company_admins WHERE company_id = $1",
        [companyId]
      );
      const configuration = await client.query(
        "SELECT category, setting_key, value FROM tenant_configuration WHERE company_id = $1",
        [companyId]
      );
      const features = await client.query(
        "SELECT feature_key, enabled, usage_limit FROM tenant_feature_entitlement WHERE company_id = $1",
        [companyId]
      );
      const subscriptionHistory = await client.query(
        "SELECT from_tier, to_tier, seats_purchased, changed_by, changed_at FROM tenant_subscription_history WHERE company_id = $1",
        [companyId]
      );

      const snapshot = {
        backupId,
        companyId,
        companyName: companyRes.rows[0].name,
        generatedAt: new Date().toISOString(),
        employees: employees.rows,
        admins: admins.rows,
        configuration: configuration.rows,
        featureEntitlements: features.rows,
        subscriptionHistory: subscriptionHistory.rows,
      };
      const buffer = Buffer.from(JSON.stringify(snapshot, null, 2), "utf8");

      let backup: TenantBackup;
      try {
        const stored = await this.fileStorage.save(companyId, "backups", `backup-${backupId}.json`, buffer);
        const completed = await client.query(
          `UPDATE tenant_backups SET status = 'completed', size_bytes = $2, file_key = $3, completed_at = now()
           WHERE id = $1 RETURNING *`,
          [backupId, stored.sizeBytes, stored.storagePath]
        );
        backup = toBackup(completed.rows[0]);
      } catch (err) {
        const failed = await client.query(
          `UPDATE tenant_backups SET status = 'failed', error = $2 WHERE id = $1 RETURNING *`,
          [backupId, (err as Error).message]
        );
        backup = toBackup(failed.rows[0]);
      }

      await this.audit.record(client, claims, {
        companyId,
        action: "tenant_backup.created",
        target: backup.id,
        metadata: { status: backup.status, sizeBytes: backup.sizeBytes },
      });

      this.notifications
        .dispatch(
          { ...claims, company_id: companyId },
          {
            channel: "email",
            recipient: "platform-ops@aihxm.internal",
            templateKey: backup.status === "completed" ? "tenant_backup_completed" : "tenant_backup_failed",
            payload: { backupId: backup.id, companyName: companyRes.rows[0].name, sizeBytes: backup.sizeBytes },
          }
        )
        .catch(() => undefined);

      return backup;
    });
  }

  async download(claims: RequestClaims, companyId: string, backupId: string): Promise<{ fileName: string; buffer: Buffer }> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "SELECT * FROM tenant_backups WHERE id = $1 AND company_id = $2",
        [backupId, companyId]
      );
      if (result.rowCount === 0) throw new NotFoundException("Backup not found");
      const backup = toBackup(result.rows[0]);
      if (backup.status !== "completed" || !backup.fileKey) {
        throw new BadRequestException(`Backup is '${backup.status}' — only a completed backup can be downloaded.`);
      }
      const buffer = await this.fileStorage.read(backup.fileKey);
      await this.audit.record(client, claims, {
        companyId,
        action: "tenant_backup.downloaded",
        target: backup.id,
      });
      return { fileName: `backup-${backupId}.json`, buffer };
    });
  }
}
