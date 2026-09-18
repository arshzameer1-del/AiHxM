import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import helmet from "helmet";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "security-e2e-fixtures",
};

describe("Security & Compliance (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let hrAdminToken: string;
  let platformAdminToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    // main.ts's bootstrap() applies helmet() and the global ValidationPipe
    // itself — Test.createTestingModule bypasses bootstrap() entirely, so
    // this e2e app must apply the same middleware/pipes by hand to
    // actually exercise what production requests go through.
    app.use(helmet());
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

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug, status) VALUES ($1, $2, 'active') RETURNING id", [
        `Security E2E Co ${stamp}`,
        `security-e2e-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      // A bare company with no entitlement rows would 404 on every
      // real tenant endpoint before RBAC is even reached — this file's
      // tests need the employee module actually licensed to exercise
      // real permission/audit behavior, not the module-disabled path.
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [
        id,
      ]);
      return id;
    });

    const hrAdminId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, $2) RETURNING id",
        [`security-admin-${stamp}@example.com`, "hashed"]
      );
      const userAccountId = result.rows[0].id as string;
      const role = await client.query("SELECT id FROM roles WHERE key = 'hr_admin'");
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [
        userAccountId,
        companyId,
        role.rows[0].id,
      ]);
      return userAccountId;
    });

    hrAdminToken = jwt.sign(
      { sub: hrAdminId, company_id: companyId, is_platform_admin: false },
      process.env.JWT_SECRET as string,
      { expiresIn: "24h" }
    );

    platformAdminToken = jwt.sign(
      { sub: "security-e2e-platform-admin", company_id: null, is_platform_admin: true },
      process.env.JWT_SECRET as string,
      { expiresIn: "24h" }
    );
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  describe("HTTPS & Security Headers", () => {
    it("should enforce security headers", async () => {
      // The real route is GET /health (app.controller.ts) — there is no
      // /api prefix anywhere in this app.
      const res = await request(app.getHttpServer())
        .get("/health")
        .set("Authorization", `Bearer ${hrAdminToken}`);

      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toMatch(/DENY|SAMEORIGIN/i);
    });
  });

  describe("Authentication & Authorization", () => {
    it("should require valid JWT token for protected endpoints", async () => {
      const res = await request(app.getHttpServer()).get("/employees");
      expect(res.status).toBe(401);
    });

    it("should reject expired tokens", async () => {
      const expiredToken = jwt.sign(
        { sub: "user-123", company_id: companyId },
        process.env.JWT_SECRET as string,
        { expiresIn: "0s" }
      );

      await new Promise((resolve) => setTimeout(resolve, 1000));

      const res = await request(app.getHttpServer())
        .get("/employees")
        .set("Authorization", `Bearer ${expiredToken}`);

      expect(res.status).toBe(401);
    });

    it("should reject tampered tokens", async () => {
      const tampered = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.tampered.signature";

      const res = await request(app.getHttpServer())
        .get("/employees")
        .set("Authorization", `Bearer ${tampered}`);

      expect(res.status).toBe(401);
    });
  });

  describe("Input Validation", () => {
    // CreateEmployeeDto (employees/dto/create-employee.dto.ts) has no
    // @IsEmail() — email is a plain optional string there, so
    // "not-an-email" is not itself rejected. What IS enforced at the
    // edge is the whitelist: an unknown field (this file's earlier
    // fictional "jobTitle"/"joinDate" — the real fields are
    // designation/dateOfJoining) is stripped-and-rejected by the global
    // ValidationPipe's forbidNonWhitelisted, before any handler runs.
    it("should reject a request body containing unknown fields", async () => {
      const res = await request(app.getHttpServer())
        .post("/employees")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({
          firstName: "Test",
          lastName: "User",
          email: "test-user@example.com",
          department: "engineering",
          designation: "Engineer",
          employmentType: "permanent",
          notARealField: "should be rejected",
        });

      expect(res.status).toBe(400);
    });
  });

  describe("Data Protection", () => {
    it("should not expose password hashes in responses", async () => {
      const res = await request(app.getHttpServer())
        .get("/auth/me")
        .set("Authorization", `Bearer ${hrAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.passwordHash).toBeUndefined();
      expect(res.body.password_hash).toBeUndefined();
    });
  });

  describe("Cross-Tenant Isolation", () => {
    it("should prevent accessing other tenant data", async () => {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      // The other tenant needs the SAME module licensed and a caller with
      // the SAME real permission (hr_admin) — otherwise a bare/unlicensed
      // company just 404s before RLS is ever reached (Decision #5's
      // "look like it doesn't exist" posture), which proves nothing about
      // cross-tenant isolation specifically. With both tenants equally
      // licensed and permissioned, RLS itself (FORCE ROW LEVEL SECURITY,
      // scoped by the session's company_id claim) is what must produce an
      // empty list here, not an early module/permission denial.
      const otherCompanyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const company = await client.query(
          "INSERT INTO companies (name, slug, status) VALUES ($1, $2, 'active') RETURNING id",
          [`Security E2E Other Co ${stamp}`, `security-e2e-other-${stamp}`]
        );
        const id = company.rows[0].id as string;
        await client.query(
          `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
           VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
          [id]
        );
        await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [
          id,
        ]);
        return id;
      });

      const otherUserId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query(
          "INSERT INTO user_accounts (email, password_hash) VALUES ($1, $2) RETURNING id",
          [`security-other-${stamp}@example.com`, "hashed"]
        );
        const userAccountId = result.rows[0].id as string;
        const role = await client.query("SELECT id FROM roles WHERE key = 'hr_admin'");
        await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [
          userAccountId,
          otherCompanyId,
          role.rows[0].id,
        ]);
        return userAccountId;
      });

      const otherToken = jwt.sign(
        { sub: otherUserId, company_id: otherCompanyId, is_platform_admin: false },
        process.env.JWT_SECRET as string,
        { expiresIn: "24h" }
      );

      // hrAdminToken's own tenant already has at least one employee from
      // the "Audit Logging"/"Input Validation" tests' earlier POSTs in
      // this same describe run — but describe blocks in this file don't
      // guarantee ordering against each other, so create one explicitly
      // here rather than depending on it.
      await request(app.getHttpServer())
        .post("/employees")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ firstName: "Tenant", lastName: "Own", department: "engineering", designation: "Engineer" });

      const res = await request(app.getHttpServer())
        .get("/employees")
        .set("Authorization", `Bearer ${otherToken}`);

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(0);
    });
  });

  describe("Audit Logging", () => {
    it("should log all data modifications", async () => {
      // A plain POST /employees deliberately records no audit entry at
      // all (employees.service.ts's create() has no this.audit.record
      // call) — createLogin() (POST /employees/:id/account) does, via
      // action "employee.login_created", so that's the real modification
      // exercised here.
      const createRes = await request(app.getHttpServer())
        .post("/employees")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({
          firstName: "Audit",
          lastName: "Test",
          email: `audit-${Date.now()}@example.com`,
          department: "engineering",
          designation: "Engineer",
          employmentType: "permanent",
          dateOfJoining: new Date().toISOString().split("T")[0],
        });
      expect(createRes.status).toBe(201);

      const loginRes = await request(app.getHttpServer())
        .post(`/employees/${createRes.body.id}/account`)
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ initialPassword: "AuditTestPassword123!", roleKeys: ["employee_self_service"] });
      expect(loginRes.status).toBe(201);

      // There is no tenant-facing audit-log HTTP route — audit.controller.ts
      // only exposes GET /platform/audit-log, and only to a Platform Admin
      // (PlatformAdminGuard). Confirm the modification was actually logged
      // through that real route, scoped to this tenant.
      const auditRes = await request(app.getHttpServer())
        .get("/platform/audit-log")
        .query({ companyId })
        .set("Authorization", `Bearer ${platformAdminToken}`);

      expect(auditRes.status).toBe(200);
      expect(Array.isArray(auditRes.body)).toBe(true);
      expect(
        auditRes.body.some(
          (entry: { action: string; target: string }) =>
            entry.action === "employee.login_created" && entry.target === createRes.body.id
        )
      ).toBe(true);
    });

    it("rejects a non-platform-admin session", async () => {
      const res = await request(app.getHttpServer())
        .get("/platform/audit-log")
        .set("Authorization", `Bearer ${hrAdminToken}`);

      expect(res.status).toBe(401);
    });
  });
});
