import { Injectable, UnauthorizedException } from "@nestjs/common";
import * as jwt from "jsonwebtoken";
import { generateSecret, verify as verifyTotp, generateURI } from "otplib";
import { createHash, randomBytes } from "crypto";
import { DatabaseService } from "../database/database.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { MailerService } from "../mailer/mailer.service";
import type { RequestClaims } from "../database/tenant-context";
import type { LoginResult, MeResponse, PasswordResetRequestResult, TenantRoleKey } from "@aihxm/shared-types";
import { normalizeEmail } from "./email.util";
import { decryptMfaSecret, encryptMfaSecret } from "./mfa-secret-crypto";
import { hashPassword, verifyPassword } from "./password";
import { signMfaTicket, verifyMfaTicket } from "./tickets";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const RESET_TOKEN_TTL_MINUTES = 30;

/** Never carries a real user's claims — see tenant-context.ts's doc comment on `is_service`. */
const SERVICE_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "auth-service" };

/**
 * What a successfully-authenticated `user_accounts` row actually IS, for
 * the purpose of the token this issues. Three tiers, checked in this
 * order — see `resolveIdentityForAccount()`:
 *   1. Platform Admin (`platform_admins`) — internal ops, no company_id.
 *   2. Company (Super) Admin (`company_admins`) — Phase 2's one-per-tenant
 *      bootstrap login, predates Phase 4's RBAC engine entirely.
 *   3. A real Phase 4+ RBAC user (`user_role_assignments`) — hr_admin /
 *      line_manager / employee_self_service. This tier didn't exist until
 *      now: every phase from 4 onward built and tested its RBAC engine
 *      against `user_role_assignments` rows created directly by fixture
 *      SQL, but nothing in the actual login flow ever looked at that
 *      table — a Company Admin's own login carried a `company_id` and
 *      NOTHING else, so `RbacService.hasPermission()` found zero rows for
 *      them against every Phase 4+ module. See Decision #12.
 * `adminStatus` is named for tiers 1/2's own admin-profile status column;
 * tier 3 has no separate profile row to hold one, so it's always
 * `"active"` there — `user_accounts.status` (checked once, before this
 * even runs) is what actually gates a locked tenant user.
 */
type SessionIdentity = {
  is_platform_admin: boolean;
  company_id: string | null;
  adminStatus: "active" | "locked";
};

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
    private readonly mailer: MailerService
  ) {}

  // --- Login ------------------------------------------------------------

  async login(email: string, password: string): Promise<LoginResult> {
    const account = await this.findAccountByEmail(email);
    return this.authenticate(account, password, {
      invalidCredentialsMessage: "Invalid email or password",
      otpLabel: email,
    });
  }

  /**
   * A tenant's own login page (aihxm.com/<slug>/login) authenticates by
   * a typed identifier, never email — see LoginWithEmployeeNumberRequest's
   * doc comment in shared-types for why `companySlug` has to come along
   * with it (both identifier namespaces below are only unique WITHIN a
   * company). Everything past "which user_accounts row is this" —
   * lockout, password check, mandatory MFA — is identical to email login,
   * so it shares `authenticate()` rather than re-implementing it.
   *
   * Despite the name (kept for API/DTO stability), this now matches EITHER
   * an Employee Core row's `employee_number` OR a Company (Super) Admin's
   * `company_admins.login_id` (migration 0048) — see
   * `findAccountByEmployeeNumber`'s doc comment. An admin with no
   * `login_id` set still signs in via the email-based `/auth/login` on
   * the shared login page instead.
   */
  async loginWithEmployeeNumber(
    companySlug: string,
    employeeNumber: string,
    password: string
  ): Promise<LoginResult> {
    const account = await this.findAccountByEmployeeNumber(companySlug, employeeNumber);
    return this.authenticate(account, password, {
      invalidCredentialsMessage: "Invalid login ID or password",
      otpLabel: `${employeeNumber} (${companySlug})`,
    });
  }

  private async authenticate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    account: any | undefined,
    password: string,
    opts: { invalidCredentialsMessage: string; otpLabel: string }
  ): Promise<LoginResult> {
    // Same generic message whether the identifier doesn't exist or the
    // password is wrong — the account lookup itself must never leak
    // which case it was.
    const invalidCredentials = () => new UnauthorizedException(opts.invalidCredentialsMessage);

    if (!account) throw invalidCredentials();

    if (account.status === "locked") {
      throw new UnauthorizedException("This account has been locked. Contact your Platform Admin.");
    }
    if (account.locked_until && new Date(account.locked_until) > new Date()) {
      throw new UnauthorizedException(
        "Too many failed attempts. Try again in a few minutes."
      );
    }

    const validPassword = await verifyPassword(password, account.password_hash);
    if (!validPassword) {
      await this.incrementFailedAttempts(account.id);
      throw invalidCredentials();
    }

    const identity = await this.resolveIdentityForAccount(account.id);
    if (identity.adminStatus === "locked") {
      throw new UnauthorizedException("This account has been locked. Contact your Platform Admin.");
    }

    await this.resetFailedAttempts(account.id);

    // MFA is mandatory for all three tiers (plan doc Phase 3 row,
    // extended by Decision #12 to cover tenant RBAC users too) — a
    // password-only session is never issued for any of them.
    if (!account.mfa_enabled) {
      const secret = generateSecret();
      await this.setPendingMfaSecret(account.id, encryptMfaSecret(secret));
      return {
        status: "mfa_setup_required",
        mfaTicket: signMfaTicket("mfa_enroll", account.id),
        otpauthUrl: generateURI({ issuer: "AIHXM", label: opts.otpLabel, secret }),
        secretForManualEntry: secret,
      };
    }

    return { status: "mfa_required", mfaTicket: signMfaTicket("mfa_verify", account.id) };
  }

  async confirmMfaEnrollment(mfaTicket: string, code: string): Promise<{ status: "ok"; token: string }> {
    const { userAccountId } = this.verifyTicket(mfaTicket, "mfa_enroll");
    const account = await this.findAccountById(userAccountId);
    if (!account?.mfa_secret_encrypted) {
      throw new UnauthorizedException("No enrollment in progress for this account");
    }

    const secret = decryptMfaSecret(account.mfa_secret_encrypted);
    const result = await verifyTotp({ token: code, secret });
    if (!result.valid) {
      throw new UnauthorizedException("Invalid verification code");
    }

    await this.enableMfa(account.id);
    const identity = await this.resolveIdentityForAccount(account.id);
    return { status: "ok", token: await this.issueSessionToken(identity, account.id) };
  }

  async verifyMfa(mfaTicket: string, code: string): Promise<{ status: "ok"; token: string }> {
    const { userAccountId } = this.verifyTicket(mfaTicket, "mfa_verify");
    const account = await this.findAccountById(userAccountId);
    if (!account?.mfa_enabled || !account.mfa_secret_encrypted) {
      throw new UnauthorizedException("MFA is not enabled for this account");
    }

    const secret = decryptMfaSecret(account.mfa_secret_encrypted);
    const result = await verifyTotp({ token: code, secret });
    if (!result.valid) {
      throw new UnauthorizedException("Invalid verification code");
    }

    const identity = await this.resolveIdentityForAccount(account.id);
    return { status: "ok", token: await this.issueSessionToken(identity, account.id) };
  }

  private verifyTicket(mfaTicket: string, purpose: "mfa_enroll" | "mfa_verify") {
    try {
      return verifyMfaTicket(mfaTicket, purpose);
    } catch (err) {
      throw new UnauthorizedException((err as Error).message);
    }
  }

  /**
   * Every real session token now carries a `jti` — the `user_sessions` row
   * this creates — so it can be individually force-revoked later (Tenant
   * Management's "Force Logout", TM-017/029; see SessionSecurityService).
   * Tokens issued before this feature shipped, and "Login As" impersonation
   * tokens (companies.service.ts's `impersonate()`, which intentionally
   * stays outside normal session tracking — it's already short-lived and
   * audited on issuance), have no `jti` and simply cannot be individually
   * revoked; they still expire on their own schedule.
   */
  private async issueSessionToken(identity: SessionIdentity, userAccountId: string): Promise<string> {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("JWT_SECRET is not set");

    const sessionId = await this.db.withClaims(SERVICE_CLAIMS, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO user_sessions (user_account_id, company_id, is_platform_admin, expires_at)
         VALUES ($1, $2, $3, now() + interval '12 hours')
         RETURNING id`,
        [userAccountId, identity.company_id, identity.is_platform_admin]
      );
      return result.rows[0].id;
    });

    return jwt.sign(
      {
        sub: userAccountId,
        is_platform_admin: identity.is_platform_admin,
        company_id: identity.company_id,
        jti: sessionId,
      },
      secret,
      { expiresIn: "12h" }
    );
  }

  // --- Password reset -----------------------------------------------------

  async requestPasswordReset(email: string): Promise<PasswordResetRequestResult> {
    const genericMessage = "If that email has an account, a password reset has been issued.";
    const account = await this.findAccountByEmail(email);
    if (!account) {
      // Deliberately identical response whether or not the email exists —
      // an attacker probing emails should learn nothing either way.
      return { message: genericMessage };
    }

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = sha256(rawToken);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

    await this.db.withClaims(SERVICE_CLAIMS, async (client) => {
      // A fresh reset supersedes any still-outstanding one — no earlier
      // link should stay valid once a newer one exists.
      await client.query(
        "UPDATE password_reset_tokens SET used_at = now() WHERE user_account_id = $1 AND used_at IS NULL",
        [account.id]
      );
      await client.query(
        "INSERT INTO password_reset_tokens (user_account_id, token_hash, expires_at) VALUES ($1, $2, $3)",
        [account.id, tokenHash, expiresAt.toISOString()]
      );
    });

    // 2026-09-18: real delivery, via the shared MailerService, closes what
    // was previously a genuinely broken production flow — with no SMTP
    // configured and NODE_ENV=production, `devModeToken` was always
    // undefined and nothing else ever delivered the token anywhere, so a
    // real tenant's password reset silently went nowhere. This
    // deliberately does NOT go through NotificationsService.dispatch():
    // that method requires a tenant `company_id` to scope its
    // `notification_log` row against (RLS-enforced), but this method runs
    // PRE-AUTH under `SERVICE_CLAIMS` for ANY account — including a
    // Platform Admin, who has no company at all — so it calls
    // `MailerService` directly, the same "AuthService stays scoped to
    // pre-authentication identity flows" boundary this class's own
    // comment above already draws around itself.
    //
    // When SMTP isn't configured (still the default for dev/test/CI, and
    // for any tenant that hasn't set it up), behavior is unchanged from
    // before this increment: hand the raw token back directly outside
    // production, exactly as already documented above, so the flow stays
    // testable end to end without a real mail server. Once SMTP IS
    // configured, the token now has a real, legitimate delivery path, so
    // it's no longer echoed in the API response even in non-production —
    // there's no reason to leak a real reset credential over HTTP once a
    // real inbox delivers it instead. A delivery failure is logged but
    // never surfaces to the caller: the response must stay identical
    // whether or not the account exists (the enumeration-safety property
    // this method already guarantees above), and a transient mail-provider
    // outage shouldn't turn into information about which branch failed.
    if (this.mailer.isConfigured()) {
      const resetLink = `${process.env.APP_BASE_URL ?? "http://localhost:5173"}/reset-password?token=${rawToken}`;
      try {
        await this.mailer.sendMail({
          to: email,
          subject: "Reset your AIHXM password",
          text: `We received a request to reset your AIHXM password.\n\nReset it here: ${resetLink}\n\nThis link expires in ${RESET_TOKEN_TTL_MINUTES} minutes. If you didn't request this, you can safely ignore this email — your password hasn't been changed.`,
        });
      } catch {
        // Already logged inside MailerService; swallow here so a
        // provider outage never changes this method's response shape.
      }
      return { message: genericMessage };
    }

    const devModeToken = process.env.NODE_ENV === "production" ? undefined : rawToken;
    return { message: genericMessage, devModeToken };
  }

  async confirmPasswordReset(token: string, newPassword: string): Promise<void> {
    const tokenHash = sha256(token);

    const record = await this.db.withClaims(SERVICE_CLAIMS, async (client) => {
      const result = await client.query(
        `SELECT id, user_account_id FROM password_reset_tokens
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
        [tokenHash]
      );
      return result.rows[0] as { id: string; user_account_id: string } | undefined;
    });

    if (!record) {
      throw new UnauthorizedException("Invalid or expired reset token");
    }

    const passwordHash = await hashPassword(newPassword);

    await this.db.withClaims(SERVICE_CLAIMS, async (client) => {
      // The old hash is simply overwritten — never read back, logged, or
      // returned from here or anywhere else in this flow.
      await client.query(
        `UPDATE user_accounts SET
           password_hash = $2,
           failed_login_attempts = 0,
           locked_until = NULL,
           updated_at = now()
         WHERE id = $1`,
        [record.user_account_id, passwordHash]
      );
      await client.query("UPDATE password_reset_tokens SET used_at = now() WHERE id = $1", [record.id]);
    });
  }

  // Creating a login for an existing platform_admins/company_admins row
  // lives beside that row's other CRUD (PlatformAdminsService,
  // CompaniesService) rather than here, so the INSERT into user_accounts,
  // the UPDATE linking it, and the audit_log entry all commit in the same
  // transaction as everywhere else admin state changes. AuthService stays
  // scoped to the pre-authentication identity flows: login, MFA, and
  // password reset. Both call `hashPassword` from ./password, the same
  // helper this service uses for its own password-reset flow.

  // --- Session identity ---------------------------------------------------

  /**
   * `GET /auth/me` (Decision #13) — the one piece of post-authentication
   * identity AuthService itself answers, because it's the direct
   * counterpart of `resolveIdentityForAccount()` above: that function
   * decides what a token IS at login time, this reads back what the
   * caller's ALREADY-issued token means, for the frontend's own routing.
   * Runs entirely under the caller's own (non-elevated) claims — nothing
   * here needs `is_service`, since every row read is something the caller
   * is already entitled to see about themselves under plain RLS (their
   * own `user_accounts`/`company_admins`/`employees` row by `id`/
   * `user_account_id = sub`, their own `user_role_assignments` rows, and
   * their own company's `companies`/`tenant_module_entitlement` rows —
   * all proven readable under plain claims already, by `RbacService`'s
   * `hasPermission()` and `companies_select`'s own RLS policy).
   */
  async me(claims: RequestClaims): Promise<MeResponse> {
    if (claims.is_platform_admin) {
      const admin = await this.db.withClaims(claims, async (client) => {
        const result = await client.query<{ full_name: string; email: string }>(
          "SELECT full_name, email FROM platform_admins WHERE user_account_id = $1",
          [claims.sub]
        );
        return result.rows[0];
      });
      return {
        isPlatformAdmin: true,
        companyId: null,
        companyName: null,
        companySlug: null,
        email: admin?.email ?? "",
        fullName: admin?.full_name ?? "",
        roleKeys: [],
        employeeId: null,
        enabledModules: [],
      };
    }

    if (!claims.company_id) {
      // Shouldn't happen for a real session token — every non-platform-
      // admin token AuthService issues carries the company_id its
      // identity tier resolved. Safe-deny rather than guess.
      throw new UnauthorizedException("Session has no company context");
    }
    const companyId = claims.company_id;

    return this.db.withClaims(claims, async (client) => {
      // Sequential, not Promise.all: every query here shares ONE pooled
      // client (this transaction), and pg deprecates/warns on issuing a
      // new query on a client that's still executing a prior one — unlike
      // RbacService's Promise.all usages elsewhere, which parallelize
      // across genuinely separate `withClaims()` connections, not queries
      // sharing a single client.
      const account = await client.query<{ email: string }>(
        "SELECT email FROM user_accounts WHERE id = $1",
        [claims.sub]
      );
      const company = await client.query<{ name: string; slug: string }>(
        "SELECT name, slug FROM companies WHERE id = $1",
        [companyId]
      );
      const employee = await client.query<{ id: string; first_name: string; last_name: string }>(
        "SELECT id, first_name, last_name FROM employees WHERE user_account_id = $1 AND company_id = $2",
        [claims.sub, companyId]
      );
      const roles = await client.query<{ key: TenantRoleKey }>(
        `SELECT r.key FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id
         WHERE ura.user_account_id = $1 AND ura.company_id = $2`,
        [claims.sub, companyId]
      );
      const enabledModules = await this.entitlements.getEnabledModuleKeys(client, companyId);

      const employeeRow = employee.rows[0];
      let fullName = employeeRow ? `${employeeRow.first_name} ${employeeRow.last_name}` : undefined;
      if (!fullName) {
        // Tier 2 (Company Super Admin) has no employees row — fall back
        // to company_admins.full_name, the only other place a display
        // name for this tier exists.
        const companyAdmin = await client.query<{ full_name: string }>(
          "SELECT full_name FROM company_admins WHERE user_account_id = $1",
          [claims.sub]
        );
        fullName = companyAdmin.rows[0]?.full_name;
      }

      return {
        isPlatformAdmin: false,
        companyId,
        companyName: company.rows[0]?.name ?? null,
        companySlug: company.rows[0]?.slug ?? null,
        email: account.rows[0]?.email ?? "",
        fullName: fullName ?? account.rows[0]?.email ?? "",
        roleKeys: roles.rows.map((r) => r.key),
        employeeId: employeeRow?.id ?? null,
        enabledModules,
      };
    });
  }

  // --- Internal DB helpers (always via SERVICE_CLAIMS pre-auth) ----------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async findAccountByEmail(email: string): Promise<any | undefined> {
    return this.db.withClaims(SERVICE_CLAIMS, async (client) => {
      const result = await client.query("SELECT * FROM user_accounts WHERE email = $1", [
        normalizeEmail(email),
      ]);
      return result.rows[0];
    });
  }

  /**
   * `employee_number` is only unique WITHIN a company (migration 0010's
   * `UNIQUE (company_id, employee_number)`), hence the join through
   * `companies` on `companySlug` rather than a bare lookup — this is what
   * makes the tenant path a real part of the login identity, not just
   * cosmetic. `upper(trim(...))` on both sides for the same reason
   * email.util.ts's normalizeEmail exists: a tenant's own configured
   * number-format prefix (EmployeeNumberFormat.prefix) is free text they
   * typed once, and a login attempt shouldn't fail over a case mismatch
   * between how it was configured and how someone types it.
   *
   * A Company (Super) Admin has no `employees` row at all — created via
   * CompaniesService.createAdminLogin, which can set `company_admins
   * .login_id` (migration 0048) as that admin's own equivalent identifier.
   * The SAME identifier field on `/:companySlug/login` (LoginPage.tsx —
   * still labelled "Employee ID" in the DTO/param names below for that
   * historical reason) has to accept either kind of value, so this tries
   * both tables for the given slug via UNION rather than picking one —
   * `employee_number` and `login_id` are independent namespaces (an admin
   * could theoretically be given both, on two different rows), so this
   * simply matches whichever one exists and is correct, exactly one
   * `user_accounts` row for the pair (slug, typed identifier).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async findAccountByEmployeeNumber(companySlug: string, employeeNumber: string): Promise<any | undefined> {
    return this.db.withClaims(SERVICE_CLAIMS, async (client) => {
      // Slugs are already stored lowercase (slugify() at creation time) —
      // trim/lowercase here only guards against how the frontend derives
      // it from the route param, not a second source of truth.
      const slug = companySlug.trim().toLowerCase();
      const result = await client.query(
        `SELECT ua.*
         FROM user_accounts ua
         JOIN employees e ON e.user_account_id = ua.id
         JOIN companies c ON c.id = e.company_id
         WHERE c.slug = $1 AND upper(trim(e.employee_number)) = upper(trim($2))
         UNION ALL
         SELECT ua.*
         FROM user_accounts ua
         JOIN company_admins ca ON ca.user_account_id = ua.id
         JOIN companies c ON c.id = ca.company_id
         WHERE c.slug = $1 AND ca.login_id IS NOT NULL AND upper(trim(ca.login_id)) = upper(trim($2))
         LIMIT 1`,
        [slug, employeeNumber]
      );
      return result.rows[0];
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async findAccountById(id: string): Promise<any | undefined> {
    return this.db.withClaims(SERVICE_CLAIMS, async (client) => {
      const result = await client.query("SELECT * FROM user_accounts WHERE id = $1", [id]);
      return result.rows[0];
    });
  }

  private async resolveIdentityForAccount(userAccountId: string): Promise<SessionIdentity> {
    return this.db.withClaims(SERVICE_CLAIMS, async (client) => {
      const platformAdmin = await client.query(
        "SELECT status FROM platform_admins WHERE user_account_id = $1",
        [userAccountId]
      );
      if ((platformAdmin.rowCount ?? 0) > 0) {
        return { is_platform_admin: true, company_id: null, adminStatus: platformAdmin.rows[0].status };
      }

      const companyAdmin = await client.query(
        "SELECT company_id, status FROM company_admins WHERE user_account_id = $1",
        [userAccountId]
      );
      if ((companyAdmin.rowCount ?? 0) > 0) {
        return {
          is_platform_admin: false,
          company_id: companyAdmin.rows[0].company_id,
          adminStatus: companyAdmin.rows[0].status,
        };
      }

      // Tier 3 (Decision #12): a real RBAC user provisioned via
      // `EmployeesService.createLogin()` — hr_admin / line_manager /
      // employee_self_service. `user_role_assignments.company_id` is the
      // authorization-bearing relationship (what `RbacService.can()`
      // actually checks), so it's what this token's `company_id` comes
      // from, not a join through `employees`. A user can only hold role
      // assignments in one company today (no multi-tenant employees), so
      // `LIMIT 1` is safe; nothing enforces that invariant at the DB level
      // yet — a documented gap, not an oversight (see KNOWN_ISSUES.md).
      const rbacUser = await client.query(
        "SELECT DISTINCT company_id FROM user_role_assignments WHERE user_account_id = $1 LIMIT 1",
        [userAccountId]
      );
      if ((rbacUser.rowCount ?? 0) > 0) {
        return { is_platform_admin: false, company_id: rbacUser.rows[0].company_id, adminStatus: "active" };
      }

      // Shouldn't happen outside of a bug — every user_accounts row is
      // created either with an admin-profile link (platform_admins /
      // company_admins) or a role assignment (EmployeesService.createLogin).
      throw new UnauthorizedException("This account is not linked to any admin profile or role");
    });
  }

  private async incrementFailedAttempts(userAccountId: string): Promise<void> {
    await this.db.withClaims(SERVICE_CLAIMS, async (client) => {
      await client.query(
        `UPDATE user_accounts SET
           failed_login_attempts = failed_login_attempts + 1,
           locked_until = CASE
             WHEN failed_login_attempts + 1 >= $2
               THEN now() + ($3 || ' minutes')::interval
             ELSE locked_until
           END,
           updated_at = now()
         WHERE id = $1`,
        [userAccountId, MAX_FAILED_ATTEMPTS, LOCKOUT_MINUTES]
      );
    });
  }

  private async resetFailedAttempts(userAccountId: string): Promise<void> {
    await this.db.withClaims(SERVICE_CLAIMS, async (client) => {
      await client.query(
        "UPDATE user_accounts SET failed_login_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $1",
        [userAccountId]
      );
    });
  }

  private async setPendingMfaSecret(userAccountId: string, encryptedSecret: string): Promise<void> {
    await this.db.withClaims(SERVICE_CLAIMS, async (client) => {
      await client.query(
        "UPDATE user_accounts SET mfa_secret_encrypted = $2, updated_at = now() WHERE id = $1",
        [userAccountId, encryptedSecret]
      );
    });
  }

  private async enableMfa(userAccountId: string): Promise<void> {
    await this.db.withClaims(SERVICE_CLAIMS, async (client) => {
      await client.query(
        "UPDATE user_accounts SET mfa_enabled = true, updated_at = now() WHERE id = $1",
        [userAccountId]
      );
    });
  }
}
