import { Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import type { CompanyListFilters, PlatformSavedView } from "@aihxm/shared-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToView(row: any): PlatformSavedView {
  return {
    id: row.id,
    name: row.name,
    filters: row.filters ?? {},
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * TM-003's "Save as reusable view" — a named Tenant Directory filter combo,
 * platform-wide (any Platform Admin can see and reuse any saved view, same
 * as everything else in Tenant Management being a shared operational tool
 * rather than a personal workspace). Backed by `platform_saved_views`
 * (migration 0042).
 */
@Injectable()
export class SavedViewsService {
  constructor(private readonly db: DatabaseService) {}

  async list(claims: RequestClaims): Promise<PlatformSavedView[]> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query("SELECT * FROM platform_saved_views ORDER BY created_at ASC");
      return result.rows.map(rowToView);
    });
  }

  async create(claims: RequestClaims, name: string, filters: CompanyListFilters): Promise<PlatformSavedView> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "INSERT INTO platform_saved_views (name, filters, created_by) VALUES ($1, $2, $3) RETURNING *",
        [name, JSON.stringify(filters ?? {}), claims.sub]
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
