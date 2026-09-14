import { Injectable, UnauthorizedException } from "@nestjs/common";
import * as jwt from "jsonwebtoken";
import { generateSecret, verify as verifyTotp, generateURI } from "otplib";
import { createHash, randomBytes } from "crypto";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import type { LoginResult, PasswordResetRequestResult } from "@boostfactor/shared-types";
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
  constructor(private readonly db: DatabaseService) {}

  // --- Login ------------------------------------------------------------

  async login(email: string, password: string): Promise<LoginResult> {
    const account = await this.findAccountByEmail(email);
    // Same generic message whether the email doesn't exist or the
    // password is wrong — the account lookup itself must never leak
    // which case it was.
    const invalidCredentials = () => new UnauthorizedException("Invalid email or password");

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
        otpauthUrl: generateURI({ issuer: "BoostFactor", label: email, secret }),
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
    return { status: "ok", token: this.issueSessionToken(identity, account.id) };
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
    return { status: "ok", token: this.issueSessionToken(identity, account.id) };
  }

  private verifyTicket(mfaTicket: string, purpose: "mfa_enroll" | "mfa_verify") {
    try {
      return verifyMfaTicket(mfaTicket, purpose);
    } catch (err) {
      throw new UnauthorizedException((err as Error).message);
    }
  }

  private issueSessionToken(identity: SessionIdentity, userAccountId: string): string {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("JWT_SECRET is not set");
    return jwt.sign(
      {
        sub: userAccountId,
        is_platform_admin: identity.is_platform_admin,
        company_id: identity.company_id,
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

    // Phase 6 (WRICEF Interfaces) wires real email/WhatsApp dispatch.
    // Until then, the only honest way to make this flow testable end to
    // end is to hand the token back directly — never in production.
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

  // --- Internal DB helpers (always via SERVICE_CLAIMS pre-auth) ----------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async findAccountByEmail(email: string): Promise<any | undefined> {
    return this.db.withClaims(SERVICE_CLAIMS, async (client) => {
      const result = await client.query("SELECT * FROM user_accounts WHERE email = $1", [email]);
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
