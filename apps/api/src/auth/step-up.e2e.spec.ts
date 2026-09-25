import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { generate as generateTotp } from "otplib";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { enableMfaForTestAccount, insertRecoveryCodeForTest, testSessionId } from "./step-up-test-support";

const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "step-up-e2e-fixtures",
};

function signSession(payload: {
  sub: string;
  is_platform_admin: boolean;
  company_id: string | null;
  jti?: string;
}): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: "10m" });
}

/**
 * Phase 2 gap-fill item #2 — step-up re-authentication, exercised at the
 * HTTP level: `POST /auth/step-up` itself, and StepUpGuard's actual
 * enforcement on a real `@RequireStepUp()` route
 * (`POST /platform/admins` — the simplest of the five gated routes;
 * platform-admins.e2e.spec.ts and companies.e2e.spec.ts cover the other
 * four's HAPPY path, post-step-up, as part of their own fixture setup —
 * this file is what proves the gate is actually there before that).
 */
describe("Step-up re-authentication (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  async function createPlatformAdminAccount(): Promise<string> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
        [`step-up-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`]
      );
      return result.rows[0].id as string;
    });
  }

  it("blocks a @RequireStepUp() route until a fresh step-up grant exists", async () => {
    const userAccountId = await createPlatformAdminAccount();
    const secret = await enableMfaForTestAccount(db, userAccountId);
    const token = signSession({
      sub: userAccountId,
      is_platform_admin: true,
      company_id: null,
      jti: testSessionId(),
    });

    const blocked = await request(app.getHttpServer())
      .post("/platform/admins")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fullName: "Should Be Blocked",
        email: `step-up-blocked-${Date.now()}@example.com`,
        initialPassword: "SecurePassword123!",
      });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("step_up_required");

    const code = await generateTotp({ secret });
    const verify = await request(app.getHttpServer())
      .post("/auth/step-up")
      .set("Authorization", `Bearer ${token}`)
      .send({ totpCode: code });
    expect(verify.status).toBe(201);
    expect(verify.body.verifiedForSeconds).toEqual(expect.any(Number));

    const allowed = await request(app.getHttpServer())
      .post("/platform/admins")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fullName: "Should Now Succeed",
        email: `step-up-allowed-${Date.now()}@example.com`,
        initialPassword: "SecurePassword123!",
      });
    expect(allowed.status).toBe(201);
  });

  it("rejects an incorrect TOTP code", async () => {
    const userAccountId = await createPlatformAdminAccount();
    await enableMfaForTestAccount(db, userAccountId);
    const token = signSession({
      sub: userAccountId,
      is_platform_admin: true,
      company_id: null,
      jti: testSessionId(),
    });

    const res = await request(app.getHttpServer())
      .post("/auth/step-up")
      .set("Authorization", `Bearer ${token}`)
      .send({ totpCode: "000000" });
    expect(res.status).toBe(401);
  });

  it("accepts a valid recovery code and consumes it (single-use)", async () => {
    const userAccountId = await createPlatformAdminAccount();
    await enableMfaForTestAccount(db, userAccountId);
    const recoveryCode = "ABCDE-FGHJK";
    await insertRecoveryCodeForTest(db, userAccountId, recoveryCode);
    const token = signSession({
      sub: userAccountId,
      is_platform_admin: true,
      company_id: null,
      jti: testSessionId(),
    });

    const first = await request(app.getHttpServer())
      .post("/auth/step-up")
      .set("Authorization", `Bearer ${token}`)
      .send({ recoveryCode });
    expect(first.status).toBe(201);

    // A fresh session (new jti) for the same account, re-using the SAME
    // recovery code — must fail, proving it was actually consumed and not
    // just accepted because the account matched.
    const secondToken = signSession({
      sub: userAccountId,
      is_platform_admin: true,
      company_id: null,
      jti: testSessionId(),
    });
    const second = await request(app.getHttpServer())
      .post("/auth/step-up")
      .set("Authorization", `Bearer ${secondToken}`)
      .send({ recoveryCode });
    expect(second.status).toBe(401);
  });

  it("rejects step-up for an account with MFA not enabled", async () => {
    const userAccountId = await createPlatformAdminAccount();
    const token = signSession({
      sub: userAccountId,
      is_platform_admin: true,
      company_id: null,
      jti: testSessionId(),
    });

    const res = await request(app.getHttpServer())
      .post("/auth/step-up")
      .set("Authorization", `Bearer ${token}`)
      .send({ totpCode: "123456" });
    expect(res.status).toBe(401);
  });

  it("rejects a request with neither totpCode nor recoveryCode", async () => {
    const userAccountId = await createPlatformAdminAccount();
    await enableMfaForTestAccount(db, userAccountId);
    const token = signSession({
      sub: userAccountId,
      is_platform_admin: true,
      company_id: null,
      jti: testSessionId(),
    });

    const res = await request(app.getHttpServer())
      .post("/auth/step-up")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("can never be satisfied by a token with no jti at all (pre-sessions token shape)", async () => {
    const userAccountId = await createPlatformAdminAccount();
    const secret = await enableMfaForTestAccount(db, userAccountId);
    // Deliberately no `jti` — the same shape a token minted before
    // sessions/step-up existed would have.
    const token = signSession({ sub: userAccountId, is_platform_admin: true, company_id: null });

    const code = await generateTotp({ secret });
    const verify = await request(app.getHttpServer())
      .post("/auth/step-up")
      .set("Authorization", `Bearer ${token}`)
      .send({ totpCode: code });
    expect(verify.status).toBe(401);

    const blocked = await request(app.getHttpServer())
      .post("/platform/admins")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fullName: "Should Still Be Blocked",
        email: `step-up-no-jti-${Date.now()}@example.com`,
        initialPassword: "SecurePassword123!",
      });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("step_up_required");
  });

  it("gates POST /platform/companies/:id/admins/:adminId/account/reset-password the same way", async () => {
    const userAccountId = await createPlatformAdminAccount();
    const secret = await enableMfaForTestAccount(db, userAccountId);
    const token = signSession({
      sub: userAccountId,
      is_platform_admin: true,
      company_id: null,
      jti: testSessionId(),
    });

    const created = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Step-Up Reset Password Co",
        slug: `step-up-reset-pw-${Date.now()}`,
        initialAdmin: { fullName: "Reset PW Admin", email: `reset-pw-admin-${Date.now()}@example.com` },
      });
    expect(created.status).toBe(201);
    const companyId = created.body.company.id;
    const adminId = created.body.admins[0].id;

    await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/admins/${adminId}/account`)
      .set("Authorization", `Bearer ${token}`)
      .send({ initialPassword: "OriginalPassword123!" });

    const blocked = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/admins/${adminId}/account/reset-password`)
      .set("Authorization", `Bearer ${token}`)
      .send({ newPassword: "BrandNewPassword456!" });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("step_up_required");

    const code = await generateTotp({ secret });
    await request(app.getHttpServer())
      .post("/auth/step-up")
      .set("Authorization", `Bearer ${token}`)
      .send({ totpCode: code });

    const allowed = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/admins/${adminId}/account/reset-password`)
      .set("Authorization", `Bearer ${token}`)
      .send({ newPassword: "BrandNewPassword456!" });
    expect(allowed.status).toBe(201);
  });
});
