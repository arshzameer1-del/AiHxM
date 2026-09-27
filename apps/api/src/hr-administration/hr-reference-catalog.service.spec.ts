import { Pool } from "pg";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { HrReferenceCatalogService } from "./hr-reference-catalog.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "hr-catalog-spec-fixtures" };

/**
 * HR Administration reference-catalog engine (Core Employee Configuration/
 * HR-Admin v2, 2026-09-27) — real Postgres, no mocks, same discipline as
 * every other phase's own spec file. Covers: the registry-driven type
 * summary (including 0090's own seeded starter data), CRUD + reorder for
 * one company's items, the RBAC gate (`hr_reference_catalog.manage.all`/
 * `.view.all`, granted to hr_admin by that same migration), and
 * `validateActiveCode()` — the enforcement half `EmployeesService` and
 * `EmployeeLifecycleService` call into.
 */
describe("HrReferenceCatalogService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let catalog: HrReferenceCatalogService;
  let companyId: string;
  let hrAdminClaims: RequestClaims;
  let noPermissionClaims: RequestClaims;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    catalog = new HrReferenceCatalogService(db, new RbacService(db), new EntitlementsService(db), new AuditService());

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `HR Catalog Co ${stamp}`,
        `hr-catalog-co-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [id]);
      // 0090's own seed only ran for companies that existed at migration
      // time — this fixture company is created after, so it seeds itself
      // the same starter rows the migration gives every pre-existing
      // company, keeping this spec's assertions valid regardless of when
      // it runs relative to that migration.
      await client.query(
        `INSERT INTO hr_reference_catalog_items (company_id, catalog_type, code, label, sort_order) VALUES
           ($1, 'employment_type', 'permanent', 'Permanent', 0),
           ($1, 'employment_type', 'contract', 'Contract', 1),
           ($1, 'lifecycle_reason:termination', 'resignation', 'Resignation', 0)`,
        [id]
      );
      return id;
    });

    const hrAdminUserId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        `hr-catalog-admin-${stamp}@example.com`,
      ]);
      return result.rows[0].id as string;
    });
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const role = await client.query("SELECT id FROM roles WHERE key = 'hr_admin'");
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [
        hrAdminUserId,
        companyId,
        role.rows[0].id,
      ]);
    });
    hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

    const outsiderUserId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        `hr-catalog-outsider-${stamp}@example.com`,
      ]);
      return result.rows[0].id as string;
    });
    noPermissionClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };
  });

  afterAll(async () => {
    await pool.end();
  });

  it("lists every registered catalog type with this company's active-item counts", async () => {
    const types = await catalog.listCatalogTypes(hrAdminClaims);
    const employmentType = types.find((t) => t.catalogType === "employment_type");
    expect(employmentType?.activeCount).toBe(2);
    expect(employmentType?.groupLabel).toBe("Employment & Workforce Setup");
    const terminationReasons = types.find((t) => t.catalogType === "lifecycle_reason:termination");
    expect(terminationReasons?.activeCount).toBe(1);
    // A catalog type with no seeded rows for THIS company still appears,
    // at zero — the registry drives the listing, not the data.
    const hireReasons = types.find((t) => t.catalogType === "lifecycle_reason:hire");
    expect(hireReasons?.activeCount).toBe(0);
  });

  it("rejects a request for a catalog type that isn't registered", async () => {
    await expect(catalog.listItems(hrAdminClaims, "not_a_real_catalog_type")).rejects.toThrow(BadRequestException);
  });

  it("lists only active items in sort order by default", async () => {
    const items = await catalog.listItems(hrAdminClaims, "employment_type");
    expect(items.map((i) => i.code)).toEqual(["permanent", "contract"]);
  });

  it("creates a new item, appended after the existing sort order", async () => {
    const created = await catalog.create(hrAdminClaims, {
      catalogType: "employment_type",
      code: "probation",
      label: "Probationary",
    });
    expect(created.sortOrder).toBe(2);
    expect(created.isActive).toBe(true);

    const items = await catalog.listItems(hrAdminClaims, "employment_type");
    expect(items.map((i) => i.code)).toEqual(["permanent", "contract", "probation"]);
  });

  it("rejects creating a duplicate code within the same catalog type for this company", async () => {
    await expect(
      catalog.create(hrAdminClaims, { catalogType: "employment_type", code: "permanent", label: "Duplicate" })
    ).rejects.toThrow(BadRequestException);
  });

  it("updates an item's label/description and can deactivate it", async () => {
    const created = await catalog.create(hrAdminClaims, {
      catalogType: "employment_type",
      code: "intern",
      label: "Intern",
    });
    const updated = await catalog.update(hrAdminClaims, created.id, { label: "Internship", isActive: false });
    expect(updated.label).toBe("Internship");
    expect(updated.isActive).toBe(false);

    const active = await catalog.listItems(hrAdminClaims, "employment_type");
    expect(active.find((i) => i.id === created.id)).toBeUndefined();

    const all = await catalog.listItems(hrAdminClaims, "employment_type", true);
    expect(all.find((i) => i.id === created.id)?.isActive).toBe(false);
  });

  it("reorders items within a catalog type", async () => {
    const items = await catalog.listItems(hrAdminClaims, "employment_type");
    const reversed = [...items].reverse().map((i) => i.id);
    const reordered = await catalog.reorder(hrAdminClaims, "employment_type", reversed);
    expect(reordered.map((i) => i.id)).toEqual(reversed);
  });

  it("validateActiveCode passes for an active code and throws for an unknown or deactivated one", async () => {
    await db.withClaims(hrAdminClaims, async (client) => {
      await expect(catalog.validateActiveCode(client, companyId, "employment_type", "permanent")).resolves.toBeUndefined();
      await expect(catalog.validateActiveCode(client, companyId, "employment_type", undefined)).resolves.toBeUndefined();
      await expect(catalog.validateActiveCode(client, companyId, "employment_type", "not_a_real_code")).rejects.toThrow(
        BadRequestException
      );
    });
  });

  it("denies a login without hr_reference_catalog permissions", async () => {
    await expect(catalog.listCatalogTypes(noPermissionClaims)).rejects.toThrow(ForbiddenException);
    await expect(catalog.create(noPermissionClaims, { catalogType: "employment_type", code: "x", label: "X" })).rejects.toThrow(
      ForbiddenException
    );
  });
});
