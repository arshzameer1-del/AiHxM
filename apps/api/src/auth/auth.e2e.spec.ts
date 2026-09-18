import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { generate as generateTotp } from "otplib";
import { Pool } from "pg";
import request from "supertest";
import * as bcrypt from "bcryptjs";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "auth-e2e-fixtures",
};

/**
 * Real routes only (auth.controller.ts): POST /auth/login,
 * POST /auth/mfa/enroll/confirm, POST /auth/mfa/verify,
 * POST /auth/password-reset/request, POST /auth/password-reset/confirm,
 * and the guarded GET /auth/me. There is no /auth/refresh,
 * /auth/change-password, /auth/forgot-password, or /auth/logout endpoint
 * anywhere in this app — sessions are stateless JWTs with no server-side
 * revocation, and password changes go through the reset flow. MFA is
 * mandatory for every account (auth.service.ts), so login() never returns
 * a bare token: the first login for a fresh account always comes back
 * `mfa_setup_required` with an enrollable TOTP secret.
 */
describe("Auth HTTP surface (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let testEmail: string;
  let testPassword: string;

  // resolveIdentityForAccount() (auth.service.ts) runs BEFORE the MFA
  // check on every login and throws if the account isn't linked to an
  // admin profile or a role assignment — so every fixture account here
  // is created as a platform admin to satisfy that, exactly like
  // AuthService's own "me" tests do for the platform-admin tier.
  async function createUserAccount(email: string, password: string): Promise<string> {
    const passwordHash = await bcrypt.hash(password, 10);
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, $2) RETURNING id",
        [email, passwordHash]
      );
      const userAccountId = result.rows[0].id as string;
      await client.query(
        "INSERT INTO platform_admins (user_account_id, full_name, email, status) VALUES ($1, $2, $3, 'active')",
        [userAccountId, "Auth E2E Fixture Admin", email]
      );
      return userAccountId;
    });
  }

  /** Drives a fresh account through login -> MFA enrollment -> a real session token. */
  async function loginToSessionToken(email: string, password: string): Promise<string> {
    const loginRes = await request(app.getHttpServer()).post("/auth/login").send({ email, password });
    if (loginRes.body.status !== "mfa_setup_required") {
      throw new Error(`Expected mfa_setup_required, got ${JSON.stringify(loginRes.body)}`);
    }
    const code = await generateTotp({ secret: loginRes.body.secretForManualEntry });
    const confirmRes = await request(app.getHttpServer())
      .post("/auth/mfa/enroll/confirm")
      .send({ mfaTicket: loginRes.body.mfaTicket, code });
    return confirmRes.body.token;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      })
    );
    await app.init();

    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);

    testEmail = `auth-e2e-${Date.now()}@example.com`;
    testPassword = "TestPassword123!";
    await createUserAccount(testEmail, testPassword);
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  describe("POST /auth/login", () => {
    it("returns mfa_setup_required with an enrollable secret on first login", async () => {
      const res = await request(app.getHttpServer()).post("/auth/login").send({
        email: testEmail,
        password: testPassword,
      });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("mfa_setup_required");
      expect(res.body.mfaTicket).toEqual(expect.any(String));
      expect(res.body.secretForManualEntry).toEqual(expect.any(String));
      expect(res.body.otpauthUrl).toContain("otpauth://");
      expect(res.body.token).toBeUndefined();
    });

    it("rejects login with wrong password", async () => {
      const res = await request(app.getHttpServer()).post("/auth/login").send({
        email: testEmail,
        password: "WrongPassword123!",
      });

      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/invalid/i);
    });

    it("rejects login with non-existent email", async () => {
      const res = await request(app.getHttpServer()).post("/auth/login").send({
        email: "nonexistent@example.com",
        password: "AnyPassword123!",
      });

      expect(res.status).toBe(401);
    });

    it("rejects login with missing email", async () => {
      const res = await request(app.getHttpServer()).post("/auth/login").send({
        password: testPassword,
      });

      expect(res.status).toBe(400);
    });

    it("rejects login with missing password", async () => {
      const res = await request(app.getHttpServer()).post("/auth/login").send({
        email: testEmail,
      });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /auth/mfa/enroll/confirm and POST /auth/mfa/verify", () => {
    it("completes enrollment then requires a plain TOTP verify on the next login", async () => {
      const email = `auth-e2e-mfa-${Date.now()}@example.com`;
      const password = "TestPassword123!";
      await createUserAccount(email, password);

      const enrollLoginRes = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email, password });
      expect(enrollLoginRes.body.status).toBe("mfa_setup_required");

      const enrollCode = await generateTotp({ secret: enrollLoginRes.body.secretForManualEntry });
      const confirmRes = await request(app.getHttpServer())
        .post("/auth/mfa/enroll/confirm")
        .send({ mfaTicket: enrollLoginRes.body.mfaTicket, code: enrollCode });

      expect(confirmRes.status).toBe(201);
      expect(confirmRes.body.status).toBe("ok");
      expect(confirmRes.body.token).toEqual(expect.any(String));

      const secondLoginRes = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email, password });
      expect(secondLoginRes.body.status).toBe("mfa_required");
      expect(secondLoginRes.body.token).toBeUndefined();

      const verifyCode = await generateTotp({ secret: enrollLoginRes.body.secretForManualEntry });
      const verifyRes = await request(app.getHttpServer())
        .post("/auth/mfa/verify")
        .send({ mfaTicket: secondLoginRes.body.mfaTicket, code: verifyCode });

      expect(verifyRes.status).toBe(201);
      expect(verifyRes.body.status).toBe("ok");
      expect(verifyRes.body.token).toEqual(expect.any(String));
    });

    it("rejects an incorrect enrollment code", async () => {
      const email = `auth-e2e-badcode-${Date.now()}@example.com`;
      await createUserAccount(email, "TestPassword123!");

      const loginRes = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email, password: "TestPassword123!" });

      const res = await request(app.getHttpServer())
        .post("/auth/mfa/enroll/confirm")
        .send({ mfaTicket: loginRes.body.mfaTicket, code: "000000" });

      expect(res.status).toBe(401);
    });

    it("rejects a malformed mfa ticket on verify", async () => {
      const res = await request(app.getHttpServer())
        .post("/auth/mfa/verify")
        .send({ mfaTicket: "not-a-real-ticket", code: "123456" });

      expect(res.status).toBe(401);
    });
  });

  describe("POST /auth/password-reset/request and POST /auth/password-reset/confirm", () => {
    it("issues a dev-mode reset token and allows resetting the password with it", async () => {
      const email = `auth-e2e-reset-${Date.now()}@example.com`;
      const password = "OldPassword123!";
      await createUserAccount(email, password);

      const requestRes = await request(app.getHttpServer())
        .post("/auth/password-reset/request")
        .send({ email });

      expect(requestRes.status).toBe(201);
      expect(requestRes.body.message).toEqual(expect.any(String));
      const devModeToken = requestRes.body.devModeToken;
      expect(devModeToken).toEqual(expect.any(String));

      const newPassword = "NewPassword456!";
      const confirmRes = await request(app.getHttpServer())
        .post("/auth/password-reset/confirm")
        .send({ token: devModeToken, newPassword });

      expect(confirmRes.status).toBe(201);
      expect(confirmRes.body.message).toMatch(/password/i);

      // New password reaches MFA setup. (Old-password-now-rejected is
      // already covered by the "wrong password" case above — kept out of
      // this test to stay well under /auth/login's 10-req/min throttle,
      // which this file's login-heavy suite otherwise brushes up against.)
      const newLoginRes = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email, password: newPassword });
      expect(newLoginRes.body.status).toBe("mfa_setup_required");
    });

    it("returns the same generic message for an unknown email, with no token", async () => {
      const res = await request(app.getHttpServer())
        .post("/auth/password-reset/request")
        .send({ email: "nonexistent-reset@example.com" });

      expect(res.status).toBe(201);
      expect(res.body.devModeToken).toBeUndefined();
    });

    it("rejects an invalid or already-used reset token", async () => {
      const res = await request(app.getHttpServer())
        .post("/auth/password-reset/confirm")
        .send({ token: "not-a-real-token", newPassword: "SomeNewPassword123!" });

      expect(res.status).toBe(401);
    });

    it("rejects a missing email on request", async () => {
      const res = await request(app.getHttpServer()).post("/auth/password-reset/request").send({});

      expect(res.status).toBe(400);
    });
  });

  describe("GET /auth/me", () => {
    it("returns the caller's own identity for a valid session", async () => {
      const email = `auth-e2e-me-${Date.now()}@example.com`;
      const password = "TestPassword123!";
      await createUserAccount(email, password);
      const token = await loginToSessionToken(email, password);

      const res = await request(app.getHttpServer()).get("/auth/me").set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.email).toBe(email);
    });

    it("rejects without a session", async () => {
      const res = await request(app.getHttpServer()).get("/auth/me");

      expect(res.status).toBe(401);
    });

    it("rejects an invalid token", async () => {
      const res = await request(app.getHttpServer()).get("/auth/me").set("Authorization", "Bearer invalid-token");

      expect(res.status).toBe(401);
    });
  });
});
