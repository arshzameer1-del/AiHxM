import { Pool } from "pg";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { OrgUnitsService } from "./org-units.service";
import { ProfitCentersService } from "./profit-centers.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "profit-centers-spec-fixtures" };

/**
 * Organization Management, Phase 4 (see the Master Engineering
 * Instruction doc's Section 14, and 0073_locations_and_financial_centers.sql).
 * Proven the same way JobsService was — real Postgres, no mocks — flat
 * catalog CRUD, effective-dating/versioning, RBAC, tenant isolation, and
 * the optional org-unit link.
 */
describe("ProfitCentersService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let profitCenters: ProfitCentersService;
  let orgUnits: OrgUnitsService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    profitCenters = new ProfitCentersService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    orgUnits = new OrgUnitsService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createFixtureCompany(namePrefix: string) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `${namePrefix} ${stamp}`,
        `${namePrefix.toLowerCase().replace(/\s+/g, "-")}-${stamp}`,
      ]);
      const companyId = company.rows[0].id;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [companyId]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [
        companyId,
      ]);
      return companyId as string;
    });
  }

  async function createUser(email: string) {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        email,
      ]);
      return result.rows[0].id as string;
    });
  }

  async function assignRole(userAccountId: string, companyId: string, roleKey: string) {
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
      await client.query(
        "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
        [userAccountId, companyId, role.rows[0].id]
      );
    });
  }

  describe("catalog CRUD, effective-dating, and RBAC", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let managerClaims: RequestClaims;
    let engineeringId: string;
    let engineeringProfitCenterId: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Profit Center Co");
      const stamp = Date.now();
      const hrAdminUserId = await createUser(`profit-center-hr-${stamp}@example.com`);
      const managerUserId = await createUser(`profit-center-mgr-${stamp}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      await assignRole(managerUserId, companyId, "line_manager");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      managerClaims = { is_platform_admin: false, company_id: companyId, sub: managerUserId };

      engineeringId = (await orgUnits.create(hrAdminClaims, { name: "Engineering", unitType: "division" })).id;
      engineeringProfitCenterId = (
        await profitCenters.create(hrAdminClaims, { name: "Engineering Profit Center", code: "PC-ENG", orgUnitId: engineeringId })
      ).id;
    });

    it("creates a profit center with an initial version effective today", async () => {
      const profitCenter = await profitCenters.get(hrAdminClaims, engineeringProfitCenterId);
      expect(profitCenter).toMatchObject({
        name: "Engineering Profit Center",
        code: "PC-ENG",
        orgUnitId: engineeringId,
        status: "active",
      });

      const history = await profitCenters.getHistory(hrAdminClaims, engineeringProfitCenterId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ name: "Engineering Profit Center", effectiveTo: null });
    });

    it("rejects a duplicate code within the same tenant", async () => {
      await expect(
        profitCenters.create(hrAdminClaims, { name: "Duplicate Code Profit Center", code: "PC-ENG" })
      ).rejects.toThrow(ConflictException);
    });

    it("allows a profit center with no code or orgUnitId at all — neither is required", async () => {
      const minimal = await profitCenters.create(hrAdminClaims, { name: "Minimal Profit Center" });
      expect(minimal).toMatchObject({ name: "Minimal Profit Center", code: null, orgUnitId: null });
    });

    it("404s when creating with a nonexistent orgUnitId", async () => {
      await expect(
        profitCenters.create(hrAdminClaims, { name: "Orphan Profit Center", orgUnitId: "00000000-0000-0000-0000-000000000000" })
      ).rejects.toThrow(NotFoundException);
    });

    it("list() returns every profit center in the tenant, alphabetical", async () => {
      const list = await profitCenters.list(hrAdminClaims);
      const names = list.map((c) => c.name);
      expect(names).toEqual([...names].sort());
      expect(names).toContain("Engineering Profit Center");
    });

    it("update() renames in place and opens a new version (unless same-day, then collapses)", async () => {
      const updated = await profitCenters.update(hrAdminClaims, engineeringProfitCenterId, { name: "Engineering Profit Center (Renamed)" });
      expect(updated.name).toBe("Engineering Profit Center (Renamed)");
      const history = await profitCenters.getHistory(hrAdminClaims, engineeringProfitCenterId);
      expect(history).toHaveLength(1);
      expect(history[0].name).toBe("Engineering Profit Center (Renamed)");
    });

    it("update(): orgUnitId: null explicitly clears the link", async () => {
      const cleared = await profitCenters.update(hrAdminClaims, engineeringProfitCenterId, { orgUnitId: null });
      expect(cleared.orgUnitId).toBeNull();
      // Restore for the remaining tests in this block.
      await profitCenters.update(hrAdminClaims, engineeringProfitCenterId, { orgUnitId: engineeringId });
    });

    it("archive()/activate() toggle status", async () => {
      const archived = await profitCenters.archive(hrAdminClaims, engineeringProfitCenterId);
      expect(archived.status).toBe("archived");
      const reactivated = await profitCenters.activate(hrAdminClaims, engineeringProfitCenterId);
      expect(reactivated.status).toBe("active");
    });

    it("404s on a nonexistent profit center id", async () => {
      await expect(profitCenters.get(hrAdminClaims, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(
        NotFoundException
      );
    });

    it("a Line Manager (profit_center.view.all only) can read the catalog but not mutate it", async () => {
      const list = await profitCenters.list(managerClaims);
      expect(list.length).toBeGreaterThan(0);
      await expect(profitCenters.create(managerClaims, { name: "Nope" })).rejects.toThrow(ForbiddenException);
      await expect(profitCenters.update(managerClaims, engineeringProfitCenterId, { name: "Nope" })).rejects.toThrow(
        ForbiddenException
      );
    });

    it("404s the whole module when `employee` is disabled for the tenant", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = false WHERE company_id = $1 AND module_key = 'employee'", [
          companyId,
        ])
      );
      await expect(profitCenters.list(hrAdminClaims)).rejects.toThrow(NotFoundException);
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = true WHERE company_id = $1 AND module_key = 'employee'", [
          companyId,
        ])
      );
    });
  });

  describe("tenant isolation (RLS)", () => {
    it("a profit center created in one tenant is invisible to another tenant's session", async () => {
      const companyAId = await createFixtureCompany("Profit Center Isolation A");
      const companyBId = await createFixtureCompany("Profit Center Isolation B");
      const hrAdminA = await createUser(`profit-center-iso-a-${Date.now()}@example.com`);
      const hrAdminB = await createUser(`profit-center-iso-b-${Date.now()}@example.com`);
      await assignRole(hrAdminA, companyAId, "hr_admin");
      await assignRole(hrAdminB, companyBId, "hr_admin");
      const claimsA: RequestClaims = { is_platform_admin: false, company_id: companyAId, sub: hrAdminA };
      const claimsB: RequestClaims = { is_platform_admin: false, company_id: companyBId, sub: hrAdminB };

      const profitCenterA = await profitCenters.create(claimsA, { name: "A-Only Profit Center" });

      await expect(profitCenters.get(claimsB, profitCenterA.id)).rejects.toThrow(NotFoundException);
      const listB = await profitCenters.list(claimsB);
      expect(listB.find((c) => c.id === profitCenterA.id)).toBeUndefined();
    });
  });
});
