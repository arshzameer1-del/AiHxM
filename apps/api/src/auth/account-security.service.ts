import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { generateSecret, generateURI, verify as verifyTotp } from "otplib";
import { createHash } from "crypto";
import type {
  AccountSecurityStatus,
  AccountSessionView,
  ChangePasswordResult,
  MfaReenrollConfirmResult,
  MfaReenrollStartResult,
  MfaRecoveryCodesResult,
} from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { generateRecoveryCodes, normalizeRecoveryCode } from "./mfa-recovery-codes.util";
import { decryptMfaSecret, encryptMfaSecret } from "./mfa-secret-crypto";
import { hashPassword, verifyPassword } from "./password";
import { SessionSecurityService } from "./session-security.service";

const SERVICE_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "account-security" };
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const stamp = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

/**
 * A wrong password or code is answered with 400, never 401: the web client treats any 401 as "your session ended" and signs the
 * person out, which a typo in a confirmation field must not do.
 *
 * BACKLOG51 - what a signed-in person can do about their OWN login: change the password, set up the authenticator on a new phone,
 * get fresh recovery codes, and see / sign out the places they are signed in. Every change asks for the current password (and the
 * current authenticator code where one exists), so a stolen open session cannot lock the real owner out.
 */
@Injectable()
export class AccountSecurityService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sessionSecurity: SessionSecurityService,
    private readonly audit: AuditService
  ) {}

  async status(claims: RequestClaims): Promise<AccountSecurityStatus> {
    const account = await this.account(claims);
    const codes = await this.db.withClaims(SERVICE_CLAIMS, (c) =>
      c.query("SELECT COUNT(*)::int AS n FROM mfa_recovery_codes WHERE user_account_id = $1 AND used_at IS NULL", [account.id])
    );
    return {
      authProvider: account.auth_provider,
      canChangePassword: account.auth_provider === "local",
      mfaEnabled: !!account.mfa_enabled,
      mfaRequired: account.mfa_required !== false,
      recoveryCodesRemaining: codes.rows[0].n,
      passwordChangedAt: stamp(account.password_changed_at),
    };
  }

  async changePassword(claims: RequestClaims, currentPassword: string, newPassword: string): Promise<ChangePasswordResult> {
    const account = await this.account(claims);
    this.requireLocal(account);
    if (!(await verifyPassword(currentPassword, account.password_hash))) throw new BadRequestException("Your current password is not correct");
    if (currentPassword === newPassword) throw new BadRequestException("Choose a new password that is different from the current one");
    const hash = await hashPassword(newPassword);
    await this.db.withClaims(SERVICE_CLAIMS, (c) =>
      c.query(
        "UPDATE user_accounts SET password_hash = $2, password_changed_at = now(), failed_login_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $1",
        [account.id, hash]
      )
    );
    const signedOut = await this.revokeOthers(claims, "password-changed");
    await this.record(claims, "account.password_changed", { signedOutOtherSessions: signedOut });
    return { message: "Your password was changed.", signedOutOtherSessions: signedOut };
  }

  // ---- authenticator ------------------------------------------------------------------------------------------------

  /** Starts setting up an authenticator (a new phone). The current one keeps working until the new one is confirmed. */
  async startReenroll(claims: RequestClaims, password: string, code?: string): Promise<MfaReenrollStartResult> {
    const account = await this.account(claims);
    this.requireLocal(account);
    await this.requireFactors(account, password, code);
    const secret = generateSecret();
    await this.db.withClaims(SERVICE_CLAIMS, (c) =>
      c.query("UPDATE user_accounts SET mfa_pending_secret_encrypted = $2, updated_at = now() WHERE id = $1", [account.id, encryptMfaSecret(secret)])
    );
    return { otpauthUrl: generateURI({ issuer: "AiHxM", label: account.email, secret }), secretForManualEntry: secret };
  }

  /** Confirms the new authenticator with a code it produced: it replaces the old one, fresh recovery codes are issued, other sessions end. */
  async confirmReenroll(claims: RequestClaims, code: string): Promise<MfaReenrollConfirmResult> {
    const account = await this.account(claims);
    this.requireLocal(account);
    if (!account.mfa_pending_secret_encrypted) throw new BadRequestException("Start setting up the new authenticator first");
    const result = await verifyTotp({ token: code, secret: decryptMfaSecret(account.mfa_pending_secret_encrypted) });
    if (!result.valid) throw new BadRequestException("That code is not right. Check the new authenticator and try again.");
    await this.db.withClaims(SERVICE_CLAIMS, (c) =>
      c.query(
        "UPDATE user_accounts SET mfa_secret_encrypted = mfa_pending_secret_encrypted, mfa_pending_secret_encrypted = NULL, mfa_enabled = true, updated_at = now() WHERE id = $1",
        [account.id]
      )
    );
    const recoveryCodes = await this.issueRecoveryCodes(account.id);
    const signedOut = await this.revokeOthers(claims, "mfa-changed");
    await this.record(claims, "account.mfa_reenrolled", { signedOutOtherSessions: signedOut });
    return { recoveryCodes, signedOutOtherSessions: signedOut };
  }

  async regenerateRecoveryCodes(claims: RequestClaims, password: string, code?: string): Promise<MfaRecoveryCodesResult> {
    const account = await this.account(claims);
    this.requireLocal(account);
    if (!account.mfa_enabled) throw new BadRequestException("Set up your authenticator first");
    await this.requireFactors(account, password, code);
    const recoveryCodes = await this.issueRecoveryCodes(account.id);
    await this.record(claims, "account.recovery_codes_regenerated", {});
    return { recoveryCodes };
  }

  // ---- where I am signed in -----------------------------------------------------------------------------------------

  async sessions(claims: RequestClaims): Promise<AccountSessionView[]> {
    const account = await this.account(claims);
    return this.db.withClaims(SERVICE_CLAIMS, async (c) => {
      const r = await c.query(
        `SELECT id, device_label, ip_address, user_agent, created_at, last_seen_at FROM user_sessions
          WHERE user_account_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC LIMIT 50`,
        [account.id]
      );
      return r.rows.map((s) => ({
        id: s.id,
        deviceLabel: s.device_label ?? null,
        ipAddress: s.ip_address ?? null,
        userAgent: s.user_agent ?? null,
        createdAt: stamp(s.created_at) as string,
        lastSeenAt: stamp(s.last_seen_at) as string,
        current: s.id === claims.sessionId,
      }));
    });
  }

  /** Signs one of MY OTHER sessions out. */
  async signOutSession(claims: RequestClaims, sessionId: string): Promise<void> {
    if (sessionId === claims.sessionId) throw new BadRequestException("This is the session you are using. Use Sign out instead.");
    const done = await this.db.withClaims(SERVICE_CLAIMS, (c) =>
      c.query("UPDATE user_sessions SET revoked_at = now(), revoked_by = 'self' WHERE id = $1 AND user_account_id = $2 AND revoked_at IS NULL RETURNING id", [sessionId, claims.sub])
    );
    if ((done.rowCount ?? 0) === 0) throw new NotFoundException("Session not found, or already signed out");
    await this.sessionSecurity.invalidateSessionCache(sessionId);
    await this.record(claims, "account.session_signed_out", { sessionId });
  }

  async signOutOtherSessions(claims: RequestClaims): Promise<{ signedOut: number }> {
    const signedOut = await this.revokeOthers(claims, "self");
    await this.record(claims, "account.other_sessions_signed_out", { signedOut });
    return { signedOut };
  }

  // ---- internals ----------------------------------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async account(claims: RequestClaims): Promise<any> {
    if (!claims.sub || !/^[0-9a-f-]{36}$/i.test(claims.sub)) throw new UnauthorizedException();
    const r = await this.db.withClaims(SERVICE_CLAIMS, (c) => c.query("SELECT * FROM user_accounts WHERE id = $1", [claims.sub]));
    if (r.rowCount === 0) throw new UnauthorizedException();
    return r.rows[0];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private requireLocal(account: any): void {
    if (account.auth_provider === "sso") {
      throw new BadRequestException("This account signs in through your organisation's single sign-on. Its password and authenticator are managed there.");
    }
  }

  /** The current password, and the current authenticator code when one is set up. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async requireFactors(account: any, password: string, code?: string): Promise<void> {
    if (!password || !(await verifyPassword(password, account.password_hash))) throw new BadRequestException("Your password is not correct");
    if (account.mfa_enabled) {
      if (!code) throw new BadRequestException("Enter the code from your current authenticator");
      const ok = account.mfa_secret_encrypted && (await verifyTotp({ token: code, secret: decryptMfaSecret(account.mfa_secret_encrypted) })).valid;
      if (!ok) throw new BadRequestException("The authenticator code is not right");
    }
  }

  /** Retires every unused code and stores a fresh batch. Plain codes are returned once and never kept. */
  private async issueRecoveryCodes(userAccountId: string): Promise<string[]> {
    const codes = generateRecoveryCodes();
    await this.db.withClaims(SERVICE_CLAIMS, async (c) => {
      await c.query("UPDATE mfa_recovery_codes SET used_at = now() WHERE user_account_id = $1 AND used_at IS NULL", [userAccountId]);
      for (const plain of codes) {
        await c.query("INSERT INTO mfa_recovery_codes (user_account_id, code_hash) VALUES ($1, $2)", [userAccountId, sha256(normalizeRecoveryCode(plain))]);
      }
    });
    return codes;
  }

  private async revokeOthers(claims: RequestClaims, revokedBy: string): Promise<number> {
    const r = await this.db.withClaims(SERVICE_CLAIMS, (c) =>
      c.query(
        "UPDATE user_sessions SET revoked_at = now(), revoked_by = $3 WHERE user_account_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid) RETURNING id",
        [claims.sub, claims.sessionId ?? null, revokedBy]
      )
    );
    for (const row of r.rows) await this.sessionSecurity.invalidateSessionCache(row.id);
    return r.rowCount ?? 0;
  }

  private async record(claims: RequestClaims, action: string, metadata: Record<string, unknown>): Promise<void> {
    await this.db.withClaims(SERVICE_CLAIMS, (c) =>
      this.audit.record(c, claims, { companyId: claims.company_id ?? null, action, target: claims.sub ?? null, metadata })
    );
  }
}
