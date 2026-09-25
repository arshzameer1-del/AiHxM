import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "platform-admin-delegation-e2e-fixtures",
};

/**
 * Phase 2 gap-fill item #7 — Platform Admin delegation, exercised at the
 * HTTP level so PlatformAdminGuard's actual enforcement (not just
 * SessionSecurityService's lookup in isolation) is what's under test:
 * a real 'read_only' admin's mutating request is rejected before any
 * controller runs, and a real 'scoped' admin can reach a tenant in their
 * scope but not one outside it, on both the Tenant Directory list and a
 * company-detail route.
 */
describe("Platform Admin delegation (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let inScopeCompanyId: string;
  let outOfScopeCompanyId: string;
  let fullToken: string;
  let readOnlyToken: string;
  let scopedToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    [inScopeCompanyId, outOfScopeCompanyId] = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const inScope = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Delegation In-Scope Co ${stamp}`,
        `delegation-in-scope-${stamp}`,
      ]);
      const outOfScope = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Delegation Out-Of-Scope Co ${stamp}`,
        `delegation-out-of-scope-${stamp}`,
      ]);
      const inScopeId = inScope.rows[0].id as string;
      const outOfScopeId = outOfScope.rows[0].id as string;
      // CompaniesService.getDetail() (hit by the "can open"/"reach any
      // tenant" cases below) joins company_config unconditionally — a
      // bare companies row with no config row crashes rowToConfig(undefined)
      // rather than 404ing or 200ing empty. Every real company always has
      // one (CompaniesService.create() inserts both in the same
      // transaction), so give these fixtures the same shape.
      for (const id of [inScopeId, outOfScopeId]) {
        await client.query(
          `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
           VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
          [id]
        );
      }
      return [inScopeId, outOfScopeId];
    });

    async function createPlatformAdmin(accessLevel: "full" | "read_only" | "scoped"): Promise<string> {
      return db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const account = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, $2) RETURNING id", [
          `delegation-${accessLevel}-${stamp}@example.com`,
          "hashed",
        ]);
        const userAccountId = account.rows[0].id as string;
        const admin = await client.query(
          "INSERT INTO platform_admins (full_name, email, user_account_id, access_level) VALUES ($1, $2, $3, $4) RETURNING id",
          [`Delegation ${accessLevel}`, `delegation-${accessLevel}-${stamp}@example.com`, userAccountId, accessLevel]
        );
        if (accessLevel === "scoped") {
          await client.query(
            "INSERT INTO platform_admin_company_scope (platform_admin_id, company_id) VALUES ($1, $2)",
            [admin.rows[0].id, inScopeCompanyId]
          );
        }
        return userAccountId;
      });
    }

    const fullAdminId = await createPlatformAdmin("full");
    const readOnlyAdminId = await createPlatformAdmin("read_only");
    const scopedAdminId = await createPlatformAdmin("scoped");

    const sign = (sub: string) =>
      jwt.sign({ sub, company_id: null, is_platform_admin: true }, process.env.JWT_SECRET as string, {
        expiresIn: "24h",
      });
    fullToken = sign(fullAdminId);
    readOnlyToken = sign(readOnlyAdminId);
    scopedToken = sign(scopedAdminId);
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  describe("read_only", () => {
    it("allows GET requests", async () => {
      const res = await request(app.getHttpServer())
        .get("/platform/companies")
        .set("Authorization", `Bearer ${readOnlyToken}`);
      expect(res.status).toBe(200);
    });

    it("rejects a mutating request", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/platform/companies/${inScopeCompanyId}/profile`)
        .set("Authorization", `Bearer ${readOnlyToken}`)
        .send({ legalName: "Should Not Apply" });
      expect(res.status).toBe(403);
    });
  });

  describe("scoped", () => {
    it("only lists tenants within scope", async () => {
      const res = await request(app.getHttpServer())
        .get("/platform/companies")
        .set("Authorization", `Bearer ${scopedToken}`);
      expect(res.status).toBe(200);
      const ids = res.body.map((c: { id: string }) => c.id);
      expect(ids).toContain(inScopeCompanyId);
      expect(ids).not.toContain(outOfScopeCompanyId);
    });

    it("can open a tenant within scope", async () => {
      const res = await request(app.getHttpServer())
        .get(`/platform/companies/${inScopeCompanyId}`)
        .set("Authorization", `Bearer ${scopedToken}`);
      expect(res.status).toBe(200);
    });

    it("is rejected from a tenant outside scope", async () => {
      const res = await request(app.getHttpServer())
        .get(`/platform/companies/${outOfScopeCompanyId}`)
        .set("Authorization", `Bearer ${scopedToken}`);
      expect(res.status).toBe(403);
    });

    it("is rejected from a company-scoped tenant-management route outside scope", async () => {
      const res = await request(app.getHttpServer())
        .get(`/platform/companies/${outOfScopeCompanyId}/integrations`)
        .set("Authorization", `Bearer ${scopedToken}`);
      expect(res.status).toBe(403);
    });

    it("cannot manage other Platform Admins even without a company id to check", async () => {
      // Phase 2 gap-fill item #7's own privilege-escalation guard: this
      // controller has no companyId param for @ScopedCompanyParam to key
      // off, so PlatformAdminsService.requireFullAccess() is what closes
      // this specific path instead.
      const res = await request(app.getHttpServer())
        .post("/platform/admins")
        .set("Authorization", `Bearer ${scopedToken}`)
        .send({ fullName: "Should Not Be Created", email: `escalation-${Date.now()}@example.com`, initialPassword: "abcdefghij" });
      expect(res.status).toBe(403);
    });
  });

  describe("full", () => {
    it("can reach any tenant", async () => {
      const res = await request(app.getHttpServer())
        .get(`/platform/companies/${outOfScopeCompanyId}`)
        .set("Authorization", `Bearer ${fullToken}`);
      expect(res.status).toBe(200);
    });
  });
});
