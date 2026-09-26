import { Pool } from "pg";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { DataScopeAssignmentsService } from "./data-scope-assignments.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "data-scope-spec-fixtures" };

/**
 * Organization Management Phase 11 (Unified Integration & Synchronization
 * Requirements, Section 19) — proves `DataScopeAssignmentsService` itself:
 * the entity-existence validation `RbacService.resolveDataScopeEntityIds()`
 * relies on the DB layer for, conflict/duplicate handling, and revoke.
 * (`RbacService`'s own read-side behavior — resolving a caller's rows back
 * out — is covered in `rbac.service.spec.ts`; the scoped `list()`/`get()`
 * behavior each Organization Management object gets from this data is
 * covered in that object's own spec file, e.g. `org-units.service.spec.ts`'s
 * "Data Scope" describe block. Org units here are seeded via a direct
 * INSERT, not `OrgUnitsService.create()`, since this suite only needs a
 * real row to validate against — matching this codebase's own established
 * "raw-SQL fixture for cross-entity data a spec file doesn't otherwise
 * need a whole service for" convention.)
 */
describe("DataScopeAssignmentsService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let dataScopeAssignments: DataScopeAssignmentsService;

  let companyId: string;
  let userAccountId: string;
  let orgUnitId: string;
  let secondOrgUnitId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    dataScopeAssignments = new DataScopeAssignmentsService(db, new AuditService());

    const stamp = Date.now();
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Data Scope Assignments Co ${stamp}`,
        `data-scope-assignments-co-${stamp}`,
      ]);
      companyId = company.rows[0].id;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [companyId]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [
        companyId,
      ]);
      const account = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
        [`data-scope-target-${stamp}@example.com`]
      );
      userAccountId = account.rows[0].id;
      const unit = await client.query(
        "INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', 'Data Scope Fixture Unit A') RETURNING id",
        [companyId]
      );
      orgUnitId = unit.rows[0].id;
      const secondUnit = await client.query(
        "INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', 'Data Scope Fixture Unit B') RETURNING id",
        [companyId]
      );
      secondOrgUnitId = secondUnit.rows[0].id;
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("assign() creates the row, validating the entity exists in this company's own table", async () => {
    const created = await dataScopeAssignments.assign(FIXTURE_CLAIMS, {
      userAccountId,
      companyId,
      scopeType: "org_unit",
      scopeEntityId: orgUnitId,
    });
    expect(created).toMatchObject({ userAccountId, companyId, scopeType: "org_unit", scopeEntityId: orgUnitId });

    const listed = await dataScopeAssignments.list(FIXTURE_CLAIMS, companyId, userAccountId);
    expect(listed.map((row) => row.id)).toContain(created.id);
  });

  it("assign() 404s when the entity doesn't exist in this company (wrong scope_type table, or a nonexistent id)", async () => {
    await expect(
      dataScopeAssignments.assign(FIXTURE_CLAIMS, {
        userAccountId,
        companyId,
        scopeType: "org_unit",
        scopeEntityId: "00000000-0000-0000-0000-000000000000",
      })
    ).rejects.toThrow(NotFoundException);

    // A real org unit id, but asked for as if it were a cost_center —
    // proves the scope_type -> table mapping is actually enforced, not
    // just "does this uuid exist somewhere".
    await expect(
      dataScopeAssignments.assign(FIXTURE_CLAIMS, {
        userAccountId,
        companyId,
        scopeType: "cost_center",
        scopeEntityId: orgUnitId,
      })
    ).rejects.toThrow(NotFoundException);
  });

  it("assign() rejects an exact duplicate assignment", async () => {
    await expect(
      dataScopeAssignments.assign(FIXTURE_CLAIMS, {
        userAccountId,
        companyId,
        scopeType: "org_unit",
        scopeEntityId: orgUnitId,
      })
    ).rejects.toThrow(ConflictException);
  });

  it("revoke() removes the row; a second revoke 404s", async () => {
    const created = await dataScopeAssignments.assign(FIXTURE_CLAIMS, {
      userAccountId,
      companyId,
      scopeType: "org_unit",
      scopeEntityId: secondOrgUnitId,
    });

    await dataScopeAssignments.revoke(FIXTURE_CLAIMS, created.id);
    const afterRevoke = await dataScopeAssignments.list(FIXTURE_CLAIMS, companyId, userAccountId);
    expect(afterRevoke.map((row) => row.id)).not.toContain(created.id);

    await expect(dataScopeAssignments.revoke(FIXTURE_CLAIMS, created.id)).rejects.toThrow(NotFoundException);
  });
});
