import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import type { AssignRoleRequest, UserRoleAssignment } from "@aihxm/shared-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToAssignment(row: any): UserRoleAssignment {
  return {
    id: row.id,
    userAccountId: row.user_account_id,
    companyId: row.company_id,
    roleId: row.role_id,
    roleKey: row.role_key,
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
    effectiveFrom: day(row.effective_from),
    effectiveTo: day(row.effective_to),
    source: row.source,
    grantedBy: row.granted_by ?? null,
    reason: row.reason ?? null,
    isActive: row.is_active_now ?? undefined,
  };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function day(v: any): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCES = ["manual", "scim", "sso", "workflow", "delegation", "system"];

/**
 * Assigning/revoking roles is Platform-Admin-only for now (see
 * 0004_rbac.sql's header comment on user_role_assignments — a Company
 * Super Admin self-service version is a deferred, not-yet-needed
 * enhancement). This is deliberately thin: it exists so fixtures for the
 * RBAC engine's test suite, and any admin who needs to grant a role, go
 * through the real API rather than a raw SQL insert.
 */
@Injectable()
export class RoleAssignmentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService
  ) {}

  async list(claims: RequestClaims, companyId?: string): Promise<UserRoleAssignment[]> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT ura.*, r.key AS role_key,
                ((ura.effective_from IS NULL OR ura.effective_from <= CURRENT_DATE)
                 AND (ura.effective_to IS NULL OR ura.effective_to >= CURRENT_DATE)) AS is_active_now
         FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id
         WHERE ($1::uuid IS NULL OR ura.company_id = $1)
         ORDER BY ura.created_at ASC`,
        [companyId ?? null]
      );
      return result.rows.map(rowToAssignment);
    });
  }

  async assign(
    claims: RequestClaims,
    input: AssignRoleRequest
  ): Promise<UserRoleAssignment> {
    return this.db.withClaims(claims, async (client) => {
      if (input.effectiveFrom !== undefined && !DAY.test(input.effectiveFrom)) throw new BadRequestException("effectiveFrom must be YYYY-MM-DD");
      if (input.effectiveTo !== undefined && !DAY.test(input.effectiveTo)) throw new BadRequestException("effectiveTo must be YYYY-MM-DD");
      if (input.effectiveFrom && input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
        throw new BadRequestException("effectiveTo cannot be before effectiveFrom");
      }
      const source = input.source ?? "manual";
      if (!SOURCES.includes(source)) throw new BadRequestException(`source must be one of ${SOURCES.join(", ")}`);

      const role = await client.query("SELECT id, company_id, is_active FROM roles WHERE key = $1", [input.roleKey]);
      if (role.rowCount === 0) {
        throw new NotFoundException(`No role with key "${input.roleKey}"`);
      }
      if (!role.rows[0].is_active) throw new BadRequestException("This role is inactive and cannot be granted");
      if (role.rows[0].company_id && role.rows[0].company_id !== input.companyId) {
        throw new BadRequestException("This role belongs to a different company");
      }
      const grantedBy = UUID_RE.test(String(claims.sub)) ? String(claims.sub) : null;

      const existing = await client.query(
        `SELECT id,
                ((effective_from IS NULL OR effective_from <= CURRENT_DATE) AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)) AS active_now,
                (effective_to IS NOT NULL AND effective_to < CURRENT_DATE) AS lapsed
           FROM user_role_assignments WHERE user_account_id = $1 AND company_id = $2 AND role_id = $3`,
        [input.userAccountId, input.companyId, role.rows[0].id]
      );
      let row;
      if ((existing.rowCount ?? 0) > 0) {
        // a lapsed or not-yet-started grant can be renewed in place; a live one is a conflict
        if (existing.rows[0].active_now && !existing.rows[0].lapsed) {
          throw new ConflictException("This user already holds this role in this company");
        }
        const updated = await client.query(
          `UPDATE user_role_assignments
              SET effective_from = $2::date, effective_to = $3::date, source = $4, granted_by = $5, reason = $6
            WHERE id = $1 RETURNING *`,
          [existing.rows[0].id, input.effectiveFrom ?? null, input.effectiveTo ?? null, source, grantedBy, input.reason ?? null]
        );
        row = updated.rows[0];
      } else {
        const result = await client.query(
          `INSERT INTO user_role_assignments (user_account_id, company_id, role_id, effective_from, effective_to, source, granted_by, reason)
           VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8) RETURNING *`,
          [input.userAccountId, input.companyId, role.rows[0].id, input.effectiveFrom ?? null, input.effectiveTo ?? null, source, grantedBy, input.reason ?? null]
        );
        row = result.rows[0];
      }

      await this.audit.record(client, claims, {
        companyId: input.companyId,
        action: "rbac.role_assigned",
        target: input.userAccountId,
        metadata: { roleKey: input.roleKey, source, effectiveFrom: input.effectiveFrom ?? null, effectiveTo: input.effectiveTo ?? null, renewed: (existing.rowCount ?? 0) > 0 },
        reason: input.reason,
      });

      return rowToAssignment({ ...row, role_key: input.roleKey });
    });
  }

  async revoke(claims: RequestClaims, id: string): Promise<void> {
    await this.db.withClaims(claims, async (client) => {
      const existing = await client.query("SELECT * FROM user_role_assignments WHERE id = $1", [id]);
      if (existing.rowCount === 0) {
        throw new NotFoundException("Role assignment not found");
      }

      await client.query("DELETE FROM user_role_assignments WHERE id = $1", [id]);

      await this.audit.record(client, claims, {
        companyId: existing.rows[0].company_id,
        action: "rbac.role_revoked",
        target: existing.rows[0].user_account_id,
        metadata: { roleId: existing.rows[0].role_id },
      });
    });
  }
}
