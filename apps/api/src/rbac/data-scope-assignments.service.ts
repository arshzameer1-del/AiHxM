import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import type { PoolClient } from "pg";
import type { AssignDataScopeRequest, DataScopeAssignmentView, DataScopeType } from "@aihxm/shared-types";

// Which table a `scope_entity_id` must exist in, keyed by `scope_type` —
// see 0078_data_scope_assignments.sql's own header comment on why this
// validation lives here (application layer) rather than as a same-column
// FK, which can only ever point at one table. A `switch` (rather than a
// lookup map feeding a template-interpolated table name into raw SQL)
// keeps every query string here a fixed literal, matching how every other
// service in this codebase writes its `mustExistX()` checks.
async function scopeEntityExists(
  client: PoolClient,
  scopeType: DataScopeType,
  scopeEntityId: string,
  companyId: string
): Promise<boolean> {
  let result;
  switch (scopeType) {
    case "org_unit":
      result = await client.query("SELECT 1 FROM org_units WHERE id = $1 AND company_id = $2", [scopeEntityId, companyId]);
      break;
    case "location":
      result = await client.query("SELECT 1 FROM locations WHERE id = $1 AND company_id = $2", [scopeEntityId, companyId]);
      break;
    case "cost_center":
      result = await client.query("SELECT 1 FROM cost_centers WHERE id = $1 AND company_id = $2", [scopeEntityId, companyId]);
      break;
  }
  return (result.rowCount ?? 0) > 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToAssignment(row: any): DataScopeAssignmentView {
  return {
    id: row.id,
    userAccountId: row.user_account_id,
    companyId: row.company_id,
    scopeType: row.scope_type,
    scopeEntityId: row.scope_entity_id,
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
  };
}

/**
 * Organization Management Phase 11 (Unified Integration & Synchronization
 * Requirements, Section 19) — assigns/revokes the `data_scope_assignments`
 * rows RbacService.resolveDataScopeEntityIds() reads. Deliberately mirrors
 * RoleAssignmentsService exactly: Platform-Admin-only for now (see that
 * class's own doc comment — a Company Super Admin self-service version is
 * the same reasonable, deliberately deferred enhancement), thin enough
 * that fixtures and any admin who needs to grant a scope go through the
 * real API rather than a raw SQL insert.
 *
 * A data scope assignment only means something once the target user also
 * holds a role with the matching `<object>.view.scoped` permission
 * (0079_data_scope_seed.sql's `regional_hr`/`regional_finance`, or any
 * future custom role) — this service doesn't check that at write time
 * (an admin may reasonably assign scope before or after the role), only
 * that the entity itself is real.
 */
@Injectable()
export class DataScopeAssignmentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService
  ) {}

  async list(claims: RequestClaims, companyId?: string, userAccountId?: string): Promise<DataScopeAssignmentView[]> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT * FROM data_scope_assignments
         WHERE ($1::uuid IS NULL OR company_id = $1)
           AND ($2::uuid IS NULL OR user_account_id = $2)
         ORDER BY created_at ASC`,
        [companyId ?? null, userAccountId ?? null]
      );
      return result.rows.map(rowToAssignment);
    });
  }

  async assign(claims: RequestClaims, input: AssignDataScopeRequest): Promise<DataScopeAssignmentView> {
    return this.db.withClaims(claims, async (client) => {
      const exists = await scopeEntityExists(client, input.scopeType, input.scopeEntityId, input.companyId);
      if (!exists) {
        throw new NotFoundException(`No ${input.scopeType.replace("_", " ")} with that id in this company`);
      }

      const existing = await client.query(
        `SELECT 1 FROM data_scope_assignments
         WHERE user_account_id = $1 AND company_id = $2 AND scope_type = $3 AND scope_entity_id = $4`,
        [input.userAccountId, input.companyId, input.scopeType, input.scopeEntityId]
      );
      if ((existing.rowCount ?? 0) > 0) {
        throw new ConflictException("This user already holds this exact data scope assignment");
      }

      const result = await client.query(
        `INSERT INTO data_scope_assignments (user_account_id, company_id, scope_type, scope_entity_id)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [input.userAccountId, input.companyId, input.scopeType, input.scopeEntityId]
      );

      await this.audit.record(client, claims, {
        companyId: input.companyId,
        action: "rbac.data_scope_assigned",
        target: input.userAccountId,
        metadata: { scopeType: input.scopeType, scopeEntityId: input.scopeEntityId },
      });

      return rowToAssignment(result.rows[0]);
    });
  }

  async revoke(claims: RequestClaims, id: string): Promise<void> {
    await this.db.withClaims(claims, async (client) => {
      const existing = await client.query("SELECT * FROM data_scope_assignments WHERE id = $1", [id]);
      if (existing.rowCount === 0) {
        throw new NotFoundException("Data scope assignment not found");
      }

      await client.query("DELETE FROM data_scope_assignments WHERE id = $1", [id]);

      await this.audit.record(client, claims, {
        companyId: existing.rows[0].company_id,
        action: "rbac.data_scope_revoked",
        target: existing.rows[0].user_account_id,
        metadata: { scopeType: existing.rows[0].scope_type, scopeEntityId: existing.rows[0].scope_entity_id },
      });
    });
  }
}
