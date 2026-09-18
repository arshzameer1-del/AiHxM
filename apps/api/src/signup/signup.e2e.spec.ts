import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { generate as generateTotp } from "otplib";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "signup-e2e-fixtures",
};

/**
 * `POST /signup` (signup.controller.ts) — the one unauthenticated,
 * public write endpoint outside `/auth/*`. This test drives the WHOLE
 * point of the feature end to end: a caller with no session at all
 * creates a company, then logs in as the admin THAT SAME CALL just
 * created and successfully performs a real `hr_admin`-gated action
 * (`POST /employees`) — proving the self-granted `hr_admin` role
 * (Decision #12's gap, closed specifically for this path in
 * signup.service.ts) actually works, not just that a login exists.
 */
describe("Signup HTTP surface (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;

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

  it("creates a company, seeds its default modules, and its admin can log in and act as hr_admin", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const adminEmail = `signup-e2e-${stamp}@example.com`;

    const signupRes = await request(app.getHttpServer())
      .post("/signup")
      .send({
        companyName: `Signup E2E Co ${stamp}`,
        adminFullName: "Signup Admin",
        adminEmail,
        adminPassword: "SignupPassword123!",
      });

    expect(signupRes.status).toBe(201);
    expect(signupRes.body.companyId).toBeTruthy();
    expect(signupRes.body.packageTier).toBe("starter");
    expect(signupRes.body.slug).toContain("signup-e2e-co");

    // Real go/no-go: starter's own default modules (package_tier_modules,
    // migrations/0006) actually landed as real tenant_module_entitlement
    // rows, not just the cached company_config jsonb.
    const entitlements = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("SELECT module_key, enabled FROM tenant_module_entitlement WHERE company_id = $1", [
        signupRes.body.companyId,
      ])
    );
    const enabledKeys = entitlements.rows.filter((r) => r.enabled).map((r) => r.module_key).sort();
    expect(enabledKeys).toEqual(["dummy", "employee", "leave"]);

    const token = await loginToSessionToken(adminEmail, "SignupPassword123!");
    expect(token).toBeTruthy();

    const me = await request(app.getHttpServer()).get("/auth/me").set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.companyId).toBe(signupRes.body.companyId);
    expect(me.body.roleKeys).toEqual(["hr_admin"]);

    // The real proof this is a WORKING hr_admin, not just a session that
    // exists: an hr_admin-gated write actually succeeds.
    const createEmployee = await request(app.getHttpServer())
      .post("/employees")
      .set("Authorization", `Bearer ${token}`)
      .send({ firstName: "First", lastName: "Hire", employmentType: "permanent", dateOfJoining: "2026-01-01" });
    expect(createEmployee.status).toBe(201);
  });

  it("rejects a second signup with an email already in use", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const adminEmail = `signup-e2e-dup-${stamp}@example.com`;

    const first = await request(app.getHttpServer())
      .post("/signup")
      .send({ companyName: `Dup Co ${stamp}`, adminFullName: "First", adminEmail, adminPassword: "SignupPassword123!" });
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer())
      .post("/signup")
      .send({ companyName: `Dup Co Two ${stamp}`, adminFullName: "Second", adminEmail, adminPassword: "SignupPassword123!" });
    expect(second.status).toBe(409);
  });

  it("resolves a slug collision automatically rather than failing the request", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const sharedName = `Collision Co ${stamp}`;

    const first = await request(app.getHttpServer())
      .post("/signup")
      .send({
        companyName: sharedName,
        adminFullName: "First",
        adminEmail: `signup-e2e-collide-a-${stamp}@example.com`,
        adminPassword: "SignupPassword123!",
      });
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer())
      .post("/signup")
      .send({
        companyName: sharedName,
        adminFullName: "Second",
        adminEmail: `signup-e2e-collide-b-${stamp}@example.com`,
        adminPassword: "SignupPassword123!",
      });
    expect(second.status).toBe(201);
    expect(second.body.slug).not.toBe(first.body.slug);
  });

  it("defaults to the professional tier's modules (including payroll) when requested", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const signupRes = await request(app.getHttpServer())
      .post("/signup")
      .send({
        companyName: `Pro Tier Co ${stamp}`,
        packageTier: "professional",
        adminFullName: "Pro Admin",
        adminEmail: `signup-e2e-pro-${stamp}@example.com`,
        adminPassword: "SignupPassword123!",
      });
    expect(signupRes.status).toBe(201);

    const entitlements = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("SELECT module_key FROM tenant_module_entitlement WHERE company_id = $1 AND enabled = true", [
        signupRes.body.companyId,
      ])
    );
    expect(entitlements.rows.map((r) => r.module_key)).toContain("payroll");
  });

  it("rejects a request missing required fields", async () => {
    const res = await request(app.getHttpServer()).post("/signup").send({ companyName: "Incomplete Co" });
    expect(res.status).toBe(400);
  });
});
