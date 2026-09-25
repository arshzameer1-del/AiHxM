import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { verify as verifyTotp } from "otplib";
import { createHash } from "crypto";
import { DatabaseService } from "../database/database.service";
import { SessionSecurityService, STEP_UP_TTL_SECONDS } from "./session-security.service";
import type { RequestClaims } from "../database/tenant-context";
import type { StepUpVerifyRequest, StepUpVerifyResponse } from "@aihxm/shared-types";
import { decryptMfaSecret } from "./mfa-secret-crypto";
import { normalizeRecoveryCode } from "./mfa-recovery-codes.util";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Phase 2 gap-fill item #2 — step-up re-authentication. The
 * post-authentication counterpart to AuthService's own
 * verifyMfa()/verifyMfaRecoveryCode(): same two credentials (a fresh TOTP
 * code, or one of the account's still-unused recovery codes), but proving
 * "you still hold the second factor right now" for an ALREADY-logged-in
 * session immediately before a particularly sensitive action, rather than
 * proving identity to establish a new session. Deliberately kept out of
 * AuthService itself — that class's own doc comment scopes it to
 * pre-authentication identity flows (login, MFA, password reset); this is
 * squarely post-authentication.
 *
 * Runs entirely under the caller's OWN claims (never SERVICE_CLAIMS) —
 * `user_accounts_select`/`mfa_recovery_codes_update`'s RLS policies already
 * let a caller read/update their own row by `id = sub` (the same property
 * AuthService.me() already relies on), and a step-up can only ever
 * re-verify the CALLER's own second factor, never someone else's.
 */
@Injectable()
export class StepUpService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sessionSecurity: SessionSecurityService
  ) {}

  async verify(claims: RequestClaims, dto: StepUpVerifyRequest): Promise<StepUpVerifyResponse> {
    if (!claims.sessionId) {
      throw new UnauthorizedException(
        "This session predates step-up verification and can't be re-verified — please log in again."
      );
    }
    if (!dto.totpCode && !dto.recoveryCode) {
      throw new BadRequestException("A verification code or recovery code is required.");
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const account = await this.db.withClaims(claims, async (client) => {
      const result = await client.query("SELECT * FROM user_accounts WHERE id = $1", [claims.sub]);
      return result.rows[0];
    });
    if (!account?.mfa_enabled || !account.mfa_secret_encrypted) {
      // Shouldn't happen for a real session — MFA is mandatory for every
      // tier (see AuthService's own doc comment) — so this is a safe-deny,
      // not a real-world branch.
      throw new UnauthorizedException("MFA is not enabled for this account.");
    }

    if (dto.totpCode) {
      const secret = decryptMfaSecret(account.mfa_secret_encrypted);
      const result = await verifyTotp({ token: dto.totpCode, secret });
      if (!result.valid) {
        throw new UnauthorizedException("Invalid verification code");
      }
    } else {
      const codeHash = sha256(normalizeRecoveryCode(dto.recoveryCode as string));
      const consumed = await this.db.withClaims(claims, async (client) => {
        // Single-use, same atomic UPDATE-as-the-check shape as
        // AuthService.verifyMfaRecoveryCode().
        const result = await client.query(
          `UPDATE mfa_recovery_codes SET used_at = now()
           WHERE user_account_id = $1 AND code_hash = $2 AND used_at IS NULL
           RETURNING id`,
          [claims.sub, codeHash]
        );
        return (result.rowCount ?? 0) > 0;
      });
      if (!consumed) {
        throw new UnauthorizedException("Invalid or already-used recovery code");
      }
    }

    await this.sessionSecurity.recordStepUp(claims.sessionId);
    return { verifiedForSeconds: STEP_UP_TTL_SECONDS };
  }
}
