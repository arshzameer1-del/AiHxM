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
  sub: "mfa-recovery-code-e2e-fixtures",
};

/**
 * POST /auth/mfa/recovery-code/verify — split out of auth.e2e.spec.ts into
 * its own file (and therefore its own Nest app instance / own throttle
 * storage) rather than a describe block there, since that file's
 * login-heavy suite already sits right at /auth/login's 10-req/min
 * throttle and each recovery-code scenario needs its own real login round
 * trip (once to enroll, once more to reach mfa_required).
 */
describe("POST /auth/mfa/recovery-code/verify (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;

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
        [userAccountId, "MFA Recovery Code E2E Fixture Admin", email]
      );
      return userAccountId;
    });
  }

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

  it("rejects an unknown code, accepts the real one, then rejects reusing it", async () => {
    const email = `mfa-recovery-e2e-${Date.now()}@example.com`;
    const password = "TestPassword123!";
    await createUserAccount(email, password);

    const enrollLoginRes = await request(app.getHttpServer()).post("/auth/login").send({ email, password });
    expect(enrollLoginRes.body.status).toBe("mfa_setup_required");
    const enrollCode = await generateTotp({ secret: enrollLoginRes.body.secretForManualEntry });
    const confirmRes = await request(app.getHttpServer())
      .post("/auth/mfa/enroll/confirm")
      .send({ mfaTicket: enrollLoginRes.body.mfaTicket, code: enrollCode });
    const [recoveryCode] = confirmRes.body.recoveryCodes;
    expect(recoveryCode).toEqual(expect.any(String));

    const loginRes = await request(app.getHttpServer()).post("/auth/login").send({ email, password });
    expect(loginRes.body.status).toBe("mfa_required");
    const mfaTicket = loginRes.body.mfaTicket;

    // An unknown code is rejected without consuming anything.
    const unknownRes = await request(app.getHttpServer())
      .post("/auth/mfa/recovery-code/verify")
      .send({ mfaTicket, code: "ZZZZZ-ZZZZZ" });
    expect(unknownRes.status).toBe(401);

    // The real code signs in — mfa tickets aren't single-use (tickets.ts
    // is a stateless JWT, not a consumable server-side record), so the
    // same mfa_required ticket from above still works here.
    const recoveryRes = await request(app.getHttpServer())
      .post("/auth/mfa/recovery-code/verify")
      .send({ mfaTicket, code: recoveryCode });
    expect(recoveryRes.status).toBe(201);
    expect(recoveryRes.body.status).toBe("ok");
    expect(recoveryRes.body.token).toEqual(expect.any(String));

    // The CODE itself is single-use, though — same ticket, same code, now
    // rejected.
    const reuseRes = await request(app.getHttpServer())
      .post("/auth/mfa/recovery-code/verify")
      .send({ mfaTicket, code: recoveryCode });
    expect(reuseRes.status).toBe(401);
  });

  it("rejects a malformed or expired mfa ticket", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/mfa/recovery-code/verify")
      .send({ mfaTicket: "not-a-real-ticket", code: "ABCDE-FGHJK" });

    expect(res.status).toBe(401);
  });

  it("rejects a missing code", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/mfa/recovery-code/verify")
      .send({ mfaTicket: "not-a-real-ticket" });

    expect(res.status).toBe(400);
  });
});
