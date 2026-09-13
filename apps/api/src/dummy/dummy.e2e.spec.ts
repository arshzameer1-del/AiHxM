import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

/**
 * This is the test the plan doc's Phase 4 exit criterion literally
 * describes: "a dummy record's test field is visible to one role and
 * absent from the raw API response for another, proven by an automated
 * test, not manual clicking." Runs the real HTTP stack (guards,
 * controllers, ValidationPipe) via supertest — not a call directly into
 * RbacService (that's rbac.service.spec.ts) — so it also proves the
 * wiring, not just the engine.
 *
 * Session tokens are signed directly with JWT_SECRET rather than going
 * through the password+MFA login flow — AuthService's own login
 * mechanics were already exercised end to end in Phase 3; this file's
 * job is the RBAC engine and its endpoint wiring, not re-proving login.
 */
// Fixture writes go in Platform-Admin-shaped, same reasoning as
// rbac.service.spec.ts: companies_write's INSERT policy only grants
// `is_platform_admin()`, not `is_service()`.
const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "dummy-e2e-fixtures" };

function signSession(payload: { sub: string; is_platform_admin: boolean; company_id: string | null }): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: "10m" });
}

describe("GET /rbac-demo/dummy-records (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;

  let companyId: string;
  let fullAccessUserId: string;
  let viewOnlyUserId: string;
  let recordId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);

    const stamp = Date.now();
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query(
        "INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id",
        [`Dummy E2E Co ${stamp}`, `dummy-e2e-${stamp}`]
      );
      companyId = company.rows[0].id;

      // Phase 5: DummyService now gates on the 'dummy' module's
      // entitlement before RBAC ever runs (see dummy.service.ts). This
      // fixture bypasses CompaniesService.create (which would seed this
      // automatically via EntitlementsService.seedForNewCompany), so it's
      // seeded directly here — without it, every test below would 404
      // before RBAC gets a chance to run at all.
      await client.query(
        `INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'dummy', true)`,
        [companyId]
      );

      async function makeUser(email: string): Promise<string> {
        const account = await client.query(
          "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
          [email]
        );
        return account.rows[0].id;
      }
      fullAccessUserId = await makeUser(`e2e-full-access-${stamp}@example.com`);
      viewOnlyUserId = await makeUser(`e2e-view-only-${stamp}@example.com`);

      async function assign(userAccountId: string, roleKey: string) {
        const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
        await client.query(
          "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
          [userAccountId, companyId, role.rows[0].id]
        );
      }
      await assign(fullAccessUserId, "rbac_demo_full_access");
      await assign(viewOnlyUserId, "rbac_demo_view_only");

      const record = await client.query(
        `INSERT INTO dummy_records (company_id, owner_user_account_id, title, status, test_field, secret_field)
         VALUES ($1, $2, 'E2E test record', 'unlocked', 'visible-to-full-access-only', 'also-gated')
         RETURNING id`,
        [companyId, fullAccessUserId]
      );
      recordId = record.rows[0].id;
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      await client.query("DELETE FROM companies WHERE id = $1", [companyId]);
      await client.query("DELETE FROM user_accounts WHERE id = ANY($1::uuid[])", [
        [fullAccessUserId, viewOnlyUserId],
      ]);
    });
    await pool.end();
    await app.close();
  });

  it("rejects a request with no bearer token", async () => {
    await request(app.getHttpServer()).get("/rbac-demo/dummy-records").expect(401);
  });

  it("includes testField in the raw JSON for the full-access role", async () => {
    const token = signSession({ sub: fullAccessUserId, is_platform_admin: false, company_id: companyId });
    const res = await request(app.getHttpServer())
      .get("/rbac-demo/dummy-records")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const record = res.body.find((r: { id: string }) => r.id === recordId);
    expect(record).toBeDefined();
    expect(record.testField).toBe("visible-to-full-access-only");
    expect(record.secretField).toBe("also-gated"); // status is 'unlocked'
  });

  it("omits testField and secretField entirely from the raw JSON for the view-only role", async () => {
    const token = signSession({ sub: viewOnlyUserId, is_platform_admin: false, company_id: companyId });
    const res = await request(app.getHttpServer())
      .get("/rbac-demo/dummy-records")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const record = res.body.find((r: { id: string }) => r.id === recordId);
    expect(record).toBeDefined();
    // The literal exit-criterion assertion: the key is ABSENT, not null.
    expect(Object.prototype.hasOwnProperty.call(record, "testField")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(record, "secretField")).toBe(false);
    expect(JSON.stringify(record)).not.toContain("visible-to-full-access-only");
    expect(JSON.stringify(record)).not.toContain("also-gated");
  });

  it("GET /rbac-demo/dummy-records/:id 404s (not 403) for a record the caller has no access to at all", async () => {
    // A Platform-Admin-shaped token has no company_id, so it holds no
    // role assignment in this tenant at all — see rbac.service.ts's doc
    // comment on why that's by design, not an oversight.
    const token = signSession({ sub: "platform-admin-probe", is_platform_admin: true, company_id: null });
    await request(app.getHttpServer())
      .get(`/rbac-demo/dummy-records/${recordId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(404);
  });

  /**
   * Phase 5's own exit criterion, proved at the exact same HTTP layer as
   * Phase 4's: "disabling a module for a test tenant... 404s on direct
   * API access." Same full-access role, same record, only the module's
   * entitlement changes — a 403 here would mean the licensing gate leaked
   * "this exists but you're blocked" instead of "this doesn't exist,"
   * which plan doc Section 4 is explicit is the wrong shape.
   */
  describe("module licensing gate (Phase 5)", () => {
    const disable = () =>
      db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query(
          `UPDATE tenant_module_entitlement SET enabled = false WHERE company_id = $1 AND module_key = 'dummy'`,
          [companyId]
        )
      );
    const enable = () =>
      db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query(
          `UPDATE tenant_module_entitlement SET enabled = true WHERE company_id = $1 AND module_key = 'dummy'`,
          [companyId]
        )
      );

    afterEach(enable); // leave the fixture company in its normal state for any later test

    it("404s the list endpoint once the module is disabled, and recovers once it's re-enabled", async () => {
      const token = signSession({ sub: fullAccessUserId, is_platform_admin: false, company_id: companyId });

      await request(app.getHttpServer())
        .get("/rbac-demo/dummy-records")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      await disable();
      await request(app.getHttpServer())
        .get("/rbac-demo/dummy-records")
        .set("Authorization", `Bearer ${token}`)
        .expect(404);

      await enable();
      await request(app.getHttpServer())
        .get("/rbac-demo/dummy-records")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
    });

    it("404s GET /:id for the same full-access role that could see it a moment ago", async () => {
      const token = signSession({ sub: fullAccessUserId, is_platform_admin: false, company_id: companyId });

      await request(app.getHttpServer())
        .get(`/rbac-demo/dummy-records/${recordId}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      await disable();
      await request(app.getHttpServer())
        .get(`/rbac-demo/dummy-records/${recordId}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);
    });
  });
});
