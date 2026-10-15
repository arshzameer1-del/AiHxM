import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import type { PoolClient } from "pg";
import type { AssignDataScopeRequest, DataScopeAssignmentScopeType, DataScopeAssignmentView } from "@aihxm/shared-types";

// Which table a `scope_entity_id` must exist in, keyed by `scope_type` —
// see 0078_data_scope_assignments.sql's own header comment on why this
// validation lives here (application layer) rather than as a same-column
// FK, which can only ever point at one table. A `switch` (rather than a
// lookup map feeding a template-interpolated table name into raw SQL)
// keeps every query string here a fixed literal, matching how every other
// service in this codebase writes its `mustExistX()` checks.
//
// Exported (Payroll Areas, 0101_payroll_areas.sql) so
// PayrollAreasService.addScopeLink() validates its own
// `payroll_area_scope_links` rows — the same polymorphic scope_type/
// scope_entity_id shape as this table — with exactly this check rather
// than a second copy of it.
export async function scopeEntityExists(
  client: PoolClient,
  scopeType: DataScopeAssignmentScopeType,
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
    case "payroll_area":
      result = await client.query("SELECT 1 FROM payroll_areas WHERE id = $1 AND company_id = $2", [scopeEntityId, companyId]);
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
    includeDescendants: row.include_descendants,
    effectiveFrom: day(row.effective_from),
    effectiveTo: day(row.effective_to),
    grantedBy: row.granted_by ?? null,
    reason: row.reason ?? null,
    roleId: row.role_id ?? null,
    objectKey: row.object_key ?? null,
    isActive: row.is_active_now ?? undefined,
  };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function day(v: any): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
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
        `SELECT *, ((effective_from IS NULL OR effective_from <= CURRENT_DATE) AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)) AS is_active_now
         FROM data_scope_assignments
         WHERE ($1::uuid IS NULL OR company_id = $1)
           AND ($2::uuid IS NULL OR user_account_id = $2)
         ORDER BY created_at ASC`,
        [companyId ?? null, userAccountId ?? null]
      );
      return result.rows.map(rowToAssignment);
    });
  }

  async assign(claims: RequestClaims, input: AssignDataScopeRequest): Promise<DataScopeAssignmentView> {
    if (input.effectiveFrom !== undefined && !DAY.test(input.effectiveFrom)) throw new BadRequestException("effectiveFrom must be YYYY-MM-DD");
    if (input.effectiveTo !== undefined && !DAY.test(input.effectiveTo)) throw new BadRequestException("effectiveTo must be YYYY-MM-DD");
    if (input.effectiveFrom && input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
      throw new BadRequestException("effectiveTo cannot be before effectiveFrom");
    }
    // cost centres and payroll areas are flat: "descendants" only means something for hierarchies
    const includeDescendants = input.includeDescendants ?? true;
    return this.db.withClaims(claims, async (client) => {
      const exists = await scopeEntityExists(client, input.scopeType, input.scopeEntityId, input.companyId);
      if (!exists) {
        throw new NotFoundException(`No ${input.scopeType.replace("_", " ")} with that id in this company`);
      }
      if (input.roleId) {
        const role = await client.query("SELECT company_id FROM roles WHERE id = $1", [input.roleId]);
        if (role.rowCount === 0 || (role.rows[0].company_id && role.rows[0].company_id !== input.companyId)) {
          throw new NotFoundException("No such role for this company");
        }
      }
      const grantedBy = UUID_RE.test(String(claims.sub)) ? String(claims.sub) : null;

      const existing = await client.query(
        `SELECT id,
                ((effective_from IS NULL OR effective_from <= CURRENT_DATE) AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)) AS active_now
           FROM data_scope_assignments
          WHERE user_account_id = $1 AND company_id = $2 AND scope_type = $3 AND scope_entity_id = $4`,
        [input.userAccountId, input.companyId, input.scopeType, input.scopeEntityId]
      );
      let row;
      if ((existing.rowCount ?? 0) > 0) {
        if (existing.rows[0].active_now) throw new ConflictException("This user already holds this exact data scope assignment");
        const u = await client.query(
          `UPDATE data_scope_assignments
              SET include_descendants = $2, effective_from = $3::date, effective_to = $4::date, granted_by = $5, reason = $6, role_id = $7, object_key = $8
            WHERE id = $1 RETURNING *`,
          [existing.rows[0].id, includeDescendants, input.effectiveFrom ?? null, input.effectiveTo ?? null, grantedBy, input.reason ?? null, input.roleId ?? null, input.objectKey ?? null]
        );
        row = u.rows[0];
      } else {
        const result = await client.query(
          `INSERT INTO data_scope_assignments
             (user_account_id, company_id, scope_type, scope_entity_id, include_descendants, effective_from, effective_to, granted_by, reason, role_id, object_key)
           VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9, $10, $11) RETURNING *`,
          [input.userAccountId, input.companyId, input.scopeType, input.scopeEntityId, includeDescendants, input.effectiveFrom ?? null, input.effectiveTo ?? null, grantedBy, input.reason ?? null, input.roleId ?? null, input.objectKey ?? null]
        );
        row = result.rows[0];
      }

      await this.audit.record(client, claims, {
        companyId: input.companyId,
        action: "rbac.data_scope_assigned",
        target: input.userAccountId,
        metadata: {
          scopeType: input.scopeType, scopeEntityId: input.scopeEntityId, includeDescendants,
          effectiveFrom: input.effectiveFrom ?? null, effectiveTo: input.effectiveTo ?? null, roleId: input.roleId ?? null, objectKey: input.objectKey ?? null,
        },
        reason: input.reason,
      });

      return rowToAssignment(row);
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
