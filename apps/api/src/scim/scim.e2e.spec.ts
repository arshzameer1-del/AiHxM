import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { generate as generateTotp } from "otplib";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { randomUUID } from "crypto";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { enableMfaForTestAccount, performStepUpForTest, testSessionId } from "../auth/step-up-test-support";

const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "scim-e2e-fixtures",
};

function signPlatformAdminSession(userAccountId: string): string {
  return jwt.sign(
    { sub: userAccountId, is_platform_admin: true, company_id: null, jti: testSessionId() },
    process.env.JWT_SECRET as string,
    { expiresIn: "10m" }
  );
}

/**
 * The real HTTP surface: `ScimAdminController` (Platform-Admin + step-up
 * gated token management) and `ScimController` (the bearer-token-
 * authenticated RFC 7644 data surface an IdP's own SCIM connector calls),
 * driven end to end — no service-level shortcuts — the same discipline
 * `sso.e2e.spec.ts`/`integrations.e2e.spec.ts` already establish.
 */
describe("SCIM 2.0 provisioning (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let platformAdminToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);

    const platformAdminAccountId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
        [`scim-e2e-admin-${Date.now()}@example.com`]
      );
      return result.rows[0].id as string;
    });
    const secret = await enableMfaForTestAccount(db, platformAdminAccountId);
    platformAdminToken = signPlatformAdminSession(platformAdminAccountId);
    await performStepUpForTest(app, platformAdminToken, secret);
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  function uniqueSlug(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function createCompany(): Promise<{ companyId: string; slug: string }> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const slug = uniqueSlug("scim-e2e-co");
      const result = await client.query(
        "INSERT INTO companies (name, slug, status, package_tier) VALUES ($1, $2, 'active', 'starter') RETURNING id",
        [`SCIM E2E Co ${slug}`, slug]
      );
      return { companyId: result.rows[0].id as string, slug };
    });
  }

  async function generateScimToken(companyId: string): Promise<{ token: string; baseUrl: string }> {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/scim/token`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(201);
    return res.body;
  }

  describe("ScimAdminController (Platform Admin token management)", () => {
    it("requires a fresh step-up grant to generate a token", async () => {
      const { companyId } = await createCompany();
      const freshAccountId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query(
          "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
          [`scim-e2e-no-stepup-${Date.now()}@example.com`]
        );
        return result.rows[0].id as string;
      });
      await enableMfaForTestAccount(db, freshAccountId);
      const tokenWithoutStepUp = signPlatformAdminSession(freshAccountId);

      const res = await request(app.getHttpServer())
        .post(`/platform/companies/${companyId}/scim/token`)
        .set("Authorization", `Bearer ${tokenWithoutStepUp}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("step_up_required");
    });

    it("generates a token, reflects it in status, and the base URL matches this company's slug", async () => {
      const { companyId, slug } = await createCompany();
      const { token, baseUrl } = await generateScimToken(companyId);
      expect(token).toMatch(/^scim_[0-9a-f]{64}$/);
      expect(baseUrl.endsWith(`/scim/v2/${slug}`)).toBe(true);

      const status = await request(app.getHttpServer())
        .get(`/platform/companies/${companyId}/scim/status`)
        .set("Authorization", `Bearer ${platformAdminToken}`);
      expect(status.status).toBe(200);
      expect(status.body).toEqual({ enabled: true, hasToken: true, baseUrl });
    });

    it("disabling clears the token so the old one is rejected", async () => {
      const { companyId, slug } = await createCompany();
      const { token } = await generateScimToken(companyId);

      const disable = await request(app.getHttpServer())
        .post(`/platform/companies/${companyId}/scim/disable`)
        .set("Authorization", `Bearer ${platformAdminToken}`);
      expect(disable.status).toBe(201);
      expect(disable.body.enabled).toBe(false);

      const rejected = await request(app.getHttpServer())
        .get(`/scim/v2/${slug}/Users`)
        .set("Authorization", `Bearer ${token}`);
      expect(rejected.status).toBe(401);
    });
  });

  describe("ScimController (RFC 7644 data surface)", () => {
    it("rejects a request with no bearer token at all", async () => {
      const { slug } = await createCompany();
      const res = await request(app.getHttpServer()).get(`/scim/v2/${slug}/Users`);
      expect(res.status).toBe(401);
      expect(res.body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
    });

    it("rejects a well-formed but wrong bearer token", async () => {
      const { companyId, slug } = await createCompany();
      await generateScimToken(companyId);
      const res = await request(app.getHttpServer())
        .get(`/scim/v2/${slug}/Users`)
        .set("Authorization", `Bearer scim_${"0".repeat(64)}`);
      expect(res.status).toBe(401);
    });

    it("rejects a token that is valid, but for a DIFFERENT tenant", async () => {
      const companyA = await createCompany();
      const companyB = await createCompany();
      const { token: tokenForA } = await generateScimToken(companyA.companyId);
      await generateScimToken(companyB.companyId);

      const res = await request(app.getHttpServer())
        .get(`/scim/v2/${companyB.slug}/Users`)
        .set("Authorization", `Bearer ${tokenForA}`);
      expect(res.status).toBe(401);
    });

    it("serves ServiceProviderConfig/ResourceTypes/Schemas", async () => {
      const { companyId, slug } = await createCompany();
      const { token } = await generateScimToken(companyId);

      const spc = await request(app.getHttpServer())
        .get(`/scim/v2/${slug}/ServiceProviderConfig`)
        .set("Authorization", `Bearer ${token}`);
      expect(spc.status).toBe(200);
      expect(spc.body.patch.supported).toBe(true);

      const resourceTypes = await request(app.getHttpServer())
        .get(`/scim/v2/${slug}/ResourceTypes`)
        .set("Authorization", `Bearer ${token}`);
      expect(resourceTypes.status).toBe(200);
      expect(resourceTypes.body.Resources[0].id).toBe("User");

      const schemas = await request(app.getHttpServer())
        .get(`/scim/v2/${slug}/Schemas`)
        .set("Authorization", `Bearer ${token}`);
      expect(schemas.status).toBe(200);
    });

    it("drives a full Create -> filter-List -> Get -> Patch(deactivate) -> Put -> Delete lifecycle", async () => {
      const { companyId, slug } = await createCompany();
      const { token } = await generateScimToken(companyId);
      const email = `scim-e2e-lifecycle-${randomUUID()}@example.com`;

      const created = await request(app.getHttpServer())
        .post(`/scim/v2/${slug}/Users`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: email,
          name: { givenName: "Ada", familyName: "Lovelace" },
          emails: [{ value: email, type: "work", primary: true }],
          externalId: "idp-external-id-1",
          active: true,
        });
      expect(created.status).toBe(201);
      expect(created.body.userName).toBe(email);
      expect(created.body.active).toBe(true);
      expect(created.headers.location).toContain(`/scim/v2/${slug}/Users/${created.body.id}`);
      const userId = created.body.id as string;

      const listed = await request(app.getHttpServer())
        .get(`/scim/v2/${slug}/Users`)
        .query({ filter: `userName eq "${email}"` })
        .set("Authorization", `Bearer ${token}`);
      expect(listed.status).toBe(200);
      expect(listed.body.totalResults).toBe(1);
      expect(listed.body.Resources[0].id).toBe(userId);

      const fetched = await request(app.getHttpServer())
        .get(`/scim/v2/${slug}/Users/${userId}`)
        .set("Authorization", `Bearer ${token}`);
      expect(fetched.status).toBe(200);
      expect(fetched.body.name).toEqual({ givenName: "Ada", familyName: "Lovelace" });

      const patched = await request(app.getHttpServer())
        .patch(`/scim/v2/${slug}/Users/${userId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: false }],
        });
      expect(patched.status).toBe(200);
      expect(patched.body.active).toBe(false);

      const account = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("SELECT status FROM user_accounts WHERE id = $1", [userId])
      );
      expect(account.rows[0].status).toBe("locked");

      const replaced = await request(app.getHttpServer())
        .put(`/scim/v2/${slug}/Users/${userId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ userName: email, active: true, name: { givenName: "Ada", familyName: "Byron" } });
      expect(replaced.status).toBe(200);
      expect(replaced.body.active).toBe(true);
      expect(replaced.body.name.familyName).toBe("Byron");

      const deleted = await request(app.getHttpServer())
        .delete(`/scim/v2/${slug}/Users/${userId}`)
        .set("Authorization", `Bearer ${token}`);
      expect(deleted.status).toBe(204);

      const afterDelete = await request(app.getHttpServer())
        .get(`/scim/v2/${slug}/Users/${userId}`)
        .set("Authorization", `Bearer ${token}`);
      expect(afterDelete.status).toBe(200);
      expect(afterDelete.body.active).toBe(false);

      const accountAfterDelete = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("SELECT status FROM user_accounts WHERE id = $1", [userId])
      );
      expect(accountAfterDelete.rows[0].status).toBe("locked");
    });

    it("rejects Create with no email-shaped userName/emails entry as a SCIM-shaped 400", async () => {
      const { companyId, slug } = await createCompany();
      const { token } = await generateScimToken(companyId);
      const res = await request(app.getHttpServer())
        .post(`/scim/v2/${slug}/Users`)
        .set("Authorization", `Bearer ${token}`)
        .send({ userName: "not-an-email" });
      expect(res.status).toBe(400);
      expect(res.body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
      expect(res.body.detail).toMatch(/valid email/i);
    });

    it("returns 404 for a user id belonging to a different tenant", async () => {
      const companyA = await createCompany();
      const companyB = await createCompany();
      const { token: tokenA } = await generateScimToken(companyA.companyId);
      const { token: tokenB } = await generateScimToken(companyB.companyId);

      const created = await request(app.getHttpServer())
        .post(`/scim/v2/${companyA.slug}/Users`)
        .set("Authorization", `Bearer ${tokenA}`)
        .send({ userName: `scim-e2e-isolated-${randomUUID()}@example.com` });

      const res = await request(app.getHttpServer())
        .get(`/scim/v2/${companyB.slug}/Users/${created.body.id}`)
        .set("Authorization", `Bearer ${tokenB}`);
      expect(res.status).toBe(404);
      expect(res.body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
    });

    it("accepts extra fields real IdPs commonly send (displayName, groups, meta) without 400ing", async () => {
      const { companyId, slug } = await createCompany();
      const { token } = await generateScimToken(companyId);
      const email = `scim-e2e-lenient-${randomUUID()}@example.com`;

      const res = await request(app.getHttpServer())
        .post(`/scim/v2/${slug}/Users`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: email,
          displayName: "Not Used By AIHXM",
          locale: "en-US",
          groups: [],
          "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": { department: "Engineering" },
        });
      expect(res.status).toBe(201);
      expect(res.body.userName).toBe(email);
    });
  });
});
