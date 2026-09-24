import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import type { UserRoleAssignment } from "@aihxm/shared-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToAssignment(row: any): UserRoleAssignment {
  return {
    id: row.id,
    userAccountId: row.user_account_id,
    companyId: row.company_id,
    roleId: row.role_id,
    roleKey: row.role_key,
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
  };
}

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
        `SELECT ura.*, r.key AS role_key
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
    input: { userAccountId: string; companyId: string; roleKey: string }
  ): Promise<UserRoleAssignment> {
    return this.db.withClaims(claims, async (client) => {
      const role = await client.query("SELECT id FROM roles WHERE key = $1", [input.roleKey]);
      if (role.rowCount === 0) {
        throw new NotFoundException(`No role with key "${input.roleKey}"`);
      }

      const existing = await client.query(
        "SELECT 1 FROM user_role_assignments WHERE user_account_id = $1 AND company_id = $2 AND role_id = $3",
        [input.userAccountId, input.companyId, role.rows[0].id]
      );
      if ((existing.rowCount ?? 0) > 0) {
        throw new ConflictException("This user already holds this role in this company");
      }

      const result = await client.query(
        `INSERT INTO user_role_assignments (user_account_id, company_id, role_id)
         VALUES ($1, $2, $3) RETURNING *`,
        [input.userAccountId, input.companyId, role.rows[0].id]
      );

      await this.audit.record(client, claims, {
        companyId: input.companyId,
        action: "rbac.role_assigned",
        target: input.userAccountId,
        metadata: { roleKey: input.roleKey },
      });

      return rowToAssignment({ ...result.rows[0], role_key: input.roleKey });
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
