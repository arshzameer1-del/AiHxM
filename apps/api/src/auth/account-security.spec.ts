import { Pool } from "pg";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { generate as generateTotp, generateSecret } from "otplib";
import { CacheService } from "../cache/cache.service";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AccountSecurityService } from "./account-security.service";
import { encryptMfaSecret } from "./mfa-secret-crypto";
import { hashPassword, verifyPassword } from "./password";
import { SessionSecurityService } from "./session-security.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "account-security-spec" };
const PASSWORD = "Correct-Horse-1";

/** BACKLOG51 against real Postgres: change password, move the authenticator to a new phone, recovery codes, own sessions. */
describe("Account security (self-service)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let svc: AccountSecurityService;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let userId: string;
  let secret: string;
  let sessionA: string;
  let sessionB: string;
  let sessionC: string;
  const fx = <T>(fn: Parameters<DatabaseService["withClaims"]>[1]) => db.withClaims(FIXTURE, fn) as Promise<T>;
  const claimsFor = (sessionId: string): RequestClaims => ({ is_platform_admin: false, company_id: null, sub: userId, sessionId });

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    svc = new AccountSecurityService(db, new SessionSecurityService(db, new CacheService()), new AuditService());
    secret = generateSecret();
    await fx(async (c) => {
      const u = await c.query(
        "INSERT INTO user_accounts (email, password_hash, mfa_enabled, mfa_secret_encrypted) VALUES ($1, $2, true, $3) RETURNING id",
        [`sec-${stamp}@example.com`, await hashPassword(PASSWORD), encryptMfaSecret(secret)]
      );
      userId = u.rows[0].id;
      const mk = async (agent: string) =>
        (await c.query("INSERT INTO user_sessions (user_account_id, expires_at, user_agent) VALUES ($1, now() + interval '1 hour', $2) RETURNING id", [userId, agent])).rows[0].id as string;
      sessionA = await mk("Chrome on Windows");
      sessionB = await mk("Safari on iPhone");
      sessionC = await mk("Firefox on Linux");
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  const code = async () => generateTotp({ secret });

  it("shows the account status without leaking anything secret", async () => {
    const s = await svc.status(claimsFor(sessionA));
    expect(s).toMatchObject({ authProvider: "local", canChangePassword: true, mfaEnabled: true, mfaRequired: true, recoveryCodesRemaining: 0, passwordChangedAt: null });
    expect(JSON.stringify(s)).not.toMatch(/hash|secret/i);
  });

  it("lists my active sessions and marks the one I am using", async () => {
    const list = await svc.sessions(claimsFor(sessionA));
    expect(list.map((x) => x.id).sort()).toEqual([sessionA, sessionB, sessionC].sort());
    expect(list.find((x) => x.id === sessionA)!.current).toBe(true);
    expect(list.filter((x) => x.current)).toHaveLength(1);
  });

  it("changing the password needs the current one, rejects reuse, and signs the other sessions out", async () => {
    await expect(svc.changePassword(claimsFor(sessionA), "wrong-password-1", "Brand-New-Pass-9")).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.changePassword(claimsFor(sessionA), PASSWORD, PASSWORD)).rejects.toBeInstanceOf(BadRequestException);

    const done = await svc.changePassword(claimsFor(sessionA), PASSWORD, "Brand-New-Pass-9");
    expect(done.signedOutOtherSessions).toBe(2);
    const row = (await fx<{ rows: Array<{ password_hash: string; password_changed_at: Date | null }> }>((c) => c.query("SELECT password_hash, password_changed_at FROM user_accounts WHERE id = $1", [userId]))).rows[0];
    expect(await verifyPassword("Brand-New-Pass-9", row.password_hash)).toBe(true);
    expect(await verifyPassword(PASSWORD, row.password_hash)).toBe(false);
    expect(row.password_changed_at).not.toBeNull();
    const alive = await svc.sessions(claimsFor(sessionA));
    expect(alive.map((x) => x.id)).toEqual([sessionA]);
    const audit = await fx<{ rows: unknown[] }>((c) => c.query("SELECT 1 FROM audit_log WHERE action = 'account.password_changed' AND target = $1", [userId]));
    expect(audit.rows).toHaveLength(1);
  });

  it("an SSO account has no password to change here", async () => {
    const sso = await fx<{ rows: Array<{ id: string }> }>((c) =>
      c.query("INSERT INTO user_accounts (email, password_hash, auth_provider) VALUES ($1, 'x', 'sso') RETURNING id", [`sso-${stamp}@example.com`])
    );
    const claims: RequestClaims = { is_platform_admin: false, company_id: null, sub: sso.rows[0].id };
    expect((await svc.status(claims)).canChangePassword).toBe(false);
    await expect(svc.changePassword(claims, "x", "Brand-New-Pass-9")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("moving the authenticator: needs password + current code, old one works until the new one is confirmed", async () => {
    const claims = claimsFor(sessionA);
    await expect(svc.startReenroll(claims, "Brand-New-Pass-9")).rejects.toBeInstanceOf(BadRequestException); // no code
    await expect(svc.startReenroll(claims, "nope-nope-nope", await code())).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.startReenroll(claims, "Brand-New-Pass-9", "000000")).rejects.toBeInstanceOf(BadRequestException);

    await expect(svc.confirmReenroll(claims, "123456")).rejects.toBeInstanceOf(BadRequestException); // nothing started

    const started = await svc.startReenroll(claims, "Brand-New-Pass-9", await code());
    expect(started.otpauthUrl).toContain("otpauth://totp/");
    const newSecret = started.secretForManualEntry;
    expect(newSecret).not.toBe(secret);

    // the old authenticator is still the live one; the new one is only pending
    const stillOld = (await fx<{ rows: Array<{ mfa_secret_encrypted: string; mfa_pending_secret_encrypted: string }> }>((c) => c.query("SELECT mfa_secret_encrypted, mfa_pending_secret_encrypted FROM user_accounts WHERE id = $1", [userId]))).rows[0];
    expect(stillOld.mfa_pending_secret_encrypted).toBeTruthy();
    expect(stillOld.mfa_pending_secret_encrypted).not.toBe(stillOld.mfa_secret_encrypted);

    // a code from the OLD phone does not confirm the new one
    await expect(svc.confirmReenroll(claims, "000000")).rejects.toBeInstanceOf(BadRequestException);

    const confirmed = await svc.confirmReenroll(claims, await generateTotp({ secret: newSecret }));
    expect(confirmed.recoveryCodes).toHaveLength(10);
    secret = newSecret; // from now on the new phone is the only one
    const after = (await fx<{ rows: Array<{ mfa_pending_secret_encrypted: string | null }> }>((c) => c.query("SELECT mfa_pending_secret_encrypted FROM user_accounts WHERE id = $1", [userId]))).rows[0];
    expect(after.mfa_pending_secret_encrypted).toBeNull();
    expect((await svc.status(claims)).recoveryCodesRemaining).toBe(10);
  });

  it("new recovery codes retire every old one and are stored hashed", async () => {
    const claims = claimsFor(sessionA);
    const fresh = await svc.regenerateRecoveryCodes(claims, "Brand-New-Pass-9", await code());
    expect(fresh.recoveryCodes).toHaveLength(10);
    expect((await svc.status(claims)).recoveryCodesRemaining).toBe(10);
    const stored = await fx<{ rows: Array<{ code_hash: string; used_at: Date | null }> }>((c) => c.query("SELECT code_hash, used_at FROM mfa_recovery_codes WHERE user_account_id = $1", [userId]));
    expect(stored.rows).toHaveLength(20); // 10 retired + 10 live
    expect(stored.rows.filter((r) => r.used_at === null)).toHaveLength(10);
    expect(stored.rows.some((r) => fresh.recoveryCodes.some((p) => r.code_hash.includes(p)))).toBe(false);
    await expect(svc.regenerateRecoveryCodes(claims, "Brand-New-Pass-9")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("I can sign out another of my sessions, never someone else's, and not the one I am using", async () => {
    const claims = claimsFor(sessionA);
    const extra = await fx<{ rows: Array<{ id: string }> }>((c) => c.query("INSERT INTO user_sessions (user_account_id, expires_at) VALUES ($1, now() + interval '1 hour') RETURNING id", [userId]));
    const stranger = await fx<{ rows: Array<{ id: string }> }>(async (c) => {
      const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`stranger-${stamp}@example.com`]);
      return c.query("INSERT INTO user_sessions (user_account_id, expires_at) VALUES ($1, now() + interval '1 hour') RETURNING id", [u.rows[0].id]);
    });
    await expect(svc.signOutSession(claims, sessionA)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.signOutSession(claims, stranger.rows[0].id)).rejects.toBeInstanceOf(NotFoundException);
    await svc.signOutSession(claims, extra.rows[0].id);
    await expect(svc.signOutSession(claims, extra.rows[0].id)).rejects.toBeInstanceOf(NotFoundException);

    const another = await fx<{ rows: Array<{ id: string }> }>((c) => c.query("INSERT INTO user_sessions (user_account_id, expires_at) VALUES ($1, now() + interval '1 hour') RETURNING id", [userId]));
    expect(another.rows).toHaveLength(1);
    expect((await svc.signOutOtherSessions(claims)).signedOut).toBe(1);
    expect((await svc.sessions(claims)).map((s) => s.id)).toEqual([sessionA]);
  });
});
