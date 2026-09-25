import type { INestApplication } from "@nestjs/common";
import { createHash, randomUUID } from "crypto";
import { generate as generateTotp, generateSecret } from "otplib";
import request from "supertest";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { encryptMfaSecret } from "./mfa-secret-crypto";
import { normalizeRecoveryCode } from "./mfa-recovery-codes.util";

/**
 * Test-only support for exercising a `@RequireStepUp()` route end to end
 * (Phase 2 gap-fill item #2). Most *.e2e.spec.ts files in this codebase
 * mint a session by hand-signing a JWT directly (to avoid driving the
 * full password+MFA login flow just to get a token) — those fixture
 * accounts have no MFA enrolled and their tokens carry no `jti`, both of
 * which StepUpGuard now requires before letting a gated route through.
 * This gives such a fixture a real, minimal MFA enrollment and a real
 * step-up grant via the actual `POST /auth/step-up` route, without going
 * through AuthService's own login flow.
 */
const SERVICE_CLAIMS_FOR_TEST_SETUP: RequestClaims = {
  is_platform_admin: false,
  is_service: true,
  sub: "step-up-test-support",
};

/** Enables MFA on `userAccountId` with a freshly generated test secret (same `generateSecret()` AuthService itself uses at real enrollment time) and returns it, plaintext, for the caller to derive TOTP codes from. */
export async function enableMfaForTestAccount(db: DatabaseService, userAccountId: string): Promise<string> {
  const secret = generateSecret();
  await db.withClaims(SERVICE_CLAIMS_FOR_TEST_SETUP, (client) =>
    client.query("UPDATE user_accounts SET mfa_enabled = true, mfa_secret_encrypted = $2 WHERE id = $1", [
      userAccountId,
      encryptMfaSecret(secret),
    ])
  );
  return secret;
}

/**
 * Calls the real `POST /auth/step-up` route with a fresh TOTP code derived
 * from `secret`, recording a step-up grant for `token`'s session (its
 * `jti` — see `testSessionId()`). Throws loudly on failure so a broken
 * fixture surfaces here, not as a confusing 403 on whatever sensitive
 * route the caller tries next.
 */
export async function performStepUpForTest(app: INestApplication, token: string, secret: string): Promise<void> {
  const code = await generateTotp({ secret });
  const res = await request(app.getHttpServer())
    .post("/auth/step-up")
    .set("Authorization", `Bearer ${token}`)
    .send({ totpCode: code });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`step-up test helper failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

/** Plants a real, usable single-use recovery code for `userAccountId`, the same `mfa_recovery_codes` shape AuthService.verifyMfaRecoveryCode()/StepUpService both consume — for a test that wants to exercise the recovery-code path without driving a real enrollment flow. */
export async function insertRecoveryCodeForTest(
  db: DatabaseService,
  userAccountId: string,
  plaintextCode: string
): Promise<void> {
  const codeHash = createHash("sha256").update(normalizeRecoveryCode(plaintextCode)).digest("hex");
  await db.withClaims(SERVICE_CLAIMS_FOR_TEST_SETUP, (client) =>
    client.query("INSERT INTO mfa_recovery_codes (user_account_id, code_hash) VALUES ($1, $2)", [
      userAccountId,
      codeHash,
    ])
  );
}

/**
 * A random-but-valid session id for a hand-signed e2e token — the same
 * shape as a real session's `jti`/`user_sessions.id`, without needing a
 * real `user_sessions` row: StepUpGuard/SessionSecurityService's step-up
 * cache only needs the id to be a stable, unique string, and
 * `isRevoked()` already treats a `jti` with no matching row as
 * "not revoked" (see session.guard.ts), same as today.
 */
export function testSessionId(): string {
  return randomUUID();
}
