import { randomUUID } from "crypto";
import { Pool } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "./entitlements.service";

/**
 * Plan doc Section 4's FIRST enforcement gate ("is the module even
 * licensed"), Phase 5's own exit criterion in miniature: a module a
 * company's tier includes by default is enabled; disabling it makes
 * isModuleEnabled() say so immediately; a Platform-Admin-shaped session
 * never gets a bypass. dummy.e2e.spec.ts proves the same thing one layer
 * up, through the real HTTP stack against the 'dummy' module specifically.
 *
 * Fixtures are written under Platform-Admin-shaped claims — same reasoning
 * as rbac.service.spec.ts: companies_write's INSERT policy only grants
 * `is_platform_admin()`, not `is_service()`.
 */
const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "entitlements-spec-fixtures",
};

describe("EntitlementsService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let entitlements: EntitlementsService;

  let starterCompanyId: string;
  let starterClaims: RequestClaims;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    entitlements = new EntitlementsService(db);

    const stamp = Date.now();
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query(
        "INSERT INTO companies (name, slug, package_tier) VALUES ($1, $2, 'starter') RETURNING id",
        [`Entitlements Spec Co ${stamp}`, `entitlements-spec-${stamp}`]
      );
      starterCompanyId = company.rows[0].id;
      // seedForNewCompany is exercised directly by its own describe block
      // below — this fixture row is seeded here via the same package-tier
      // defaults path so the "isModuleEnabled" describe block has a
      // company whose entitlement rows already exist going in.
      await entitlements.seedForNewCompany(client, starterCompanyId, "starter");
    });

    starterClaims = { is_platform_admin: false, company_id: starterCompanyId, sub: randomUUID() };
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      await client.query("DELETE FROM companies WHERE id = $1", [starterCompanyId]); // cascades entitlement rows
    });
    await pool.end();
  });

  describe("isModuleEnabled() — the actual gate", () => {
    it("is true for a module the starter tier includes by default ('dummy')", async () => {
      expect(await entitlements.isModuleEnabled(starterClaims, "dummy")).toBe(true);
    });

    it("is false for a module the starter tier does NOT include ('payroll')", async () => {
      expect(await entitlements.isModuleEnabled(starterClaims, "payroll")).toBe(false);
    });

    it("flips to false immediately after a Platform Admin disables the module", async () => {
      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        await entitlements.setEnabledModules(client, starterCompanyId, ["employee", "leave"]); // drops 'dummy'
      });
      expect(await entitlements.isModuleEnabled(starterClaims, "dummy")).toBe(false);

      // restore, so later tests in this file see the fixture as originally seeded
      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        await entitlements.setEnabledModules(client, starterCompanyId, ["employee", "leave", "dummy"]);
      });
      expect(await entitlements.isModuleEnabled(starterClaims, "dummy")).toBe(true);
    });

    it("is false for a Platform-Admin-shaped session (no company_id, no bypass)", async () => {
      const platformAdminShaped: RequestClaims = { is_platform_admin: true, company_id: null, sub: randomUUID() };
      expect(await entitlements.isModuleEnabled(platformAdminShaped, "dummy")).toBe(false);
    });

    it("is false for a module with no entitlement row at all (safe-deny, not silently allowed)", async () => {
      expect(await entitlements.isModuleEnabled(starterClaims, "succession")).toBe(false);
    });
  });

  describe("seedForNewCompany() — package-tier defaults vs. an explicit override", () => {
    it("uses the package tier's default module set when no explicit list is given", async () => {
      const stamp = Date.now();
      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const company = await client.query(
          "INSERT INTO companies (name, slug, package_tier) VALUES ($1, $2, 'enterprise') RETURNING id",
          [`Entitlements Seed Co ${stamp}`, `entitlements-seed-${stamp}`]
        );
        const companyId = company.rows[0].id;

        const keys = await entitlements.seedForNewCompany(client, companyId, "enterprise");
        // Every module in the catalog is in the enterprise tier's default set.
        expect(keys).toEqual(
          expect.arrayContaining(["employee", "leave", "recruitment", "payroll", "succession", "dummy"])
        );

        await client.query("DELETE FROM companies WHERE id = $1", [companyId]);
      });
    });

    it("uses the explicit list instead of the tier's defaults when one is given", async () => {
      const stamp = Date.now();
      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const company = await client.query(
          "INSERT INTO companies (name, slug, package_tier) VALUES ($1, $2, 'starter') RETURNING id",
          [`Entitlements Seed Override Co ${stamp}`, `entitlements-seed-override-${stamp}`]
        );
        const companyId = company.rows[0].id;

        // starter's default set is [employee, leave, dummy] — override with
        // just one module the tier wouldn't normally include.
        const keys = await entitlements.seedForNewCompany(client, companyId, "starter", ["bi"]);
        expect(keys).toEqual(["bi"]);

        await client.query("DELETE FROM companies WHERE id = $1", [companyId]);
      });
    });
  });
});
