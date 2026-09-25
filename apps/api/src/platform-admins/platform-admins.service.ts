import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { SessionSecurityService } from "../auth/session-security.service";
import { normalizeEmail } from "../auth/email.util";
import { hashPassword } from "../auth/password";
import type { CompanyAdminStatus, PlatformAdmin, PlatformAdminAccessLevel } from "@aihxm/shared-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToPlatformAdmin(row: any, scopedCompanyIds: string[] = []): PlatformAdmin {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    status: row.status,
    accessLevel: row.access_level,
    scopedCompanyIds,
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
const ACCESS_LEVELS: PlatformAdminAccessLevel[] = ["full", "read_only", "scoped"];

@Injectable()
export class PlatformAdminsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly sessionSecurity: SessionSecurityService
  ) {}

  async list(claims: RequestClaims): Promise<PlatformAdmin[]> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query("SELECT * FROM platform_admins ORDER BY created_at ASC");
      const scopeRows = await client.query<{ platform_admin_id: string; company_id: string }>(
        "SELECT platform_admin_id, company_id FROM platform_admin_company_scope"
      );
      const scopeByAdmin = new Map<string, string[]>();
      for (const row of scopeRows.rows) {
        const list = scopeByAdmin.get(row.platform_admin_id) ?? [];
        list.push(row.company_id);
        scopeByAdmin.set(row.platform_admin_id, list);
      }
      return result.rows.map((row) => rowToPlatformAdmin(row, scopeByAdmin.get(row.id) ?? []));
    });
  }

  async create(
    claims: RequestClaims,
    input: {
      fullName: string;
      email: string;
      initialPassword: string;
      accessLevel?: PlatformAdminAccessLevel;
      scopedCompanyIds?: string[];
    }
  ): Promise<PlatformAdmin> {
    // Managing who else has Platform Admin access — and at what level — is
    // itself a 'full'-only privilege. Without this, PlatformAdminGuard's
    // per-route @ScopedCompanyParam check has nothing to key off here
    // (this controller has no company id in its path at all), so a
    // 'scoped' or (via some other future route) non-'full' admin could
    // otherwise grant themselves broader access — the one privilege-
    // escalation path this feature must close by construction, not by
    // convention. `platformAdminAccessLevel` is only ever absent for a
    // service-role caller (the bootstrap seed script), which this check
    // deliberately still allows through.
    this.requireFullAccess(claims);
    const accessLevel = input.accessLevel ?? "full";
    this.validateAccessLevel(accessLevel);
    const scopedCompanyIds = accessLevel === "scoped" ? (input.scopedCompanyIds ?? []) : [];

    return this.db.withClaims(claims, async (client) => {
      const email = normalizeEmail(input.email);
      const existing = await client.query("SELECT 1 FROM platform_admins WHERE email = $1", [
        email,
      ]);
      if ((existing.rowCount ?? 0) > 0) {
        throw new ConflictException(`${input.email} is already a Platform Admin`);
      }

      const passwordHash = await hashPassword(input.initialPassword);
      const account = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, $2) RETURNING id",
        [email, passwordHash]
      );

      const result = await client.query(
        `INSERT INTO platform_admins (full_name, email, user_account_id, access_level) VALUES ($1, $2, $3, $4) RETURNING *`,
        [input.fullName, email, account.rows[0].id, accessLevel]
      );
      const admin = result.rows[0];

      if (scopedCompanyIds.length > 0) {
        await this.replaceScope(client, admin.id, scopedCompanyIds);
      }

      await this.audit.record(client, claims, {
        companyId: null,
        action: "platform_admin.created",
        target: input.email,
        metadata: { accessLevel, scopedCompanyCount: scopedCompanyIds.length },
      });

      return rowToPlatformAdmin(admin, scopedCompanyIds);
    });
  }

  async setStatus(
    claims: RequestClaims,
    adminId: string,
    status: CompanyAdminStatus
  ): Promise<PlatformAdmin> {
    this.requireFullAccess(claims);
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

      return rowToPlatformAdmin(result.rows[0], await this.getScope(client, adminId));
    });
  }

  /**
   * Phase 2 gap-fill item #7 — changes an existing admin's delegation
   * level and (for 'scoped') the exact tenant list, in one call so the
   * two can never briefly disagree (e.g. 'scoped' with an empty list,
   * which would silently mean "access to nothing"). Cache invalidation is
   * keyed by `user_account_id`, not the platform_admins row id — that's
   * what PlatformAdminGuard actually looks up by on every request, so a
   * change here must take effect immediately, not up to 15s later.
   */
  async setAccess(
    claims: RequestClaims,
    adminId: string,
    accessLevel: PlatformAdminAccessLevel,
    scopedCompanyIds: string[] | undefined
  ): Promise<PlatformAdmin> {
    this.requireFullAccess(claims);
    this.validateAccessLevel(accessLevel);
    const nextScope = accessLevel === "scoped" ? (scopedCompanyIds ?? []) : [];

    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "UPDATE platform_admins SET access_level = $2 WHERE id = $1 RETURNING *",
        [adminId, accessLevel]
      );
      if (result.rowCount === 0) {
        throw new NotFoundException("Platform Admin not found");
      }
      const admin = result.rows[0];

      await this.replaceScope(client, adminId, nextScope);

      await this.audit.record(client, claims, {
        companyId: null,
        action: "platform_admin.access_level_changed",
        target: admin.email,
        metadata: { accessLevel, scopedCompanyCount: nextScope.length },
      });

      if (admin.user_account_id) {
        await this.sessionSecurity.invalidatePlatformAdminAccessCache(admin.user_account_id);
      }

      return rowToPlatformAdmin(admin, nextScope);
    });
  }

  private requireFullAccess(claims: RequestClaims): void {
    if (claims.platformAdminAccessLevel && claims.platformAdminAccessLevel !== "full") {
      throw new ForbiddenException("Managing Platform Admins requires full access.");
    }
  }

  private validateAccessLevel(accessLevel: string): asserts accessLevel is PlatformAdminAccessLevel {
    if (!ACCESS_LEVELS.includes(accessLevel as PlatformAdminAccessLevel)) {
      throw new BadRequestException(`Unknown access level "${accessLevel}"`);
    }
  }

  private async replaceScope(client: PoolClient, adminId: string, companyIds: string[]): Promise<void> {
    await client.query("DELETE FROM platform_admin_company_scope WHERE platform_admin_id = $1", [adminId]);
    if (companyIds.length === 0) return;
    const values = companyIds.map((_, i) => `($1, $${i + 2})`).join(", ");
    await client.query(
      `INSERT INTO platform_admin_company_scope (platform_admin_id, company_id) VALUES ${values}`,
      [adminId, ...companyIds]
    );
  }

  private async getScope(client: PoolClient, adminId: string): Promise<string[]> {
    const result = await client.query<{ company_id: string }>(
      "SELECT company_id FROM platform_admin_company_scope WHERE platform_admin_id = $1",
      [adminId]
    );
    return result.rows.map((r) => r.company_id);
  }
}
