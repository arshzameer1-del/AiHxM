import { Test } from "@nestjs/testing";
import { UnauthorizedException } from "@nestjs/common";
import { generate as generateTotp } from "otplib";
import * as bcrypt from "bcryptjs";
import { Pool } from "pg";
import { AuthService } from "./auth.service";
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
  async function loginToSessionToken(email: string, password: string): Promise<string> {
    const first = await service.login(email, password);
    if (first.status !== "mfa_setup_required") {
      throw new Error(`Expected mfa_setup_required, got ${first.status}`);
    }
    const code = await generateTotp({ secret: first.secretForManualEntry });
    const confirmed = await service.confirmMfaEnrollment(first.mfaTicket, code);
    return confirmed.token;
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
});
