import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { EmployeesService } from "../employees/employees.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { LocationsService } from "./locations.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "locations-spec-fixtures" };

/**
 * Organization Management, Phase 4 (see
 * claude/organization-management-4000-gap-analysis-and-roadmap.md and
 * 0073_locations_and_financial_centers.sql). Proven the same way
 * OrgUnitsService was — real Postgres, no mocks — hierarchy CRUD, the
 * cycle guard on reparenting, RLS/tenant isolation, and the
 * location-sync-on-set behavior in EmployeesService.
 */
describe("LocationsService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let locations: LocationsService;
  let employees: EmployeesService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    locations = new LocationsService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
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

  describe("hierarchy CRUD, tree query, and move/archive", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let managerClaims: RequestClaims;
    let pakistanId: string;
    let karachiId: string;
    let lahoreOfficeId: string;
    let londonId: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Location Co");
      const stamp = Date.now();
      const hrAdminUserId = await createUser(`location-hr-${stamp}@example.com`);
      const managerUserId = await createUser(`location-mgr-${stamp}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      await assignRole(managerUserId, companyId, "line_manager");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      managerClaims = { is_platform_admin: false, company_id: companyId, sub: managerUserId };

      //        Pakistan (country)
      //         /              \
      //     Karachi (city)   Lahore Office (building)     London (root, sibling)
      pakistanId = (await locations.create(hrAdminClaims, { name: "Pakistan", locationType: "country", code: "PK" })).id;
      karachiId = (
        await locations.create(hrAdminClaims, { name: "Karachi", locationType: "city", parentId: pakistanId })
      ).id;
      lahoreOfficeId = (
        await locations.create(hrAdminClaims, { name: "Lahore Office", locationType: "building", parentId: pakistanId })
      ).id;
      londonId = (await locations.create(hrAdminClaims, { name: "London", locationType: "city" })).id;
    });

    it("creates a location with an initial version effective today", async () => {
      const location = await locations.get(hrAdminClaims, pakistanId);
      expect(location).toMatchObject({ name: "Pakistan", locationType: "country", code: "PK", status: "active", parentId: null });

      const history = await locations.getHistory(hrAdminClaims, pakistanId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ name: "Pakistan", effectiveTo: null });
    });

    it("rejects a duplicate code within the same tenant", async () => {
      await expect(
        locations.create(hrAdminClaims, { name: "Pakistan Duplicate", locationType: "country", code: "PK" })
      ).rejects.toThrow(ConflictException);
    });

    it("404s when creating under a nonexistent parent", async () => {
      await expect(
        locations.create(hrAdminClaims, { name: "Orphan", locationType: "city", parentId: "00000000-0000-0000-0000-000000000000" })
      ).rejects.toThrow(NotFoundException);
    });

    it("list() returns every location in the tenant, alphabetical", async () => {
      const list = await locations.list(hrAdminClaims);
      const names = list.map((l) => l.name);
      expect(names).toEqual([...names].sort());
      expect(names).toContain("Pakistan");
    });

    it("getTree nests the whole company's hierarchy", async () => {
      const tree = await locations.getTree(hrAdminClaims);
      const pakistanNode = tree.find((n) => n.id === pakistanId)!;
      expect(pakistanNode.children.map((c) => c.name).sort()).toEqual(["Karachi", "Lahore Office"]);
      const londonNode = tree.find((n) => n.id === londonId)!;
      expect(londonNode.children).toEqual([]);
    });

    it("update() renames in place and opens a new version (unless same-day, then collapses)", async () => {
      const updated = await locations.update(hrAdminClaims, londonId, { name: "London HQ" });
      expect(updated.name).toBe("London HQ");
      const history = await locations.getHistory(hrAdminClaims, londonId);
      expect(history).toHaveLength(1);
      expect(history[0].name).toBe("London HQ");
    });

    it("rejects parent_id = id (a location cannot be its own parent)", async () => {
      await expect(locations.move(hrAdminClaims, karachiId, { parentId: karachiId })).rejects.toThrow(BadRequestException);
    });

    it("rejects moving a location under its own descendant (cycle guard)", async () => {
      // Pakistan -> Karachi already exists; moving Pakistan under Karachi
      // would create a cycle and disconnect the whole subtree.
      await expect(locations.move(hrAdminClaims, pakistanId, { parentId: karachiId })).rejects.toThrow(BadRequestException);
      const stillRoot = await locations.get(hrAdminClaims, pakistanId);
      expect(stillRoot.parentId).toBeNull();
    });

    it("move() reparents a location and getTree reflects it immediately", async () => {
      const moved = await locations.move(hrAdminClaims, lahoreOfficeId, { parentId: null });
      expect(moved.parentId).toBeNull();

      const tree = await locations.getTree(hrAdminClaims);
      const pakistanNode = tree.find((n) => n.id === pakistanId)!;
      expect(pakistanNode.children.map((c) => c.id)).not.toContain(lahoreOfficeId);
      expect(tree.map((n) => n.id)).toContain(lahoreOfficeId);

      // Move it back so later tests in this block see the original shape.
      await locations.move(hrAdminClaims, lahoreOfficeId, { parentId: pakistanId });
    });

    it("archive()/activate() toggle status without touching the hierarchy", async () => {
      const archived = await locations.archive(hrAdminClaims, karachiId);
      expect(archived.status).toBe("archived");
      expect(archived.parentId).toBe(pakistanId);

      const reactivated = await locations.activate(hrAdminClaims, karachiId);
      expect(reactivated.status).toBe("active");
    });

    it("a Line Manager (location.view.all only) can read the hierarchy but not mutate it", async () => {
      const tree = await locations.getTree(managerClaims);
      expect(tree.length).toBeGreaterThan(0);
      await expect(locations.create(managerClaims, { name: "Nope", locationType: "city" })).rejects.toThrow(
        ForbiddenException
      );
      await expect(locations.update(managerClaims, londonId, { name: "Nope" })).rejects.toThrow(ForbiddenException);
    });

    it("404s the whole module when `employee` is disabled for the tenant", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = false WHERE company_id = $1 AND module_key = 'employee'", [
          companyId,
        ])
      );
      await expect(locations.getTree(hrAdminClaims)).rejects.toThrow(NotFoundException);
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = true WHERE company_id = $1 AND module_key = 'employee'", [
          companyId,
        ])
      );
    });
  });

  describe("tenant isolation (RLS)", () => {
    it("a location created in one tenant is invisible to another tenant's session", async () => {
      const companyAId = await createFixtureCompany("Location Isolation A");
      const companyBId = await createFixtureCompany("Location Isolation B");
      const hrAdminA = await createUser(`location-iso-a-${Date.now()}@example.com`);
      const hrAdminB = await createUser(`location-iso-b-${Date.now()}@example.com`);
      await assignRole(hrAdminA, companyAId, "hr_admin");
      await assignRole(hrAdminB, companyBId, "hr_admin");
      const claimsA: RequestClaims = { is_platform_admin: false, company_id: companyAId, sub: hrAdminA };
      const claimsB: RequestClaims = { is_platform_admin: false, company_id: companyBId, sub: hrAdminB };

      const locationA = await locations.create(claimsA, { name: "A-Only Location", locationType: "city" });

      await expect(locations.get(claimsB, locationA.id)).rejects.toThrow(NotFoundException);
      const treeB = await locations.getTree(claimsB);
      expect(treeB.find((n) => n.id === locationA.id)).toBeUndefined();
    });
  });

  describe("EmployeesService integration — location-sync-on-set", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let karachiId: string;
    let lahoreId: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Location Sync Co");
      const hrAdminUserId = await createUser(`location-sync-hr-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      karachiId = (await locations.create(hrAdminClaims, { name: "Karachi", locationType: "city" })).id;
      lahoreId = (await locations.create(hrAdminClaims, { name: "Lahore", locationType: "city" })).id;
    });

    it("create(): setting locationId derives `location` from the location's current name", async () => {
      const employee = await employees.create(hrAdminClaims, {
        firstName: "Synced",
        lastName: "Employee",
        locationId: karachiId,
        location: "This text should be ignored",
      });
      expect(employee.locationId).toBe(karachiId);
      expect(employee.location).toBe("Karachi");
    });

    it("update(): re-linking to a different location re-derives `location`", async () => {
      const created = await employees.create(hrAdminClaims, { firstName: "Move", lastName: "Me", locationId: karachiId });
      expect(created.location).toBe("Karachi");

      const updated = await employees.update(hrAdminClaims, created.id, { locationId: lahoreId });
      expect(updated.locationId).toBe(lahoreId);
      expect(updated.location).toBe("Lahore");
    });

    it("an employee with no locationId keeps the legacy free-text behavior completely unchanged", async () => {
      const created = await employees.create(hrAdminClaims, { firstName: "Free", lastName: "Text", location: "Remote" });
      expect(created.locationId).toBeNull();
      expect(created.location).toBe("Remote");

      const updated = await employees.update(hrAdminClaims, created.id, { location: "Fully Remote" });
      expect(updated.locationId).toBeNull();
      expect(updated.location).toBe("Fully Remote");
    });

    it("renaming a location does not retroactively change already-synced employees until they're re-saved", async () => {
      const created = await employees.create(hrAdminClaims, { firstName: "Stale", lastName: "Text", locationId: karachiId });
      await locations.update(hrAdminClaims, karachiId, { name: "Karachi (Renamed)" });
      const fetched = await employees.get(hrAdminClaims, created.id);
      expect(fetched.location).toBe("Karachi");

      // But the NEXT save re-derives it from the (now renamed) location.
      const resaved = await employees.update(hrAdminClaims, created.id, { locationId: karachiId });
      expect(resaved.location).toBe("Karachi (Renamed)");
    });

    it("rejects linking an employee to a nonexistent location", async () => {
      await expect(
        employees.create(hrAdminClaims, { firstName: "Bad", lastName: "Link", locationId: "00000000-0000-0000-0000-000000000000" })
      ).rejects.toThrow(BadRequestException);
    });
  });
});
