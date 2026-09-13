import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import type { Role } from "@boostfactor/shared-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToRole(row: any): Role {
  return { id: row.id, key: row.key, name: row.name, description: row.description ?? null };
}

/**
 * Read-only catalog listing — the role/permission catalog itself is
 * written only by migrations for now (see 0004_rbac.sql's header comment:
 * a "tenant defines its own custom roles" screen is a later, explicitly
 * deferred enhancement, not built speculatively here).
 */
@Injectable()
export class RolesService {
  constructor(private readonly db: DatabaseService) {}

  async list(claims: RequestClaims): Promise<Role[]> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query("SELECT * FROM roles ORDER BY key ASC");
      return result.rows.map(rowToRole);
    });
  }
}
