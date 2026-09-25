import { Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import type { AuditLogFilters, CompanyListFilters, PlatformSavedView, PlatformSavedViewType } from "@aihxm/shared-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToView(row: any): PlatformSavedView {
  return {
    id: row.id,
    name: row.name,
    viewType: row.view_type,
    filters: row.filters ?? {},
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * TM-003's "Save as reusable view" — a named, reusable filter combo,
 * platform-wide (any Platform Admin can see and reuse any saved view, same
 * as everything else in Tenant Management being a shared operational tool
 * rather than a personal workspace). Backed by `platform_saved_views`
 * (migration 0042). Extended by Phase 1 item #6 to also hold Audit Log
 * searches, discriminated by `view_type` (migration 0051) — every existing
 * row predates that column and defaults to 'tenant_directory', which is
 * exactly what it always was.
 */
@Injectable()
export class SavedViewsService {
  constructor(private readonly db: DatabaseService) {}

  async list(claims: RequestClaims, viewType?: PlatformSavedViewType): Promise<PlatformSavedView[]> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "SELECT * FROM platform_saved_views WHERE ($1::text IS NULL OR view_type = $1) ORDER BY created_at ASC",
        [viewType ?? null]
      );
      return result.rows.map(rowToView);
    });
  }

  async create(
    claims: RequestClaims,
    name: string,
    viewType: PlatformSavedViewType,
    filters: CompanyListFilters | AuditLogFilters
  ): Promise<PlatformSavedView> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "INSERT INTO platform_saved_views (name, view_type, filters, created_by) VALUES ($1, $2, $3, $4) RETURNING *",
        [name, viewType, JSON.stringify(filters ?? {}), claims.sub]
      );
      return rowToView(result.rows[0]);
    });
  }

  async delete(claims: RequestClaims, id: string): Promise<void> {
    await this.db.withClaims(claims, async (client) => {
      const result = await client.query("DELETE FROM platform_saved_views WHERE id = $1", [id]);
      if (result.rowCount === 0) {
        throw new NotFoundException("Saved view not found");
      }
    });
  }
}
