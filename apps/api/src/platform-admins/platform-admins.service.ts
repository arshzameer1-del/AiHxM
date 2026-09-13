import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { hashPassword } from "../auth/password";
import type { CompanyAdminStatus, PlatformAdmin } from "@boostfactor/shared-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToPlatformAdmin(row: any): PlatformAdmin {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    status: row.status,
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
  };
}

/**
 * Platform Admins have no "profile without a login" intermediate state
 * the way a freshly-imported CompanyAdmin does (see CompaniesService's
 * addAdmin/createAdminLogin split) — there is no scenario where our own
 * ops team has a Platform Admin row worth keeping around that nobody can
 * sign in as. So creation here bundles both steps into one transaction:
 * INSERT user_accounts, INSERT platform_admins linking it, audit entry.
 */
@Injectable()
export class PlatformAdminsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService
  ) {}

  async list(claims: RequestClaims): Promise<PlatformAdmin[]> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query("SELECT * FROM platform_admins ORDER BY created_at ASC");
      return result.rows.map(rowToPlatformAdmin);
    });
  }

  async create(
    claims: RequestClaims,
    input: { fullName: string; email: string; initialPassword: string }
  ): Promise<PlatformAdmin> {
    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query("SELECT 1 FROM platform_admins WHERE email = $1", [
        input.email,
      ]);
      if ((existing.rowCount ?? 0) > 0) {
        throw new ConflictException(`${input.email} is already a Platform Admin`);
      }

      const passwordHash = await hashPassword(input.initialPassword);
      const account = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, $2) RETURNING id",
        [input.email, passwordHash]
      );

      const result = await client.query(
        `INSERT INTO platform_admins (full_name, email, user_account_id) VALUES ($1, $2, $3) RETURNING *`,
        [input.fullName, input.email, account.rows[0].id]
      );

      await this.audit.record(client, claims, {
        companyId: null,
        action: "platform_admin.created",
        target: input.email,
        metadata: {},
      });

      return rowToPlatformAdmin(result.rows[0]);
    });
  }

  async setStatus(
    claims: RequestClaims,
    adminId: string,
    status: CompanyAdminStatus
  ): Promise<PlatformAdmin> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "UPDATE platform_admins SET status = $2 WHERE id = $1 RETURNING *",
        [adminId, status]
      );
      if (result.rowCount === 0) {
        throw new NotFoundException("Platform Admin not found");
      }

      await this.audit.record(client, claims, {
        companyId: null,
        action: status === "locked" ? "platform_admin.locked" : "platform_admin.unlocked",
        target: result.rows[0].email,
        metadata: {},
      });

      return rowToPlatformAdmin(result.rows[0]);
    });
  }
}
