import { Pool } from "pg";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { EmployeesService } from "./employees.service";
import { EmployeeLifecycleService } from "./employee-lifecycle.service";
import { HrReferenceCatalogService } from "../hr-administration/hr-reference-catalog.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "lifecycle-spec-fixtures" };

/**
 * Core Employee Enterprise Phase 10 — real Postgres, no mocks, same
 * discipline as every prior phase's own spec file. Exercises all 9
 * explicit lifecycle transactions plus the two cross-cutting guarantees
 * that motivated building this as its own service rather than folding it
 * into `EmployeesService.update()`: (1) the pre-existing field-diff
 * inference in `autoRecordJobHistory()` keeps working completely
 * unchanged (covered by `employees.service.spec.ts`'s own test, not
 * re-asserted here), and (2) each of these 9 methods writes its OWN named
 * `event_type`, never a guess.
 */
describe("EmployeeLifecycleService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let employees: EmployeesService;
  let lifecycle: EmployeeLifecycleService;
  let companyId: string;
  let hrAdminClaims: RequestClaims;
  let noPermissionClaims: RequestClaims;
  let orgUnitAId: string;
  let orgUnitBId: string;
  let locationAId: string;
  let locationBId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
    lifecycle = new EmployeeLifecycleService(db, rbac, entitlements, audit);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Lifecycle Co ${stamp}`,
        `lifecycle-co-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query(
        "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)",
        [id]
      );
      return id;
    });

    const hrAdminUserId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        `lifecycle-hr-${stamp}@example.com`,
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
        `lifecycle-outsider-${stamp}@example.com`,
      ]);
      return result.rows[0].id as string;
    });
    noPermissionClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };

    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const unitA = await client.query(
        "INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', $2) RETURNING id",
        [companyId, "Engineering"]
      );
      orgUnitAId = unitA.rows[0].id;
      const unitB = await client.query(
        "INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', $2) RETURNING id",
        [companyId, "Finance"]
      );
      orgUnitBId = unitB.rows[0].id;
      const locA = await client.query(
        "INSERT INTO locations (company_id, location_type, name) VALUES ($1, 'site', $2) RETURNING id",
        [companyId, "Karachi HQ"]
      );
      locationAId = locA.rows[0].id;
      const locB = await client.query(
        "INSERT INTO locations (company_id, location_type, name) VALUES ($1, 'site', $2) RETURNING id",
        [companyId, "Lahore Office"]
      );
      locationBId = locB.rows[0].id;
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  async function latestHistory(employeeId: string) {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        "SELECT * FROM employee_job_history WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 1",
        [employeeId]
      );
      return result.rows[0];
    });
  }

  async function createEmployee(overrides: Record<string, unknown> = {}) {
    const created = await employees.create(hrAdminClaims, {
      firstName: "Test",
      lastName: `Employee-${Math.random().toString(36).slice(2, 8)}`,
      department: "Engineering",
      designation: "Software Engineer",
      orgUnitId: orgUnitAId,
      locationId: locationAId,
      salaryBand: "E3",
      ...overrides,
    } as never);
    return created.id;
  }

  it("transfer() moves org unit/department/location and writes an explicit 'transfer' history row", async () => {
    const employeeId = await createEmployee();

    const result = await lifecycle.transfer(hrAdminClaims, employeeId, {
      orgUnitId: orgUnitBId,
      locationId: locationBId,
      effectiveDate: "2026-10-01",
      notes: "Reorg move to Finance",
    });

    expect(result.employee.orgUnitId).toBe(orgUnitBId);
    expect(result.employee.department).toBe("Finance");
    expect(result.employee.locationId).toBe(locationBId);
    expect(result.employee.location).toBe("Lahore Office");
    expect(result.jobHistory.eventType).toBe("transfer");
    expect(result.jobHistory.effectiveDate).toBe("2026-10-01");

    const row = await latestHistory(employeeId);
    expect(row.event_type).toBe("transfer");
    expect(row.department).toBe("Finance");
  });

  it("promote() changes designation/salary band and writes 'promotion', demote() writes 'demotion'", async () => {
    const employeeId = await createEmployee();

    const promoted = await lifecycle.promote(hrAdminClaims, employeeId, {
      designation: "Senior Software Engineer",
      salaryBand: "E4",
      effectiveDate: "2026-10-01",
    });
    expect(promoted.employee.designation).toBe("Senior Software Engineer");
    expect(promoted.employee.salaryBand).toBe("E4");
    expect(promoted.jobHistory.eventType).toBe("promotion");

    const demoted = await lifecycle.demote(hrAdminClaims, employeeId, {
      designation: "Software Engineer",
      salaryBand: "E3",
      effectiveDate: "2026-11-01",
    });
    expect(demoted.employee.designation).toBe("Software Engineer");
    expect(demoted.jobHistory.eventType).toBe("demotion");
  });

  it("second() requires endDate >= effectiveDate and records both dates on a 'secondment' row", async () => {
    const employeeId = await createEmployee();

    await expect(
      lifecycle.second(hrAdminClaims, employeeId, {
        orgUnitId: orgUnitBId,
        effectiveDate: "2026-10-10",
        endDate: "2026-10-01",
      })
    ).rejects.toThrow(BadRequestException);

    const result = await lifecycle.second(hrAdminClaims, employeeId, {
      orgUnitId: orgUnitBId,
      effectiveDate: "2026-10-01",
      endDate: "2027-01-01",
      notes: "Temporary posting to Finance",
    });
    expect(result.employee.orgUnitId).toBe(orgUnitBId);
    expect(result.employee.department).toBe("Finance");
    expect(result.jobHistory.eventType).toBe("secondment");
    expect(result.jobHistory.endDate).toBe("2027-01-01");

    const row = await latestHistory(employeeId);
    expect(row.end_date?.toISOString?.().slice(0, 10) ?? row.end_date).toBe("2027-01-01");
  });

  it("assignActingRole() requires a designation and an endDate, and records 'acting'", async () => {
    const employeeId = await createEmployee();

    await expect(
      lifecycle.assignActingRole(hrAdminClaims, employeeId, {
        designation: "",
        effectiveDate: "2026-10-01",
        endDate: "2026-11-01",
      })
    ).rejects.toThrow(BadRequestException);

    const result = await lifecycle.assignActingRole(hrAdminClaims, employeeId, {
      designation: "Acting Engineering Manager",
      effectiveDate: "2026-10-01",
      endDate: "2026-11-01",
    });
    expect(result.employee.designation).toBe("Acting Engineering Manager");
    expect(result.jobHistory.eventType).toBe("acting");
    expect(result.jobHistory.endDate).toBe("2026-11-01");
  });

  it("changeManager() validates the manager exists, isn't terminated, and isn't the employee themselves", async () => {
    const managerId = await createEmployee({ designation: "Engineering Manager" });
    const employeeId = await createEmployee();

    await expect(
      lifecycle.changeManager(hrAdminClaims, employeeId, { managerId: employeeId, effectiveDate: "2026-10-01" })
    ).rejects.toThrow(BadRequestException);

    const missingManagerId = "00000000-0000-0000-0000-000000000000";
    await expect(
      lifecycle.changeManager(hrAdminClaims, employeeId, { managerId: missingManagerId, effectiveDate: "2026-10-01" })
    ).rejects.toThrow(BadRequestException);

    const terminatedManagerId = await createEmployee({ designation: "Former Manager" });
    await lifecycle.terminate(hrAdminClaims, terminatedManagerId, { terminationDate: "2026-09-01" });
    await expect(
      lifecycle.changeManager(hrAdminClaims, employeeId, { managerId: terminatedManagerId, effectiveDate: "2026-10-01" })
    ).rejects.toThrow(BadRequestException);

    const result = await lifecycle.changeManager(hrAdminClaims, employeeId, { managerId, effectiveDate: "2026-10-01" });
    expect(result.employee.managerId).toBe(managerId);
    expect(result.jobHistory.eventType).toBe("manager_change");
  });

  it("changeLocation() derives the location name and records 'location_change'", async () => {
    const employeeId = await createEmployee();

    const result = await lifecycle.changeLocation(hrAdminClaims, employeeId, {
      locationId: locationBId,
      effectiveDate: "2026-10-01",
    });
    expect(result.employee.locationId).toBe(locationBId);
    expect(result.employee.location).toBe("Lahore Office");
    expect(result.jobHistory.eventType).toBe("location_change");
  });

  it("terminate() sets employment status and fires the pre-existing employee.terminated event; reactivate() requires a terminated employee first", async () => {
    const employeeId = await createEmployee();

    await expect(lifecycle.reactivate(hrAdminClaims, employeeId, { effectiveDate: "2026-10-01" })).rejects.toThrow(
      BadRequestException
    );

    const terminated = await lifecycle.terminate(hrAdminClaims, employeeId, {
      terminationDate: "2026-10-01",
      terminationReason: "Resignation",
    });
    expect(terminated.employee.employmentStatus).toBe("terminated");
    expect(terminated.employee.terminationDate).toBe("2026-10-01");
    expect(terminated.jobHistory.eventType).toBe("termination");

    const reactivated = await lifecycle.reactivate(hrAdminClaims, employeeId, {
      effectiveDate: "2026-11-01",
      notes: "Rejoined the company",
    });
    expect(reactivated.employee.employmentStatus).toBe("active");
    expect(reactivated.employee.terminationDate).toBeNull();
    expect(reactivated.jobHistory.eventType).toBe("reactivation");
  });

  it("every method enforces employee.manage.all, throwing ForbiddenException for a caller without it", async () => {
    const employeeId = await createEmployee();
    await expect(
      lifecycle.transfer(noPermissionClaims, employeeId, { effectiveDate: "2026-10-01" })
    ).rejects.toThrow(ForbiddenException);
  });

  describe("Organization Management sync (cross-module integration audit Item 2) — org-side tables actually change", () => {
    async function seat(orgUnitId: string, status: "vacant" | "filled" = "vacant"): Promise<string> {
      return db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query(
          "INSERT INTO positions (company_id, org_unit_id, position_title, status) VALUES ($1, $2, $3, $4) RETURNING id",
          [companyId, orgUnitId, `Seat ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, status]
        );
        return result.rows[0].id as string;
      });
    }
    async function orgState(employeeId: string) {
      return db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const emp = await client.query("SELECT org_unit_id, position_id, manager_id, location_id, designation FROM employees WHERE id = $1", [
          employeeId,
        ]);
        const assignments = await client.query(
          "SELECT * FROM employee_org_assignments WHERE employee_id = $1 ORDER BY created_at",
          [employeeId]
        );
        const relationships = await client.query("SELECT * FROM org_relationships WHERE employee_id = $1 ORDER BY created_at", [employeeId]);
        const history = await client.query("SELECT count(*)::int AS c FROM employee_job_history WHERE employee_id = $1", [employeeId]);
        return {
          employee: emp.rows[0],
          assignments: assignments.rows,
          activePrimary: assignments.rows.filter((a) => a.assignment_type === "primary" && a.status === "active"),
          relationships: relationships.rows,
          historyCount: history.rows[0].c as number,
        };
      });
    }
    async function positionStatus(positionId: string): Promise<string> {
      return db.withClaims(FIXTURE_CLAIMS, async (client) => (await client.query("SELECT status FROM positions WHERE id = $1", [positionId])).rows[0].status);
    }

    it("transfer(): fills a named seat, replaces the primary assignment, and vacates a seat left behind in the old org unit", async () => {
      const employeeId = await createEmployee();
      const seatA = await seat(orgUnitAId);

      // Into a seat in the employee's current unit.
      const first = await lifecycle.transfer(hrAdminClaims, employeeId, { positionId: seatA, effectiveDate: "2026-10-01" });
      expect(first.employee.positionId).toBe(seatA);
      expect(await positionStatus(seatA)).toBe("filled");
      let state = await orgState(employeeId);
      expect(state.activePrimary).toHaveLength(1);
      expect(state.activePrimary[0]).toMatchObject({ org_unit_id: orgUnitAId, position_id: seatA, location_id: locationAId });

      // Out to unit B with no new seat: the unit-A seat cannot come along.
      const second = await lifecycle.transfer(hrAdminClaims, employeeId, { orgUnitId: orgUnitBId, locationId: locationBId, effectiveDate: "2026-11-01" });
      expect(second.employee.positionId).toBeNull();
      expect(await positionStatus(seatA)).toBe("vacant");
      state = await orgState(employeeId);
      expect(state.assignments.filter((a) => a.assignment_type === "primary")).toHaveLength(2);
      expect(state.assignments[0].status).toBe("ended");
      expect(state.activePrimary).toHaveLength(1);
      expect(state.activePrimary[0]).toMatchObject({ org_unit_id: orgUnitBId, position_id: null, location_id: locationBId });

      // The ended slot keeps a closed, effective-dated version history.
      const versions = await db.withClaims(FIXTURE_CLAIMS, async (client) =>
        (
          await client.query(
            "SELECT status, effective_from, effective_to FROM employee_org_assignment_versions WHERE employee_org_assignment_id = $1 ORDER BY effective_from",
            [state.assignments[0].id]
          )
        ).rows
      );
      expect(versions.map((v) => v.status)).toEqual(["active", "ended"]);
      expect(versions[0].effective_to).not.toBeNull();
    });

    it("transfer() into a seat that is not vacant fails and rolls back the employee update and history row", async () => {
      const employeeId = await createEmployee();
      const taken = await seat(orgUnitBId, "filled");
      const before = await orgState(employeeId);
      await expect(
        lifecycle.transfer(hrAdminClaims, employeeId, { orgUnitId: orgUnitBId, positionId: taken, effectiveDate: "2026-10-01" })
      ).rejects.toThrow(BadRequestException);
      const after = await orgState(employeeId);
      expect(after.employee.org_unit_id).toBe(orgUnitAId);
      expect(after.historyCount).toBe(before.historyCount);
      expect(after.assignments).toHaveLength(0);
    });

    it("promote()/demote() with a positionId vacate the old seat, occupy the new one, and move the org unit with the seat", async () => {
      const employeeId = await createEmployee();
      const seatA = await seat(orgUnitAId);
      const seatB = await seat(orgUnitBId);
      await lifecycle.transfer(hrAdminClaims, employeeId, { positionId: seatA, effectiveDate: "2026-10-01" });

      const promoted = await lifecycle.promote(hrAdminClaims, employeeId, {
        designation: "Finance Lead",
        positionId: seatB,
        effectiveDate: "2026-10-15",
      });
      expect(promoted.employee.positionId).toBe(seatB);
      expect(promoted.employee.orgUnitId).toBe(orgUnitBId);
      expect(promoted.employee.department).toBe("Finance");
      expect(await positionStatus(seatA)).toBe("vacant");
      expect(await positionStatus(seatB)).toBe("filled");
      let state = await orgState(employeeId);
      expect(state.activePrimary[0]).toMatchObject({ org_unit_id: orgUnitBId, position_id: seatB });

      const demoted = await lifecycle.demote(hrAdminClaims, employeeId, { designation: "Engineer", positionId: seatA, effectiveDate: "2026-11-01" });
      expect(demoted.employee.positionId).toBe(seatA);
      expect(await positionStatus(seatB)).toBe("vacant");
      state = await orgState(employeeId);
      expect(state.activePrimary[0]).toMatchObject({ org_unit_id: orgUnitAId, position_id: seatA });

      // A designation-only promotion touches no org-side table.
      const assignmentsBefore = state.assignments.length;
      await lifecycle.promote(hrAdminClaims, employeeId, { designation: "Senior Engineer", effectiveDate: "2026-12-01" });
      expect((await orgState(employeeId)).assignments).toHaveLength(assignmentsBefore);
      expect(await positionStatus(seatA)).toBe("filled");
    });

    it("second() opens a 'secondment' assignment slot (primary untouched) and a 'secondment' relationship to the host manager", async () => {
      const hostManager = await createEmployee({ designation: "Finance Manager", orgUnitId: orgUnitBId });
      const employeeId = await createEmployee();
      await lifecycle.transfer(hrAdminClaims, employeeId, { orgUnitId: orgUnitAId, effectiveDate: "2026-10-01" });

      await lifecycle.second(hrAdminClaims, employeeId, {
        orgUnitId: orgUnitBId,
        locationId: locationBId,
        managerEmployeeId: hostManager,
        effectiveDate: "2026-10-05",
        endDate: "2027-01-05",
      });
      const state = await orgState(employeeId);
      const secondment = state.assignments.find((a) => a.assignment_type === "secondment");
      expect(secondment).toMatchObject({ status: "active", org_unit_id: orgUnitBId, location_id: locationBId });
      expect(state.activePrimary[0]).toMatchObject({ org_unit_id: orgUnitAId });
      expect(state.relationships).toHaveLength(1);
      expect(state.relationships[0]).toMatchObject({ relationship_type: "secondment", manager_employee_id: hostManager, status: "active" });
      // The effective-dated history row carries the same type (0103 widened
      // both tables' CHECK constraints), and the employee's solid-line
      // manager is untouched — a secondment is not a manager change.
      const versions = await db.withClaims(FIXTURE_CLAIMS, async (client) =>
        (await client.query("SELECT relationship_type FROM org_relationship_versions WHERE org_relationship_id = $1", [state.relationships[0].id])).rows
      );
      expect(versions.map((v) => v.relationship_type)).toEqual(["secondment"]);
      expect(state.employee.manager_id).toBeNull();
    });

    it("assignActingRole() records the acted-in position on an 'acting' slot WITHOUT occupying it, plus an 'acting' relationship", async () => {
      const incumbent = await createEmployee();
      const headSeat = await seat(orgUnitAId);
      await lifecycle.transfer(hrAdminClaims, incumbent, { positionId: headSeat, effectiveDate: "2026-10-01" });
      const supervisor = await createEmployee({ designation: "Director" });
      const employeeId = await createEmployee();

      await lifecycle.assignActingRole(hrAdminClaims, employeeId, {
        designation: "Acting Head of Engineering",
        positionId: headSeat,
        managerEmployeeId: supervisor,
        effectiveDate: "2026-10-10",
        endDate: "2026-12-10",
      });
      const state = await orgState(employeeId);
      expect(state.assignments.find((a) => a.assignment_type === "acting")).toMatchObject({ position_id: headSeat, status: "active" });
      expect(state.employee.position_id).toBeNull();
      expect(await positionStatus(headSeat)).toBe("filled");
      expect((await orgState(incumbent)).employee.position_id).toBe(headSeat);
      expect(state.relationships[0]).toMatchObject({ relationship_type: "acting", manager_employee_id: supervisor });
    });

    it("changeManager() writes a 'direct' org_relationships row, supersedes it on the next change, and rejects a reporting cycle atomically", async () => {
      const managerA = await createEmployee({ designation: "Manager A" });
      const managerB = await createEmployee({ designation: "Manager B" });
      const employeeId = await createEmployee();

      await lifecycle.changeManager(hrAdminClaims, employeeId, { managerId: managerA, effectiveDate: "2026-10-01" });
      let state = await orgState(employeeId);
      expect(state.employee.manager_id).toBe(managerA);
      expect(state.relationships).toHaveLength(1);
      expect(state.relationships[0]).toMatchObject({ relationship_type: "direct", manager_employee_id: managerA, status: "active" });

      await lifecycle.changeManager(hrAdminClaims, employeeId, { managerId: managerB, effectiveDate: "2026-11-01" });
      state = await orgState(employeeId);
      expect(state.employee.manager_id).toBe(managerB);
      const direct = state.relationships.filter((r) => r.relationship_type === "direct");
      expect(direct.map((r) => [r.manager_employee_id, r.status])).toEqual([
        [managerA, "ended"],
        [managerB, "active"],
      ]);

      // managerB now (transitively) manages employeeId; making employeeId
      // managerB's manager would close a loop — and must roll back the
      // employees.manager_id write too, not just skip the relationship.
      const managerBHistoryBefore = (await orgState(managerB)).historyCount;
      await expect(lifecycle.changeManager(hrAdminClaims, managerB, { managerId: employeeId, effectiveDate: "2026-11-02" })).rejects.toThrow(
        BadRequestException
      );
      const managerBState = await orgState(managerB);
      expect(managerBState.employee.manager_id).toBeNull();
      expect(managerBState.relationships).toHaveLength(0);
      expect(managerBState.historyCount).toBe(managerBHistoryBefore);
    });

    it("changeLocation() replaces the primary assignment with the new location", async () => {
      const employeeId = await createEmployee();
      await lifecycle.transfer(hrAdminClaims, employeeId, { orgUnitId: orgUnitAId, effectiveDate: "2026-10-01" });
      await lifecycle.changeLocation(hrAdminClaims, employeeId, { locationId: locationBId, effectiveDate: "2026-10-20" });
      const state = await orgState(employeeId);
      expect(state.activePrimary).toHaveLength(1);
      expect(state.activePrimary[0]).toMatchObject({ org_unit_id: orgUnitAId, location_id: locationBId });
    });

    it("terminate() vacates (never abolishes) the seat and ends every open assignment; reactivate() leaves both alone", async () => {
      const employeeId = await createEmployee();
      const seatA = await seat(orgUnitAId);
      await lifecycle.transfer(hrAdminClaims, employeeId, { positionId: seatA, effectiveDate: "2026-10-01" });
      await lifecycle.second(hrAdminClaims, employeeId, { orgUnitId: orgUnitBId, effectiveDate: "2026-10-02", endDate: "2026-12-01" });

      const terminated = await lifecycle.terminate(hrAdminClaims, employeeId, { terminationDate: "2026-10-31" });
      expect(terminated.employee.positionId).toBeNull();
      expect(await positionStatus(seatA)).toBe("vacant");
      let state = await orgState(employeeId);
      expect(state.assignments.length).toBeGreaterThanOrEqual(2);
      expect(state.assignments.every((a) => a.status === "ended")).toBe(true);
      const unassignAudit = await db.withClaims(FIXTURE_CLAIMS, async (client) =>
        (await client.query("SELECT metadata FROM audit_log WHERE action = 'position.unassign' AND target = $1", [seatA])).rows
      );
      expect(unassignAudit[0].metadata.source).toBe("employee_lifecycle:termination");

      await lifecycle.reactivate(hrAdminClaims, employeeId, { effectiveDate: "2026-12-01" });
      state = await orgState(employeeId);
      expect(state.employee.position_id).toBeNull();
      expect(state.assignments.every((a) => a.status === "ended")).toBe(true);
      expect(await positionStatus(seatA)).toBe("vacant");
    });
  });

  describe("reasonCode validation against the HR Administration catalog (v2, 2026-09-27)", () => {
    // A SEPARATE EmployeeLifecycleService instance, wired with a real
    // HrReferenceCatalogService — the top-level `lifecycle` instance above
    // deliberately omits it (undefined, same optional shape as
    // `webhooks?`), so every test above keeps exercising the
    // no-catalog-wired path unchanged.
    let lifecycleWithCatalog: EmployeeLifecycleService;

    beforeAll(() => {
      const rbac = new RbacService(db);
      const entitlements = new EntitlementsService(db);
      const audit = new AuditService();
      const hrCatalog = new HrReferenceCatalogService(db, rbac, entitlements, audit);
      lifecycleWithCatalog = new EmployeeLifecycleService(db, rbac, entitlements, audit, undefined, hrCatalog);
    });

    it("accepts a seeded default reason code and records it on the job history row", async () => {
      const employeeId = await createEmployee();
      const result = await lifecycleWithCatalog.transfer(hrAdminClaims, employeeId, {
        orgUnitId: orgUnitBId,
        effectiveDate: "2026-10-01",
        reasonCode: "business_need",
      });
      expect(result.jobHistory.reasonCode).toBe("business_need");
    });

    it("rejects a reason code that isn't an active item in that transaction's mapped catalog", async () => {
      const employeeId = await createEmployee();
      await expect(
        lifecycleWithCatalog.transfer(hrAdminClaims, employeeId, {
          orgUnitId: orgUnitBId,
          effectiveDate: "2026-10-01",
          reasonCode: "not_a_real_reason",
        })
      ).rejects.toThrow(BadRequestException);
    });

    it("terminate() and reactivate() each validate against their own mapped catalog", async () => {
      const employeeId = await createEmployee();
      await expect(
        lifecycleWithCatalog.terminate(hrAdminClaims, employeeId, { terminationDate: "2026-10-01", reasonCode: "made_up" })
      ).rejects.toThrow(BadRequestException);

      const terminated = await lifecycleWithCatalog.terminate(hrAdminClaims, employeeId, {
        terminationDate: "2026-10-01",
        reasonCode: "resignation",
      });
      expect(terminated.jobHistory.reasonCode).toBe("resignation");

      const reactivated = await lifecycleWithCatalog.reactivate(hrAdminClaims, employeeId, {
        effectiveDate: "2026-11-01",
        reasonCode: "leave_completed",
      });
      expect(reactivated.jobHistory.reasonCode).toBe("leave_completed");
    });

    it("leaves reasonCode null when none is supplied, exactly like before this phase", async () => {
      const employeeId = await createEmployee();
      const result = await lifecycleWithCatalog.transfer(hrAdminClaims, employeeId, {
        orgUnitId: orgUnitBId,
        effectiveDate: "2026-10-01",
      });
      expect(result.jobHistory.reasonCode).toBeNull();
    });
  });

  // Cross-module integration audit (2026-10-01), gap #3/#7 —
  // 0111_write_scope_data_scope_enforcement.sql's write-side enforcement,
  // applied here to the shared `execute()` helper so it covers all 9
  // lifecycle transactions at once. Only `transfer()`/`terminate()` are
  // exercised directly below (one "simple field patch" transaction and
  // one "ends the record" transaction) — every other transaction funnels
  // through the exact same `execute()` call this gate lives in.
  describe("Data Scope on write (employee.manage.scoped, gap #3/#7)", () => {
    let regionalHrClaims: RequestClaims;

    beforeAll(async () => {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const regionalHrUserId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
          `lifecycle-regional-hr-${stamp}@example.com`,
        ]);
        return result.rows[0].id as string;
      });
      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const role = await client.query("SELECT id FROM roles WHERE key = 'regional_hr'");
        await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [
          regionalHrUserId,
          companyId,
          role.rows[0].id,
        ]);
        // Scoped to org unit A (Engineering) only — org unit B (Finance)
        // stays out of this caller's reach.
        await client.query(
          "INSERT INTO data_scope_assignments (user_account_id, company_id, scope_type, scope_entity_id) VALUES ($1, $2, 'org_unit', $3)",
          [regionalHrUserId, companyId, orgUnitAId]
        );
      });
      regionalHrClaims = { is_platform_admin: false, company_id: companyId, sub: regionalHrUserId };
    });

    it("regional_hr can transfer an employee who is currently inside their assigned org unit", async () => {
      const employeeId = await createEmployee({ orgUnitId: orgUnitAId });
      const result = await lifecycle.transfer(regionalHrClaims, employeeId, {
        orgUnitId: orgUnitAId,
        locationId: locationBId,
        effectiveDate: "2026-10-02",
      });
      expect(result.employee.locationId).toBe(locationBId);
    });

    it("regional_hr cannot transfer or terminate an employee currently outside their assigned org unit", async () => {
      const employeeId = await createEmployee({ orgUnitId: orgUnitBId });
      await expect(
        lifecycle.transfer(regionalHrClaims, employeeId, { orgUnitId: orgUnitAId, effectiveDate: "2026-10-02" })
      ).rejects.toThrow(ForbiddenException);
      await expect(lifecycle.terminate(regionalHrClaims, employeeId, { terminationDate: "2026-10-02" })).rejects.toThrow(
        ForbiddenException
      );
    });

    it("hr_admin (unscoped .all) is unaffected", async () => {
      const employeeId = await createEmployee({ orgUnitId: orgUnitBId });
      const result = await lifecycle.transfer(hrAdminClaims, employeeId, {
        orgUnitId: orgUnitAId,
        effectiveDate: "2026-10-02",
      });
      expect(result.employee.orgUnitId).toBe(orgUnitAId);
    });
  });
});
