import { Test } from "@nestjs/testing";
import { UnauthorizedException } from "@nestjs/common";
import { generate as generateTotp } from "otplib";
import * as bcrypt from "bcryptjs";
import { Pool } from "pg";
import { AuthService } from "./auth.service";
import type { SessionRequestContext } from "./auth.service";
import { SessionSecurityService } from "./session-security.service";
import { CacheService } from "../cache/cache.service";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { MailerService } from "../mailer/mailer.service";
import { TestSmtpCatcher } from "../mailer/test-smtp-catcher";
import { PG_POOL } from "../database/pg-pool.token";
import type { RequestClaims } from "../database/tenant-context";

/**
 * Service-level tests against the REAL AuthService, exercising its actual
 * two-step login flow (password, then mandatory TOTP MFA) rather than a
 * single login() call that hands back a session token directly. See
 * auth.e2e.spec.ts for the HTTP-level counterpart of this same flow.
 */
const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "auth-service-spec-fixtures",
};

describe("AuthService", () => {
  let service: AuthService;
  let pool: Pool;
  let db: DatabaseService;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
  });

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        DatabaseService,
        EntitlementsService,
        MailerService,
        SessionSecurityService,
        CacheService,
        AuditService,
        {
          provide: PG_POOL,
          useValue: pool,
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Inserts a `user_accounts` row directly, bypassing the login flow entirely. */
  async function createUserAccount(overrides?: {
    email?: string;
    password?: string;
    mfaEnabled?: boolean;
  }): Promise<{ id: string; email: string; password: string }> {
    const email = overrides?.email ?? `auth-svc-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const password = overrides?.password ?? "SecurePassword123!";
    const passwordHash = await bcrypt.hash(password, 10);

    const id = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        "INSERT INTO user_accounts (email, password_hash, mfa_enabled) VALUES ($1, $2, $3) RETURNING id",
        [email, passwordHash, overrides?.mfaEnabled ?? false]
      );
      return result.rows[0].id as string;
    });

    return { id, email, password };
  }

  /** Grants an account tenant identity via a role assignment, the same tier `resolveIdentityForAccount` checks last (Tier 3). */
  async function grantRoleAssignment(userAccountId: string): Promise<{ companyId: string; roleId: string }> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const companyResult = await client.query(
        "INSERT INTO companies (name, slug, status, package_tier) VALUES ($1, $2, 'active', 'starter') RETURNING id",
        [`Auth Spec Co ${Date.now()}`, `auth-spec-co-${Date.now()}-${Math.random().toString(36).slice(2)}`]
      );
      const companyId = companyResult.rows[0].id as string;

      const roleResult = await client.query(
        "SELECT id FROM roles WHERE key = 'hr_admin' LIMIT 1"
      );
      const roleId = roleResult.rows[0].id as string;

      await client.query(
        "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
        [userAccountId, companyId, roleId]
      );

      return { companyId, roleId };
    });
  }

  /** Drives an account all the way from a fresh login() to a real session token, completing MFA enrollment along the way. */
  async function loginToSessionToken(
    email: string,
    password: string,
    requestContext?: SessionRequestContext
  ): Promise<string> {
    const first = await service.login(email, password);
    if (first.status !== "mfa_setup_required") {
      throw new Error(`Expected mfa_setup_required, got ${first.status}`);
    }
    const code = await generateTotp({ secret: first.secretForManualEntry });
    const confirmed = await service.confirmMfaEnrollment(first.mfaTicket, code, requestContext);
    return confirmed.token;
  }

  /** A second (already-MFA-enabled) login for an account, driven all the way to a fresh session token. */
  async function reLoginToSessionToken(
    email: string,
    password: string,
    totpSecret: string,
    requestContext?: SessionRequestContext
  ): Promise<string> {
    const login = await service.login(email, password);
    if (login.status !== "mfa_required") {
      throw new Error(`Expected mfa_required, got ${login.status}`);
    }
    const code = await generateTotp({ secret: totpSecret });
    const verified = await service.verifyMfa(login.mfaTicket, code, requestContext);
    return verified.token;
  }

  describe("login", () => {
    it("rejects an unknown email with a generic message", async () => {
      await expect(service.login("nonexistent@example.com", "whatever")).rejects.toThrow(
        UnauthorizedException
      );
      await expect(service.login("nonexistent@example.com", "whatever")).rejects.toThrow(
        "Invalid email or password"
      );
    });

    it("rejects the wrong password with the same generic message", async () => {
      const { email } = await createUserAccount();

      await expect(service.login(email, "WrongPassword123!")).rejects.toThrow(
        "Invalid email or password"
      );
    });

    it("returns mfa_setup_required with an enrollable secret on first login when MFA has never been enrolled", async () => {
      const { email, password } = await createUserAccount();
      await grantRoleAssignment((await db.withClaims(FIXTURE_CLAIMS, (c) => c.query("SELECT id FROM user_accounts WHERE email = $1", [email]))).rows[0].id);

      const result = await service.login(email, password);

      expect(result.status).toBe("mfa_setup_required");
      if (result.status !== "mfa_setup_required") throw new Error("unreachable");
      expect(result.mfaTicket).toEqual(expect.any(String));
      expect(result.secretForManualEntry).toEqual(expect.any(String));
      expect(result.otpauthUrl).toContain("otpauth://");
    });

    it("returns mfa_required (not a session token) once MFA is already enabled", async () => {
      const { id, email, password } = await createUserAccount();
      await grantRoleAssignment(id);

      // First login enrolls MFA.
      const first = await service.login(email, password);
      if (first.status !== "mfa_setup_required") throw new Error("expected mfa_setup_required");
      const code = await generateTotp({ secret: first.secretForManualEntry });
      await service.confirmMfaEnrollment(first.mfaTicket, code);

      // Second login: MFA is now enabled, so it must stop at mfa_required.
      const second = await service.login(email, password);
      expect(second.status).toBe("mfa_required");
      if (second.status !== "mfa_required") throw new Error("unreachable");
      expect(second.mfaTicket).toEqual(expect.any(String));
      expect((second as Record<string, unknown>).token).toBeUndefined();
    });

    it("locks out the account after repeated failed attempts", async () => {
      const { email, password } = await createUserAccount();

      for (let i = 0; i < 5; i++) {
        await expect(service.login(email, "WrongPassword123!")).rejects.toThrow(
          UnauthorizedException
        );
      }

      await expect(service.login(email, password)).rejects.toThrow(
        "Too many failed attempts"
      );
    });

    // Tenant Management gap-fill Phase 1 item #8 — the one signal that
    // turns a "pending"/"expired" admin login into "active" on the Admins
    // tab. Stamped by issueSessionToken(), reached via confirmMfaEnrollment
    // on this account's very first completed login.
    it("stamps last_login_at once a real session is issued", async () => {
      const { id, email, password } = await createUserAccount();
      await grantRoleAssignment(id);

      const before = await db.withClaims(FIXTURE_CLAIMS, (c) =>
        c.query("SELECT last_login_at FROM user_accounts WHERE id = $1", [id])
      );
      expect(before.rows[0].last_login_at).toBeNull();

      await loginToSessionToken(email, password);

      const after = await db.withClaims(FIXTURE_CLAIMS, (c) =>
        c.query("SELECT last_login_at FROM user_accounts WHERE id = $1", [id])
      );
      expect(after.rows[0].last_login_at).not.toBeNull();
    });
  });

  /** A company + an Employee Core row with a known employee_number, linked to a fresh user_accounts login. */
  async function createEmployeeLogin(overrides?: {
    employeeNumber?: string;
    password?: string;
  }): Promise<{ companySlug: string; employeeNumber: string; password: string }> {
    const { id: userAccountId, password } = await createUserAccount({ password: overrides?.password });
    const employeeNumber = overrides?.employeeNumber ?? `EMP-${Math.floor(Math.random() * 100000)}`;

    const companySlug = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const slug = `auth-emp-spec-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const companyResult = await client.query(
        "INSERT INTO companies (name, slug, status, package_tier) VALUES ($1, $2, 'active', 'starter') RETURNING id",
        [`Auth Employee Spec Co ${Date.now()}`, slug]
      );
      const companyId = companyResult.rows[0].id as string;
      await client.query(
        `INSERT INTO employees (company_id, employee_number, first_name, last_name, user_account_id)
         VALUES ($1, $2, 'Test', 'Employee', $3)`,
        [companyId, employeeNumber, userAccountId]
      );
      // resolveIdentityForAccount's Tier 3 (see its own doc comment) needs
      // a real role assignment, same as EmployeesService.createLogin
      // grants for a real employee login — without one, AuthService
      // itself throws "not linked to any admin profile or role" before
      // ever reaching MFA, regardless of which lookup found the account.
      const roleResult = await client.query("SELECT id FROM roles WHERE key = 'employee_self_service' LIMIT 1");
      await client.query(
        "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
        [userAccountId, companyId, roleResult.rows[0].id]
      );
      return slug;
    });

    return { companySlug, employeeNumber, password };
  }

  describe("loginWithEmployeeNumber", () => {
    it("authenticates a real employee by employee number scoped to their own company", async () => {
      const { companySlug, employeeNumber, password } = await createEmployeeLogin();

      const result = await service.loginWithEmployeeNumber(companySlug, employeeNumber, password);

      expect(result.status).toBe("mfa_setup_required");
    });

    it("matches the employee number case-insensitively", async () => {
      const { companySlug, employeeNumber, password } = await createEmployeeLogin({
        employeeNumber: "EMP-0042",
      });

      const result = await service.loginWithEmployeeNumber(companySlug, "emp-0042", password);

      expect(result.status).toBe("mfa_setup_required");
    });

    it("rejects the right employee number under the WRONG company with a generic message", async () => {
      const { employeeNumber, password } = await createEmployeeLogin();
      const otherSlug = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const slug = `auth-emp-spec-other-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await client.query(
          "INSERT INTO companies (name, slug, status, package_tier) VALUES ($1, $2, 'active', 'starter')",
          [`Auth Employee Spec Other Co ${Date.now()}`, slug]
        );
        return slug;
      });

      await expect(
        service.loginWithEmployeeNumber(otherSlug, employeeNumber, password)
      ).rejects.toThrow("Invalid login ID or password");
    });

    it("rejects an unknown employee number with a generic message distinct from the email path's", async () => {
      const { companySlug } = await createEmployeeLogin();

      await expect(
        service.loginWithEmployeeNumber(companySlug, "EMP-DOES-NOT-EXIST", "whatever")
      ).rejects.toThrow("Invalid login ID or password");
    });

    /**
     * A Company (Super) Admin has no `employees` row at all — this is the
     * OTHER identifier namespace `findAccountByEmployeeNumber` matches
     * (migration 0048's `company_admins.login_id`), proving the same
     * tenant-path field genuinely works for both kinds of account, not
     * just employees.
     */
    it("also authenticates a Company Admin by their own login_id, scoped to their company", async () => {
      const { id: userAccountId, password } = await createUserAccount();
      const loginId = `LHM_Admin_${Math.floor(Math.random() * 100000)}`;
      const companySlug = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const slug = `auth-admin-loginid-spec-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const companyResult = await client.query(
          "INSERT INTO companies (name, slug, status, package_tier) VALUES ($1, $2, 'active', 'starter') RETURNING id",
          [`Auth Admin LoginId Spec Co ${Date.now()}`, slug]
        );
        await client.query(
          `INSERT INTO company_admins (company_id, full_name, email, user_account_id, login_id)
           VALUES ($1, 'Login Id Admin', $2, $3, $4)`,
          [companyResult.rows[0].id, `admin-loginid-${Date.now()}@example.com`, userAccountId, loginId]
        );
        return slug;
      });

      const result = await service.loginWithEmployeeNumber(companySlug, loginId, password);

      expect(result.status).toBe("mfa_setup_required");
    });

    it("does not let an admin's login_id from one company authenticate under a different company's slug", async () => {
      const { id: userAccountId, password } = await createUserAccount();
      const loginId = `Scoped_Admin_${Math.floor(Math.random() * 100000)}`;
      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const slug = `auth-admin-loginid-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const companyResult = await client.query(
          "INSERT INTO companies (name, slug, status, package_tier) VALUES ($1, $2, 'active', 'starter') RETURNING id",
          [`Auth Admin LoginId Scope Co ${Date.now()}`, slug]
        );
        await client.query(
          `INSERT INTO company_admins (company_id, full_name, email, user_account_id, login_id)
           VALUES ($1, 'Scoped Admin', $2, $3, $4)`,
          [companyResult.rows[0].id, `admin-loginid-scope-${Date.now()}@example.com`, userAccountId, loginId]
        );
      });
      const otherSlug = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const slug = `auth-admin-loginid-other-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await client.query(
          "INSERT INTO companies (name, slug, status, package_tier) VALUES ($1, $2, 'active', 'starter')",
          [`Auth Admin LoginId Other Co ${Date.now()}`, slug]
        );
        return slug;
      });

      await expect(
        service.loginWithEmployeeNumber(otherSlug, loginId, password)
      ).rejects.toThrow("Invalid login ID or password");
    });
  });

  describe("confirmMfaEnrollment", () => {
    it("issues a real session token for a valid enrollment code", async () => {
      const { id, email, password } = await createUserAccount();
      await grantRoleAssignment(id);

      const login = await service.login(email, password);
      if (login.status !== "mfa_setup_required") throw new Error("expected mfa_setup_required");

      const code = await generateTotp({ secret: login.secretForManualEntry });
      const confirmed = await service.confirmMfaEnrollment(login.mfaTicket, code);

      expect(confirmed.status).toBe("ok");
      expect(confirmed.token).toEqual(expect.any(String));
      // Ten single-use recovery codes, issued exactly once, right here.
      expect(confirmed.recoveryCodes).toHaveLength(10);
      expect(new Set(confirmed.recoveryCodes)).toHaveProperty("size", 10);
      for (const recoveryCode of confirmed.recoveryCodes) {
        expect(recoveryCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/);
      }
    });

    it("rejects an incorrect enrollment code", async () => {
      const { id, email, password } = await createUserAccount();
      await grantRoleAssignment(id);

      const login = await service.login(email, password);
      if (login.status !== "mfa_setup_required") throw new Error("expected mfa_setup_required");

      await expect(service.confirmMfaEnrollment(login.mfaTicket, "000000")).rejects.toThrow(
        "Invalid verification code"
      );
    });

    it("rejects a ticket issued for the wrong purpose", async () => {
      const { id, email, password } = await createUserAccount({ mfaEnabled: false });
      await grantRoleAssignment(id);

      const login = await service.login(email, password);
      if (login.status !== "mfa_setup_required") throw new Error("expected mfa_setup_required");
      const code = await generateTotp({ secret: login.secretForManualEntry });
      await service.confirmMfaEnrollment(login.mfaTicket, code);

      // A verify-purpose ticket must not work here.
      const second = await service.login(email, password);
      if (second.status !== "mfa_required") throw new Error("expected mfa_required");
      await expect(service.confirmMfaEnrollment(second.mfaTicket, "123456")).rejects.toThrow(
        UnauthorizedException
      );
    });
  });

  describe("verifyMfa", () => {
    it("issues a real session token for a valid TOTP code once MFA is enabled", async () => {
      const { id, email, password } = await createUserAccount();
      await grantRoleAssignment(id);

      // Enroll first.
      const enroll = await service.login(email, password);
      if (enroll.status !== "mfa_setup_required") throw new Error("expected mfa_setup_required");
      const enrollCode = await generateTotp({ secret: enroll.secretForManualEntry });
      await service.confirmMfaEnrollment(enroll.mfaTicket, enrollCode);

      // Now log in again; MFA is enabled, so this is a plain verify.
      const login = await service.login(email, password);
      if (login.status !== "mfa_required") throw new Error("expected mfa_required");
      const verifyCode = await generateTotp({ secret: enroll.secretForManualEntry });
      const verified = await service.verifyMfa(login.mfaTicket, verifyCode);

      expect(verified.status).toBe("ok");
      expect(verified.token).toEqual(expect.any(String));
    });

    it("rejects an incorrect TOTP code", async () => {
      const { id, email, password } = await createUserAccount();
      await grantRoleAssignment(id);

      const enroll = await service.login(email, password);
      if (enroll.status !== "mfa_setup_required") throw new Error("expected mfa_setup_required");
      const enrollCode = await generateTotp({ secret: enroll.secretForManualEntry });
      await service.confirmMfaEnrollment(enroll.mfaTicket, enrollCode);

      const login = await service.login(email, password);
      if (login.status !== "mfa_required") throw new Error("expected mfa_required");

      await expect(service.verifyMfa(login.mfaTicket, "000000")).rejects.toThrow(
        "Invalid verification code"
      );
    });

    it("rejects a malformed or expired mfa ticket", async () => {
      await expect(service.verifyMfa("not-a-real-ticket", "123456")).rejects.toThrow(
        UnauthorizedException
      );
    });
  });

  describe("verifyMfaRecoveryCode", () => {
    it("signs in with a valid recovery code and consumes it (single-use)", async () => {
      const { id, email, password } = await createUserAccount();
      await grantRoleAssignment(id);

      const enroll = await service.login(email, password);
      if (enroll.status !== "mfa_setup_required") throw new Error("expected mfa_setup_required");
      const enrollCode = await generateTotp({ secret: enroll.secretForManualEntry });
      const confirmed = await service.confirmMfaEnrollment(enroll.mfaTicket, enrollCode);
      const [recoveryCode] = confirmed.recoveryCodes;

      const login = await service.login(email, password);
      if (login.status !== "mfa_required") throw new Error("expected mfa_required");
      const verified = await service.verifyMfaRecoveryCode(login.mfaTicket, recoveryCode);
      expect(verified.status).toBe("ok");
      expect(verified.token).toEqual(expect.any(String));

      // Same code again — a fresh ticket, since a spent mfa_verify ticket
      // is itself single-use (tickets.ts), but the RECOVERY CODE is what
      // this test is really about: it must already be burned.
      const secondLogin = await service.login(email, password);
      if (secondLogin.status !== "mfa_required") throw new Error("expected mfa_required");
      await expect(
        service.verifyMfaRecoveryCode(secondLogin.mfaTicket, recoveryCode)
      ).rejects.toThrow("Invalid or already-used recovery code");
    });

    it("accepts a recovery code regardless of case or surrounding whitespace", async () => {
      const { id, email, password } = await createUserAccount();
      await grantRoleAssignment(id);

      const enroll = await service.login(email, password);
      if (enroll.status !== "mfa_setup_required") throw new Error("expected mfa_setup_required");
      const enrollCode = await generateTotp({ secret: enroll.secretForManualEntry });
      const confirmed = await service.confirmMfaEnrollment(enroll.mfaTicket, enrollCode);
      const [recoveryCode] = confirmed.recoveryCodes;

      const login = await service.login(email, password);
      if (login.status !== "mfa_required") throw new Error("expected mfa_required");
      const verified = await service.verifyMfaRecoveryCode(
        login.mfaTicket,
        `  ${recoveryCode.toLowerCase()}  `
      );
      expect(verified.status).toBe("ok");
    });

    it("rejects an unknown recovery code", async () => {
      const { id, email, password } = await createUserAccount();
      await grantRoleAssignment(id);

      const enroll = await service.login(email, password);
      if (enroll.status !== "mfa_setup_required") throw new Error("expected mfa_setup_required");
      const enrollCode = await generateTotp({ secret: enroll.secretForManualEntry });
      await service.confirmMfaEnrollment(enroll.mfaTicket, enrollCode);

      const login = await service.login(email, password);
      if (login.status !== "mfa_required") throw new Error("expected mfa_required");
      await expect(
        service.verifyMfaRecoveryCode(login.mfaTicket, "ZZZZZ-ZZZZZ")
      ).rejects.toThrow("Invalid or already-used recovery code");
    });

    it("rejects a recovery code belonging to a different account", async () => {
      const accountA = await createUserAccount();
      await grantRoleAssignment(accountA.id);
      const enrollA = await service.login(accountA.email, accountA.password);
      if (enrollA.status !== "mfa_setup_required") throw new Error("expected mfa_setup_required");
      const enrollCodeA = await generateTotp({ secret: enrollA.secretForManualEntry });
      const confirmedA = await service.confirmMfaEnrollment(enrollA.mfaTicket, enrollCodeA);
      const [recoveryCodeA] = confirmedA.recoveryCodes;

      const accountB = await createUserAccount();
      await grantRoleAssignment(accountB.id);
      const enrollB = await service.login(accountB.email, accountB.password);
      if (enrollB.status !== "mfa_setup_required") throw new Error("expected mfa_setup_required");
      const enrollCodeB = await generateTotp({ secret: enrollB.secretForManualEntry });
      await service.confirmMfaEnrollment(enrollB.mfaTicket, enrollCodeB);

      const loginB = await service.login(accountB.email, accountB.password);
      if (loginB.status !== "mfa_required") throw new Error("expected mfa_required");
      await expect(
        service.verifyMfaRecoveryCode(loginB.mfaTicket, recoveryCodeA)
      ).rejects.toThrow("Invalid or already-used recovery code");
    });

    it("rejects a malformed or expired mfa ticket", async () => {
      await expect(service.verifyMfaRecoveryCode("not-a-real-ticket", "ABCDE-FGHJK")).rejects.toThrow(
        UnauthorizedException
      );
    });
  });

  describe("requestPasswordReset", () => {
    it("returns a dev-mode token for a known email (test env is not production)", async () => {
      const { email } = await createUserAccount();

      const result = await service.requestPasswordReset(email);

      expect(result.message).toEqual(expect.any(String));
      expect(result.devModeToken).toEqual(expect.any(String));
    });

    it("returns the exact same generic message for an unknown email, with no token", async () => {
      const known = await createUserAccount();
      const knownResult = await service.requestPasswordReset(known.email);
      const unknownResult = await service.requestPasswordReset("nobody-here@example.com");

      expect(unknownResult.message).toBe(knownResult.message);
      expect(unknownResult.devModeToken).toBeUndefined();
    });

    describe("once SMTP is configured (2026-09-18 increment)", () => {
      let catcher: TestSmtpCatcher;
      const originalEnv = { ...process.env };

      beforeAll(async () => {
        catcher = await TestSmtpCatcher.start();
      });

      beforeEach(() => {
        process.env.SMTP_HOST = "127.0.0.1";
        process.env.SMTP_PORT = String(catcher.port);
        process.env.SMTP_FROM = "no-reply@aihxm.local";
        delete process.env.SMTP_USER;
        delete process.env.SMTP_PASS;
        catcher.clear();
      });

      afterAll(async () => {
        await catcher.stop();
        process.env = { ...originalEnv };
      });

      it("sends a real reset email and no longer echoes the token in the response, even outside production", async () => {
        const { email } = await createUserAccount();

        const result = await service.requestPasswordReset(email);

        expect(result.devModeToken).toBeUndefined();
        const received = catcher.all();
        const match = received.find((m) => m.to.includes(email));
        expect(match).toBeDefined();
        expect(match?.subject).toBe("Reset your AIHXM password");
        expect(match?.text).toContain("/reset-password?token=");
      });

      it("the token in the real email is a genuinely working reset token", async () => {
        const { id, email } = await createUserAccount();
        await grantRoleAssignment(id);

        await service.requestPasswordReset(email);
        const match = catcher.all().find((m) => m.to.includes(email));
        const tokenMatch = match?.text.match(/token=([a-f0-9]+)/);
        if (!tokenMatch) throw new Error("expected a real reset link with a token in the delivered email");

        await service.confirmPasswordReset(tokenMatch[1], "BrandNewPasswordFromEmail1!");
        const afterReset = await service.login(email, "BrandNewPasswordFromEmail1!");
        expect(afterReset.status).toBe("mfa_setup_required");
      });

      it("still returns the identical generic message, and no token, for an unknown email", async () => {
        const result = await service.requestPasswordReset("nobody-configured@example.com");
        expect(result.devModeToken).toBeUndefined();
        expect(catcher.all()).toHaveLength(0);
      });

      it("does not throw and still returns the generic message when the mail provider is unreachable", async () => {
        process.env.SMTP_PORT = "1"; // nothing listens on port 1
        const { email } = await createUserAccount();

        const result = await service.requestPasswordReset(email);

        expect(result.message).toEqual(expect.any(String));
        expect(result.devModeToken).toBeUndefined();
      });
    });
  });

  describe("confirmPasswordReset", () => {
    it("updates the password so a subsequent login can proceed with the new one", async () => {
      const { id, email, password } = await createUserAccount();
      await grantRoleAssignment(id);

      const { devModeToken } = await service.requestPasswordReset(email);
      if (!devModeToken) throw new Error("expected a dev-mode reset token in test env");

      const newPassword = "BrandNewPassword456!";
      await service.confirmPasswordReset(devModeToken, newPassword);

      // Old password must no longer work.
      await expect(service.login(email, password)).rejects.toThrow("Invalid email or password");

      // New password reaches the (still mandatory) MFA step, not a bare rejection.
      const afterReset = await service.login(email, newPassword);
      expect(afterReset.status).toBe("mfa_setup_required");
    });

    it("rejects an invalid or already-used reset token", async () => {
      await expect(
        service.confirmPasswordReset("not-a-real-token", "SomeNewPassword123!")
      ).rejects.toThrow("Invalid or expired reset token");
    });

    it("rejects a reset token that has already been consumed", async () => {
      const { email } = await createUserAccount();
      const { devModeToken } = await service.requestPasswordReset(email);
      if (!devModeToken) throw new Error("expected a dev-mode reset token in test env");

      await service.confirmPasswordReset(devModeToken, "FirstNewPassword123!");

      await expect(
        service.confirmPasswordReset(devModeToken, "SecondNewPassword123!")
      ).rejects.toThrow("Invalid or expired reset token");
    });
  });

  describe("me", () => {
    it("returns the platform admin's own identity", async () => {
      const { id, email } = await createUserAccount();
      const fullName = "Platform Admin Test";
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query(
          "INSERT INTO platform_admins (user_account_id, full_name, email, status) VALUES ($1, $2, $3, 'active')",
          [id, fullName, email]
        )
      );

      const claims: RequestClaims = { is_platform_admin: true, company_id: null, sub: id };
      const result = await service.me(claims);

      expect(result.isPlatformAdmin).toBe(true);
      expect(result.companyId).toBeNull();
      expect(result.email).toBe(email);
      expect(result.fullName).toBe(fullName);
      expect(result.roleKeys).toEqual([]);
    });

    it("returns a tenant RBAC user's own identity, including their role keys", async () => {
      const { id, email } = await createUserAccount();
      const { companyId } = await grantRoleAssignment(id);

      const claims: RequestClaims = { is_platform_admin: false, company_id: companyId, sub: id };
      const result = await service.me(claims);

      expect(result.isPlatformAdmin).toBe(false);
      expect(result.companyId).toBe(companyId);
      expect(result.email).toBe(email);
      expect(result.roleKeys).toContain("hr_admin");
    });

    it("throws when a non-platform-admin session somehow has no company context", async () => {
      const { id } = await createUserAccount();
      const claims: RequestClaims = { is_platform_admin: false, company_id: null, sub: id };

      await expect(service.me(claims)).rejects.toThrow("Session has no company context");
    });
  });

  describe("end-to-end login flow", () => {
    it("goes from a freshly-created account to a real session token via the enrollment path", async () => {
      const { id, email, password } = await createUserAccount();
      await grantRoleAssignment(id);

      const token = await loginToSessionToken(email, password);

      expect(token).toEqual(expect.any(String));
      expect(token.split(".")).toHaveLength(3); // a real signed JWT
    });
  });

  /** Sets one 'security'-category tenant_configuration override directly, the same shape session-security.service.spec.ts's own helper uses. */
  async function setSecurityOverride(companyId: string, settingKey: string, value: unknown): Promise<void> {
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      await client.query(
        `INSERT INTO tenant_configuration (company_id, category, setting_key, value, updated_by)
         VALUES ($1, 'security', $2, $3::jsonb, 'test-fixture')
         ON CONFLICT (company_id, category, setting_key) DO UPDATE SET value = EXCLUDED.value`,
        [companyId, settingKey, JSON.stringify(value)]
      );
    });
  }

  // Phase 2 gap-fill items #1/#4 — proving SessionSecurityService's
  // per-tenant policy (already unit-tested in isolation in
  // session-security.service.spec.ts) actually changes AuthService's real
  // behavior, not just that the lookup itself works.
  describe("per-tenant security policy (Phase 2 gap-fill items #1/#4)", () => {
    it("locks the account after the tenant's own (lower) max_login_attempts override, not the global default of 5", async () => {
      const { id, email, password } = await createUserAccount();
      const { companyId } = await grantRoleAssignment(id);
      await setSecurityOverride(companyId, "max_login_attempts", 2);

      // Two wrong attempts reach the override's threshold (each still
      // reports "invalid email or password" — the lock is only surfaced
      // on the NEXT attempt, same as the flat-constant behavior already
      // covered by the "locks out after 5" test above).
      await expect(service.login(email, "WrongPassword123!")).rejects.toThrow("Invalid email or password");
      await expect(service.login(email, "WrongPassword123!")).rejects.toThrow("Invalid email or password");

      // A third attempt — even with the CORRECT password — is now blocked
      // by the lockout the override triggered two attempts early.
      await expect(service.login(email, password)).rejects.toThrow("Too many failed attempts");
    });

    it("locks for the tenant's own (shorter) lockout_duration_minutes override, not the global default of 15", async () => {
      const { id, email, password } = await createUserAccount();
      const { companyId } = await grantRoleAssignment(id);
      await setSecurityOverride(companyId, "max_login_attempts", 1);
      await setSecurityOverride(companyId, "lockout_duration_minutes", 1);

      await expect(service.login(email, "WrongPassword123!")).rejects.toThrow("Invalid email or password");

      const row = await db.withClaims(FIXTURE_CLAIMS, (c) =>
        c.query<{ locked_until: string }>("SELECT locked_until FROM user_accounts WHERE id = $1", [id])
      );
      const lockedUntil = new Date(row.rows[0].locked_until).getTime();
      const minutesFromNow = (lockedUntil - Date.now()) / 60_000;
      // Comfortably inside the 1-minute override's window and nowhere
      // near the 15-minute default, allowing for normal test-run jitter.
      expect(minutesFromNow).toBeGreaterThan(0);
      expect(minutesFromNow).toBeLessThan(5);

      // The correct password is rejected as a lockout, not as "wrong
      // password" — proving the shorter window is actually enforced, not
      // just recorded.
      await expect(service.login(email, password)).rejects.toThrow("Too many failed attempts");
    });

    it("issues a session token whose lifetime matches the tenant's own session_timeout_minutes override", async () => {
      const { id, email, password } = await createUserAccount();
      const { companyId } = await grantRoleAssignment(id);
      await setSecurityOverride(companyId, "session_timeout_minutes", 5);

      const token = await loginToSessionToken(email, password);
      const decoded = jwtDecode(token);

      expect(decoded.exp - decoded.iat).toBe(5 * 60);
    });

    it("revokes the oldest session once a new login exceeds the tenant's own max_concurrent_sessions override", async () => {
      const { id, email, password } = await createUserAccount();
      const { companyId } = await grantRoleAssignment(id);
      await setSecurityOverride(companyId, "max_concurrent_sessions", 1);

      // First login: enrollment round, issues the first session token.
      const enroll = await service.login(email, password);
      if (enroll.status !== "mfa_setup_required") throw new Error("expected mfa_setup_required");
      const enrollCode = await generateTotp({ secret: enroll.secretForManualEntry });
      const first = await service.confirmMfaEnrollment(enroll.mfaTicket, enrollCode);
      const firstJti = jwtDecode(first.token).jti;

      // Second login: MFA is now enabled, so this is a plain verify — a
      // second full session for the SAME account, which is what should
      // push it over the override's limit of 1 and evict the first.
      const login = await service.login(email, password);
      if (login.status !== "mfa_required") throw new Error("expected mfa_required on second login");
      const verifyCode = await generateTotp({ secret: enroll.secretForManualEntry });
      const second = await service.verifyMfa(login.mfaTicket, verifyCode);
      const secondJti = jwtDecode(second.token).jti;

      const sessions = await db.withClaims(FIXTURE_CLAIMS, (c) =>
        c.query<{ id: string; revoked_at: string | null }>(
          "SELECT id, revoked_at FROM user_sessions WHERE user_account_id = $1 ORDER BY created_at ASC",
          [id]
        )
      );
      expect(sessions.rows).toHaveLength(2);
      const firstRow = sessions.rows.find((r) => r.id === firstJti);
      const secondRow = sessions.rows.find((r) => r.id === secondJti);
      expect(firstRow?.revoked_at).not.toBeNull();
      expect(secondRow?.revoked_at).toBeNull();
    });
  });

  // Phase 3 item #8 — closing the real, pre-existing gap: ip_address/
  // user_agent were threaded nowhere and stayed NULL since Phase 1 (see
  // issueSessionToken's own doc comment), plus the two honest,
  // zero-external-data signals computed from that data now that it's
  // actually captured.
  describe("session request context (Phase 3 item #8)", () => {
    async function latestSession(userAccountId: string) {
      const result = await db.withClaims(FIXTURE_CLAIMS, (c) =>
        c.query<{
          ip_address: string | null;
          user_agent: string | null;
          is_new_device: boolean;
          is_rapid_network_change: boolean;
          created_at: Date;
        }>(
          "SELECT ip_address, user_agent, is_new_device, is_rapid_network_change, created_at FROM user_sessions WHERE user_account_id = $1 ORDER BY created_at DESC LIMIT 1",
          [userAccountId]
        )
      );
      return result.rows[0];
    }

    async function auditEntries(userAccountId: string) {
      const result = await db.withClaims(FIXTURE_CLAIMS, (c) =>
        c.query<{ metadata: Record<string, unknown> }>(
          "SELECT metadata FROM audit_log WHERE action = 'auth.suspicious_login' AND actor = $1",
          [userAccountId]
        )
      );
      return result.rows;
    }

    it("persists the real IP address and User-Agent, not null", async () => {
      const { id, email, password } = await createUserAccount();
      await grantRoleAssignment(id);

      await loginToSessionToken(email, password, { ipAddress: "203.0.113.7", userAgent: "TestAgent/1.0" });

      const row = await latestSession(id);
      expect(row.ip_address).toBe("203.0.113.7");
      expect(row.user_agent).toBe("TestAgent/1.0");
    });

    it("flags a brand-new account's very first session as a new device", async () => {
      const { id, email, password } = await createUserAccount();
      await grantRoleAssignment(id);

      await loginToSessionToken(email, password, { ipAddress: "203.0.113.7", userAgent: "TestAgent/1.0" });

      const row = await latestSession(id);
      expect(row.is_new_device).toBe(true);
    });

    it("does not flag a returning fingerprint (same User-Agent) as a new device", async () => {
      const { id, email, password } = await createUserAccount();
      await grantRoleAssignment(id);

      const enroll = await service.login(email, password);
      if (enroll.status !== "mfa_setup_required") throw new Error("expected mfa_setup_required");
      await service.confirmMfaEnrollment(enroll.mfaTicket, await generateTotp({ secret: enroll.secretForManualEntry }), {
        ipAddress: "203.0.113.7",
        userAgent: "TestAgent/1.0",
      });

      await reLoginToSessionToken(email, password, enroll.secretForManualEntry, {
        ipAddress: "203.0.113.7",
        userAgent: "TestAgent/1.0",
      });

      const row = await latestSession(id);
      expect(row.is_new_device).toBe(false);
    });

    it("flags a genuinely new User-Agent fingerprint as a new device on a later login", async () => {
      const { id, email, password } = await createUserAccount();
      await grantRoleAssignment(id);

      const enroll = await service.login(email, password);
      if (enroll.status !== "mfa_setup_required") throw new Error("expected mfa_setup_required");
      await service.confirmMfaEnrollment(enroll.mfaTicket, await generateTotp({ secret: enroll.secretForManualEntry }), {
        ipAddress: "203.0.113.7",
        userAgent: "TestAgent/1.0",
      });

      await reLoginToSessionToken(email, password, enroll.secretForManualEntry, {
        ipAddress: "203.0.113.7",
        userAgent: "SomeOtherBrowser/9.9",
      });

      const row = await latestSession(id);
      expect(row.is_new_device).toBe(true);
    });

    it("flags rapid re-authentication from a different IP arriving soon after the prior session", async () => {
      const { id, email, password } = await createUserAccount();
      await grantRoleAssignment(id);

      const enroll = await service.login(email, password);
      if (enroll.status !== "mfa_setup_required") throw new Error("expected mfa_setup_required");
      await service.confirmMfaEnrollment(enroll.mfaTicket, await generateTotp({ secret: enroll.secretForManualEntry }), {
        ipAddress: "203.0.113.7",
        userAgent: "TestAgent/1.0",
      });

      await reLoginToSessionToken(email, password, enroll.secretForManualEntry, {
        ipAddress: "198.51.100.9",
        userAgent: "TestAgent/1.0",
      });

      const row = await latestSession(id);
      expect(row.is_rapid_network_change).toBe(true);
    });

    it("does not flag a same-IP re-login, even immediately after", async () => {
      const { id, email, password } = await createUserAccount();
      await grantRoleAssignment(id);

      const enroll = await service.login(email, password);
      if (enroll.status !== "mfa_setup_required") throw new Error("expected mfa_setup_required");
      await service.confirmMfaEnrollment(enroll.mfaTicket, await generateTotp({ secret: enroll.secretForManualEntry }), {
        ipAddress: "203.0.113.7",
        userAgent: "TestAgent/1.0",
      });

      await reLoginToSessionToken(email, password, enroll.secretForManualEntry, {
        ipAddress: "203.0.113.7",
        userAgent: "TestAgent/1.0",
      });

      const row = await latestSession(id);
      expect(row.is_rapid_network_change).toBe(false);
    });

    it("does not flag a different IP once the gap exceeds the rapid-change window", async () => {
      const { id, email, password } = await createUserAccount();
      await grantRoleAssignment(id);

      const enroll = await service.login(email, password);
      if (enroll.status !== "mfa_setup_required") throw new Error("expected mfa_setup_required");
      await service.confirmMfaEnrollment(enroll.mfaTicket, await generateTotp({ secret: enroll.secretForManualEntry }), {
        ipAddress: "203.0.113.7",
        userAgent: "TestAgent/1.0",
      });

      // Backdate that first session's created_at well outside the
      // (15-minute) window, rather than sleeping the test for 15 minutes.
      await db.withClaims(FIXTURE_CLAIMS, (c) =>
        c.query("UPDATE user_sessions SET created_at = now() - interval '1 hour' WHERE user_account_id = $1", [id])
      );

      await reLoginToSessionToken(email, password, enroll.secretForManualEntry, {
        ipAddress: "198.51.100.9",
        userAgent: "TestAgent/1.0",
      });

      const row = await latestSession(id);
      expect(row.is_rapid_network_change).toBe(false);
    });

    it("records auth.suspicious_login only when at least one flag trips, and not on an unremarkable login", async () => {
      const { id, email, password } = await createUserAccount();
      await grantRoleAssignment(id);

      // First login ever: always a new device (nothing to compare
      // against), so this SHOULD produce exactly one audit entry.
      await loginToSessionToken(email, password, { ipAddress: "203.0.113.7", userAgent: "TestAgent/1.0" });
      expect(await auditEntries(id)).toHaveLength(1);
      expect(await auditEntries(id)).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({ isNewDevice: true, ipAddress: "203.0.113.7" }),
        }),
      ]);
    });

    it("records no auth.suspicious_login for an unremarkable repeat login (same device, same IP, no rush)", async () => {
      const { id, email, password } = await createUserAccount();
      await grantRoleAssignment(id);

      const enroll = await service.login(email, password);
      if (enroll.status !== "mfa_setup_required") throw new Error("expected mfa_setup_required");
      await service.confirmMfaEnrollment(enroll.mfaTicket, await generateTotp({ secret: enroll.secretForManualEntry }), {
        ipAddress: "203.0.113.7",
        userAgent: "TestAgent/1.0",
      });
      // The enrollment login itself is a new device (first ever) — clear
      // that one audit entry from consideration and only assert on what
      // happens for the SECOND, unremarkable login.
      const afterEnrollCount = (await auditEntries(id)).length;
      expect(afterEnrollCount).toBe(1);

      await reLoginToSessionToken(email, password, enroll.secretForManualEntry, {
        ipAddress: "203.0.113.7",
        userAgent: "TestAgent/1.0",
      });

      expect(await auditEntries(id)).toHaveLength(afterEnrollCount);
    });
  });
});

function jwtDecode(token: string): { iat: number; exp: number; jti: string } {
  const payload = token.split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
}
