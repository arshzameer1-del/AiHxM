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
import { OrgRelationshipsService } from "./org-relationships.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "relationships-spec-fixtures" };

/**
 * Organization Management, Phase 3 (see the Master Engineering
 * Instruction doc's Section 12, and
 * 0071_employee_org_assignments_and_relationships.sql). Real Postgres, no
 * mocks — the two things this entity actually adds over every other
 * Organization Management entity so far: cycle prevention on `direct`
 * reporting chains, and the point-in-time `employees.managerId` sync this
 * service is the sole new writer of (matched against
 * PositionsService.assignEmployee()'s own `employees.positionId` precedent
 * for rigor).
 */
describe("OrgRelationshipsService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let employees: EmployeesService;
  let relationships: OrgRelationshipsService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
    relationships = new OrgRelationshipsService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
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

  describe("CRUD, effective-dating, one-open-direct, cycle prevention, manager_id sync, and RBAC", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let managerClaims: RequestClaims;
    let alice: string;
    let bob: string;
    let carol: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Relationship Co");
      const stamp = Date.now();
      const hrAdminUserId = await createUser(`rel-hr-${stamp}@example.com`);
      const managerUserId = await createUser(`rel-mgr-${stamp}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      await assignRole(managerUserId, companyId, "line_manager");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      managerClaims = { is_platform_admin: false, company_id: companyId, sub: managerUserId };

      alice = (await employees.create(hrAdminClaims, { firstName: "Alice", lastName: "Report" })).id;
      bob = (await employees.create(hrAdminClaims, { firstName: "Bob", lastName: "Manager" })).id;
      carol = (await employees.create(hrAdminClaims, { firstName: "Carol", lastName: "Director" })).id;
    });

    it("creates a direct relationship and syncs employees.managerId", async () => {
      const relationship = await relationships.create(hrAdminClaims, {
        employeeId: alice,
        managerEmployeeId: bob,
        relationshipType: "direct",
      });
      expect(relationship).toMatchObject({
        employeeId: alice,
        managerEmployeeId: bob,
        relationshipType: "direct",
        status: "active",
      });

      const aliceRecord = await employees.get(hrAdminClaims, alice);
      expect(aliceRecord.managerId).toBe(bob);

      const history = await relationships.getHistory(hrAdminClaims, relationship.id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ status: "active", effectiveTo: null });
    });

    it("rejects self-management", async () => {
      await expect(
        relationships.create(hrAdminClaims, { employeeId: alice, managerEmployeeId: alice, relationshipType: "direct" })
      ).rejects.toThrow(BadRequestException);
    });

    it("404s creating against a nonexistent employee/manager", async () => {
      await expect(
        relationships.create(hrAdminClaims, {
          employeeId: "00000000-0000-0000-0000-000000000000",
          managerEmployeeId: bob,
          relationshipType: "direct",
        })
      ).rejects.toThrow(NotFoundException);
      await expect(
        relationships.create(hrAdminClaims, {
          employeeId: alice,
          managerEmployeeId: "00000000-0000-0000-0000-000000000000",
          relationshipType: "dotted_line",
        })
      ).rejects.toThrow(NotFoundException);
    });

    describe("one open direct relationship per employee, many open of everything else", () => {
      it("rejects a second open direct relationship for the same employee", async () => {
        const dave = (await employees.create(hrAdminClaims, { firstName: "Dave", lastName: "Employee" })).id;
        await relationships.create(hrAdminClaims, { employeeId: dave, managerEmployeeId: bob, relationshipType: "direct" });

        await expect(
          relationships.create(hrAdminClaims, { employeeId: dave, managerEmployeeId: carol, relationshipType: "direct" })
        ).rejects.toThrow(ConflictException);
      });

      it("allows multiple concurrently-open non-direct relationships for the same employee", async () => {
        const erin = (await employees.create(hrAdminClaims, { firstName: "Erin", lastName: "Employee" })).id;
        const dotted = await relationships.create(hrAdminClaims, { employeeId: erin, managerEmployeeId: bob, relationshipType: "dotted_line" });
        const matrix = await relationships.create(hrAdminClaims, { employeeId: erin, managerEmployeeId: carol, relationshipType: "matrix" });

        const list = await relationships.list(hrAdminClaims, { employeeId: erin, status: "active" });
        expect(list.map((r) => r.id).sort()).toEqual([dotted.id, matrix.id].sort());
      });

      it("allows a direct AND several non-direct relationships to coexist for the same employee", async () => {
        const frank = (await employees.create(hrAdminClaims, { firstName: "Frank", lastName: "Employee" })).id;
        await relationships.create(hrAdminClaims, { employeeId: frank, managerEmployeeId: bob, relationshipType: "direct" });
        await relationships.create(hrAdminClaims, { employeeId: frank, managerEmployeeId: carol, relationshipType: "acting" });

        const list = await relationships.list(hrAdminClaims, { employeeId: frank });
        expect(list).toHaveLength(2);
      });
    });

    describe("cycle prevention (A -> B -> C -> A rejected)", () => {
      it("rejects an edge that would immediately close a 2-hop cycle", async () => {
        const x = (await employees.create(hrAdminClaims, { firstName: "X", lastName: "Cycle" })).id;
        const y = (await employees.create(hrAdminClaims, { firstName: "Y", lastName: "Cycle" })).id;
        // X reports to Y.
        await relationships.create(hrAdminClaims, { employeeId: x, managerEmployeeId: y, relationshipType: "direct" });
        // Y reporting to X would close a 2-hop cycle (X -> Y -> X).
        await expect(
          relationships.create(hrAdminClaims, { employeeId: y, managerEmployeeId: x, relationshipType: "direct" })
        ).rejects.toThrow(BadRequestException);
      });

      it("rejects an edge that would close a longer 3-hop cycle (A -> B -> C -> A)", async () => {
        const a = (await employees.create(hrAdminClaims, { firstName: "A", lastName: "Cycle3" })).id;
        const b = (await employees.create(hrAdminClaims, { firstName: "B", lastName: "Cycle3" })).id;
        const c = (await employees.create(hrAdminClaims, { firstName: "C", lastName: "Cycle3" })).id;
        // A -> B -> C (A reports to B, B reports to C).
        await relationships.create(hrAdminClaims, { employeeId: a, managerEmployeeId: b, relationshipType: "direct" });
        await relationships.create(hrAdminClaims, { employeeId: b, managerEmployeeId: c, relationshipType: "direct" });
        // C -> A would close the loop A -> B -> C -> A.
        await expect(
          relationships.create(hrAdminClaims, { employeeId: c, managerEmployeeId: a, relationshipType: "direct" })
        ).rejects.toThrow(BadRequestException);

        // The valid, non-cyclic chain itself must still be readable.
        const bChain = await relationships.list(hrAdminClaims, { employeeId: b, relationshipType: "direct" });
        expect(bChain).toHaveLength(1);
      });

      it("does NOT reject an equivalent non-direct relationship type (cycle guard is direct-only)", async () => {
        const p = (await employees.create(hrAdminClaims, { firstName: "P", lastName: "NonDirect" })).id;
        const q = (await employees.create(hrAdminClaims, { firstName: "Q", lastName: "NonDirect" })).id;
        await relationships.create(hrAdminClaims, { employeeId: p, managerEmployeeId: q, relationshipType: "dotted_line" });
        // A reciprocal dotted_line edge is not a "manager" cycle in the
        // direct-reporting sense this guard protects — it's allowed.
        const reciprocal = await relationships.create(hrAdminClaims, {
          employeeId: q,
          managerEmployeeId: p,
          relationshipType: "dotted_line",
        });
        expect(reciprocal.status).toBe("active");
      });

      it("update() also runs the cycle guard when reassigning a direct relationship's manager", async () => {
        const e1 = (await employees.create(hrAdminClaims, { firstName: "E1", lastName: "UpdateCycle" })).id;
        const e2 = (await employees.create(hrAdminClaims, { firstName: "E2", lastName: "UpdateCycle" })).id;
        const e3 = (await employees.create(hrAdminClaims, { firstName: "E3", lastName: "UpdateCycle" })).id;
        // E1 -> E2 (E1 reports to E2), E2 -> E3 (E2 reports to E3).
        await relationships.create(hrAdminClaims, { employeeId: e1, managerEmployeeId: e2, relationshipType: "direct" });
        const e2ToE3 = await relationships.create(hrAdminClaims, { employeeId: e2, managerEmployeeId: e3, relationshipType: "direct" });

        // Reassigning E2's manager to E1 would close the loop
        // E2 -> E1 -> E2 (E1's manager is already E2).
        await expect(relationships.update(hrAdminClaims, e2ToE3.id, { managerEmployeeId: e1 })).rejects.toThrow(
          BadRequestException
        );

        // A non-cyclic reassignment still succeeds.
        const e4 = (await employees.create(hrAdminClaims, { firstName: "E4", lastName: "UpdateCycle" })).id;
        const reassigned = await relationships.update(hrAdminClaims, e2ToE3.id, { managerEmployeeId: e4 });
        expect(reassigned.managerEmployeeId).toBe(e4);
      });
    });

    describe("employees.managerId sync — the core backward-compatibility contract", () => {
      it("update() re-syncs employees.managerId when the manager changes", async () => {
        const target = (await employees.create(hrAdminClaims, { firstName: "Sync", lastName: "Target" })).id;
        const relationship = await relationships.create(hrAdminClaims, { employeeId: target, managerEmployeeId: bob, relationshipType: "direct" });
        expect((await employees.get(hrAdminClaims, target)).managerId).toBe(bob);

        await relationships.update(hrAdminClaims, relationship.id, { managerEmployeeId: carol });
        expect((await employees.get(hrAdminClaims, target)).managerId).toBe(carol);
      });

      it("end() clears employees.managerId back to null for a direct relationship", async () => {
        const target = (await employees.create(hrAdminClaims, { firstName: "EndSync", lastName: "Target" })).id;
        const relationship = await relationships.create(hrAdminClaims, { employeeId: target, managerEmployeeId: bob, relationshipType: "direct" });
        expect((await employees.get(hrAdminClaims, target)).managerId).toBe(bob);

        await relationships.end(hrAdminClaims, relationship.id);
        expect((await employees.get(hrAdminClaims, target)).managerId).toBeNull();
      });

      it("end() on a non-direct relationship never touches employees.managerId", async () => {
        const target = (await employees.create(hrAdminClaims, {
          firstName: "NonDirectEnd",
          lastName: "Target",
          managerId: bob,
        })).id;
        const relationship = await relationships.create(hrAdminClaims, { employeeId: target, managerEmployeeId: carol, relationshipType: "matrix" });
        await relationships.end(hrAdminClaims, relationship.id);

        // The legacy-set managerId (bob) is untouched by ending an
        // unrelated matrix relationship.
        expect((await employees.get(hrAdminClaims, target)).managerId).toBe(bob);
      });

      it("legacy EmployeesService.create()/update() managerId writes do not create an org_relationships row (documented gap)", async () => {
        const legacyTarget = await employees.create(hrAdminClaims, { firstName: "Legacy", lastName: "Path", managerId: bob });
        expect(legacyTarget.managerId).toBe(bob);

        const relationshipsForLegacy = await relationships.list(hrAdminClaims, { employeeId: legacyTarget.id });
        expect(relationshipsForLegacy).toHaveLength(0);
      });

      it("end() guards against clobbering a managerId that was changed out from under this relationship", async () => {
        const target = (await employees.create(hrAdminClaims, { firstName: "Guarded", lastName: "Target" })).id;
        const relationship = await relationships.create(hrAdminClaims, { employeeId: target, managerEmployeeId: bob, relationshipType: "direct" });

        // Simulate a legacy direct write that changes managerId out from
        // under this relationship's own record (still logically "ended"
        // from the relationship's perspective, but the guard must not
        // stomp on the newer value).
        await employees.update(hrAdminClaims, target, { managerId: carol });

        await relationships.end(hrAdminClaims, relationship.id);
        expect((await employees.get(hrAdminClaims, target)).managerId).toBe(carol);
      });
    });

    it("a Line Manager (org_relationship.view.all only) can read but not mutate", async () => {
      const list = await relationships.list(managerClaims);
      expect(Array.isArray(list)).toBe(true);
      await expect(
        relationships.create(managerClaims, { employeeId: alice, managerEmployeeId: bob, relationshipType: "dotted_line" })
      ).rejects.toThrow(ForbiddenException);
    });

    it("404s the whole module when `employee` is disabled for the tenant", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = false WHERE company_id = $1 AND module_key = 'employee'", [
          companyId,
        ])
      );
      await expect(relationships.list(hrAdminClaims)).rejects.toThrow(NotFoundException);
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = true WHERE company_id = $1 AND module_key = 'employee'", [
          companyId,
        ])
      );
    });
  });

  describe("tenant isolation (RLS)", () => {
    it("a relationship created in one tenant is invisible to another tenant's session", async () => {
      const companyAId = await createFixtureCompany("Relationship Isolation A");
      const companyBId = await createFixtureCompany("Relationship Isolation B");
      const hrAdminA = await createUser(`rel-iso-a-${Date.now()}@example.com`);
      const hrAdminB = await createUser(`rel-iso-b-${Date.now()}@example.com`);
      await assignRole(hrAdminA, companyAId, "hr_admin");
      await assignRole(hrAdminB, companyBId, "hr_admin");
      const claimsA: RequestClaims = { is_platform_admin: false, company_id: companyAId, sub: hrAdminA };
      const claimsB: RequestClaims = { is_platform_admin: false, company_id: companyBId, sub: hrAdminB };

      const employeeA1 = await employees.create(claimsA, { firstName: "A1", lastName: "Isolation" });
      const employeeA2 = await employees.create(claimsA, { firstName: "A2", lastName: "Isolation" });
      const relationshipA = await relationships.create(claimsA, {
        employeeId: employeeA1.id,
        managerEmployeeId: employeeA2.id,
        relationshipType: "direct",
      });

      await expect(relationships.get(claimsB, relationshipA.id)).rejects.toThrow(NotFoundException);
      const listB = await relationships.list(claimsB);
      expect(listB.find((r) => r.id === relationshipA.id)).toBeUndefined();
    });
  });
});
