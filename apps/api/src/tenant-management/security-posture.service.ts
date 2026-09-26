import { Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { SessionSecurityService } from "../auth/session-security.service";
import type { RequestClaims } from "../database/tenant-context";
import type { SecurityPostureScore, SecurityPostureSignal, SecurityPostureSignalKey } from "@aihxm/shared-types";

/**
 * Phase 3 item #8 — "security posture scoring." Entirely computed from
 * data this platform already collects for other reasons (MFA enrollment,
 * the tenant's own SSO/IP-list/session-limit configuration, admin lockout
 * state) — no new table, nothing stored, recomputed fresh on every read.
 *
 * Six signals, weighted to sum to 100. This is a deliberately small,
 * concrete checklist — not a security "rating" or a cross-tenant
 * benchmark — chosen because each one is something a Platform Admin can
 * actually act on directly from this same Security tab (turn on SSO,
 * set an IP allowlist, cap concurrent sessions, unlock a stuck admin):
 *
 *   Admin MFA coverage (25 pts)         — proportional to the fraction of
 *     this tenant's Company Admins who have MFA enabled. The single
 *     highest-weighted signal: a compromised admin password with no
 *     second factor is this platform's single biggest account-takeover
 *     risk, by a wide margin over everything else scored here.
 *   SSO configured + enabled (15 pts)   — a tenant that federates identity
 *     to its own IdP inherits that IdP's own password/MFA/lockout policy
 *     for every login, on top of whatever this platform enforces itself.
 *   IP allow/denylist configured (15)   — network-level restriction is a
 *     real, if coarse, additional control most tenants don't bother with.
 *   Concurrent session limit set (15)   — an unlimited number of live
 *     sessions per user means a leaked token/cookie is never naturally
 *     capped; any explicit cap (>0) earns this.
 *   No unresolved admin lockouts (15)   — a `locked_until` in the future
 *     right now for any of this tenant's admins is either an active
 *     brute-force attempt in progress or a legitimate admin locked out of
 *     their own account — either way, an unresolved lockout at the moment
 *     this is read is worth surfacing and scoring down, not just something
 *     the Account Lockouts panel above happens to also show.
 *   Lockout policy not effectively disabled (15) — a tenant CAN override
 *     `max_login_attempts`/`lockout_duration_minutes` (Phase 2 gap-fill
 *     item #1) to values so permissive lockout barely applies (e.g. 999
 *     attempts, or a 1-minute lockout) — this checks the override hasn't
 *     been pushed that far, not merely that a value exists.
 *
 * Every weight/threshold above is a judgment call, not a standard —
 * documented plainly here so it can be revisited, the same way
 * SessionSecurityService's FALLBACK_SECURITY_POLICY is documented as "the
 * hardcoded fallbacks this codebase used before Phase 2," not as some
 * external requirement.
 */
@Injectable()
export class SecurityPostureService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sessionSecurity: SessionSecurityService
  ) {}

  async getScore(claims: RequestClaims, companyId: string): Promise<SecurityPostureScore> {
    const policy = await this.sessionSecurity.getEffectiveSecurityPolicy(companyId);

    return this.db.withClaims(claims, async (client) => {
      const companyCheck = await client.query("SELECT id FROM companies WHERE id = $1", [companyId]);
      if (companyCheck.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }

      const mfaRow = await client.query<{ total: string; with_mfa: string }>(
        `SELECT
           count(*) AS total,
           count(*) FILTER (WHERE ua.mfa_enabled) AS with_mfa
         FROM company_admins ca
         JOIN user_accounts ua ON ua.id = ca.user_account_id
         WHERE ca.company_id = $1`,
        [companyId]
      );
      const totalAdmins = Number(mfaRow.rows[0]?.total ?? 0);
      const adminsWithMfa = Number(mfaRow.rows[0]?.with_mfa ?? 0);

      const ssoRow = await client.query<{ enabled: boolean }>(
        "SELECT enabled FROM tenant_integrations WHERE company_id = $1 AND provider_key = 'sso'",
        [companyId]
      );
      const ssoEnabled = ssoRow.rows[0]?.enabled === true;

      const lockedAdminsRow = await client.query<{ count: string }>(
        `SELECT count(*) AS count
         FROM company_admins ca
         JOIN user_accounts ua ON ua.id = ca.user_account_id
         WHERE ca.company_id = $1 AND ua.locked_until IS NOT NULL AND ua.locked_until > now()`,
        [companyId]
      );
      const activeLockouts = Number(lockedAdminsRow.rows[0]?.count ?? 0);

      const signals: SecurityPostureSignal[] = [
        this.mfaCoverageSignal(totalAdmins, adminsWithMfa),
        this.ssoSignal(ssoEnabled),
        this.ipListSignal(policy.ipAllowlist, policy.ipDenylist),
        this.concurrentSessionSignal(policy.maxConcurrentSessions),
        this.noActiveLockoutsSignal(activeLockouts),
        this.lockoutPolicySignal(policy.maxLoginAttempts, policy.lockoutDurationMinutes),
      ];

      return {
        companyId,
        score: signals.reduce((sum, s) => sum + s.pointsEarned, 0),
        maxScore: signals.reduce((sum, s) => sum + s.pointsPossible, 0),
        signals,
        computedAt: new Date().toISOString(),
      };
    });
  }

  private signal(
    key: SecurityPostureSignalKey,
    label: string,
    pointsEarned: number,
    pointsPossible: number,
    detail: string
  ): SecurityPostureSignal {
    return { key, label, passed: pointsEarned >= pointsPossible, pointsEarned, pointsPossible, detail };
  }

  private mfaCoverageSignal(totalAdmins: number, adminsWithMfa: number): SecurityPostureSignal {
    const pointsPossible = 25;
    // No admins at all (shouldn't happen for a real tenant, but a
    // brand-new one mid-setup could have zero) — nothing to be behind on,
    // so this scores full marks rather than penalizing a tenant for a
    // setup step that hasn't happened yet.
    if (totalAdmins === 0) {
      return this.signal(
        "admin_mfa_coverage",
        "Admin MFA coverage",
        pointsPossible,
        pointsPossible,
        "No admin logins exist yet for this tenant."
      );
    }
    const fraction = adminsWithMfa / totalAdmins;
    const pointsEarned = Math.round(pointsPossible * fraction);
    return this.signal(
      "admin_mfa_coverage",
      "Admin MFA coverage",
      pointsEarned,
      pointsPossible,
      `${adminsWithMfa} of ${totalAdmins} admin login(s) have MFA enabled.`
    );
  }

  private ssoSignal(ssoEnabled: boolean): SecurityPostureSignal {
    const pointsPossible = 15;
    return this.signal(
      "sso_configured",
      "Single sign-on configured",
      ssoEnabled ? pointsPossible : 0,
      pointsPossible,
      ssoEnabled
        ? "SSO is configured and enabled for this tenant."
        : "SSO is not configured (or not enabled) for this tenant."
    );
  }

  private ipListSignal(ipAllowlist: string[], ipDenylist: string[]): SecurityPostureSignal {
    const pointsPossible = 15;
    const configured = ipAllowlist.length > 0 || ipDenylist.length > 0;
    return this.signal(
      "ip_allow_or_denylist",
      "IP allow/denylist configured",
      configured ? pointsPossible : 0,
      pointsPossible,
      configured
        ? `${ipAllowlist.length} allowlist / ${ipDenylist.length} denylist entr${
            ipAllowlist.length + ipDenylist.length === 1 ? "y" : "ies"
          } configured.`
        : "No IP allowlist or denylist is configured — any network can reach this tenant's portal."
    );
  }

  private concurrentSessionSignal(maxConcurrentSessions: number): SecurityPostureSignal {
    const pointsPossible = 15;
    const configured = maxConcurrentSessions > 0;
    return this.signal(
      "concurrent_session_limit",
      "Concurrent session limit set",
      configured ? pointsPossible : 0,
      pointsPossible,
      configured
        ? `Capped at ${maxConcurrentSessions} concurrent session(s) per user.`
        : "Unlimited concurrent sessions per user."
    );
  }

  private noActiveLockoutsSignal(activeLockouts: number): SecurityPostureSignal {
    const pointsPossible = 15;
    const passed = activeLockouts === 0;
    return this.signal(
      "no_active_admin_lockouts",
      "No unresolved admin lockouts",
      passed ? pointsPossible : 0,
      pointsPossible,
      passed
        ? "No admin login is currently locked out."
        : `${activeLockouts} admin login(s) are currently locked out.`
    );
  }

  private lockoutPolicySignal(maxLoginAttempts: number, lockoutDurationMinutes: number): SecurityPostureSignal {
    const pointsPossible = 15;
    // Thresholds chosen to match this tenant's own configured DEFAULTS
    // (5 attempts / 15 minutes — see SessionSecurityService's
    // FALLBACK_SECURITY_POLICY and migration 0055's seed values) with
    // meaningful headroom, so a tenant that hasn't touched this setting
    // always passes; only an override pushed far enough to effectively
    // disable lockout (e.g. 999 attempts, or a 1-minute lockout) fails.
    const passed = maxLoginAttempts <= 10 && lockoutDurationMinutes >= 5;
    return this.signal(
      "lockout_policy_not_permissive",
      "Account lockout policy is not overly permissive",
      passed ? pointsPossible : 0,
      pointsPossible,
      passed
        ? `Locks after ${maxLoginAttempts} failed attempt(s) for ${lockoutDurationMinutes} minute(s).`
        : `Configured lockout (${maxLoginAttempts} attempts / ${lockoutDurationMinutes} min) is too permissive to meaningfully deter brute-force attempts.`
    );
  }
}
