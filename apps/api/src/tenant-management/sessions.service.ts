import { Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import { SessionSecurityService } from "../auth/session-security.service";
import type { RequestClaims } from "../database/tenant-context";
import type { UserSessionView } from "@aihxm/shared-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToSession(row: any): UserSessionView {
  return {
    id: row.id,
    userAccountId: row.user_account_id,
    companyId: row.company_id,
    isPlatformAdmin: row.is_platform_admin,
    email: row.email ?? null,
    displayName: row.display_name ?? null,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    ipAddress: row.ip_address ?? null,
    isNewDevice: row.is_new_device ?? false,
    isRapidNetworkChange: row.is_rapid_network_change ?? false,
  };
}

/**
 * TM-017 (Tenant Users → Force Logout) and TM-029 (Tenant Security →
 * active sessions + Revoke). Both spec routes are implemented:
 * `POST /platform/users/:id/sessions/revoke` revokes every active session
 * for one user account ("force logout" — a user might be logged in on
 * several devices); `POST /platform/sessions/:id/revoke` revokes one
 * specific session (Security tab's per-row Revoke).
 *
 * Revocation only takes effect for tokens minted after this feature
 * shipped (they carry a `jti`) — see SessionSecurityService's doc comment.
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly sessionSecurity: SessionSecurityService
  ) {}

  async list(claims: RequestClaims, companyId?: string): Promise<UserSessionView[]> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT
           s.*,
           ua.email,
           COALESCE(pa.full_name, ca.full_name, e.first_name || ' ' || e.last_name) AS display_name
         FROM user_sessions s
         JOIN user_accounts ua ON ua.id = s.user_account_id
         LEFT JOIN platform_admins pa ON pa.user_account_id = s.user_account_id
         LEFT JOIN company_admins ca ON ca.user_account_id = s.user_account_id
         LEFT JOIN employees e ON e.user_account_id = s.user_account_id
         WHERE ($1::uuid IS NULL OR s.company_id = $1)
         ORDER BY s.created_at DESC
         LIMIT 200`,
        [companyId ?? null]
      );
      return result.rows.map(rowToSession);
    });
  }

  async revokeOne(claims: RequestClaims, sessionId: string): Promise<void> {
    await this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "UPDATE user_sessions SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING company_id",
        [sessionId, claims.sub]
      );
      if (result.rowCount === 0) {
        throw new NotFoundException("Session not found, or already revoked");
      }
      await this.audit.record(client, claims, {
        companyId: result.rows[0].company_id,
        action: "session.revoked",
        target: sessionId,
        metadata: {},
      });
    });
    await this.sessionSecurity.invalidateSessionCache(sessionId);
  }

  /** "Force Logout" — every currently-active session for one user account, not just one device. */
  async revokeAllForUser(claims: RequestClaims, userAccountId: string): Promise<number> {
    const sessionIds = await this.db.withClaims(claims, async (client) => {
      const result = await client.query<{ id: string; company_id: string | null }>(
        "UPDATE user_sessions SET revoked_at = now(), revoked_by = $2 WHERE user_account_id = $1 AND revoked_at IS NULL RETURNING id, company_id",
        [userAccountId, claims.sub]
      );
      if (result.rowCount && result.rowCount > 0) {
        await this.audit.record(client, claims, {
          companyId: result.rows[0].company_id,
          action: "session.force_logout",
          target: userAccountId,
          metadata: { revokedCount: result.rowCount },
        });
      }
      return result.rows.map((r) => r.id);
    });

    for (const id of sessionIds) {
      await this.sessionSecurity.invalidateSessionCache(id);
    }
    return sessionIds.length;
  }
}
