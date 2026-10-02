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
import { WebhookDispatchService } from "../webhooks/webhook-dispatch.service";
import { IntegrationsService } from "../tenant-management/integrations.service";
import { OrgUnitsService } from "./org-units.service";
import { JobsService } from "./jobs.service";
import { CostCentersService } from "./cost-centers.service";
import { ProfitCentersService } from "./profit-centers.service";
import { PositionsService } from "./positions.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "positions-spec-fixtures" };

/**
 * Organization Management, Phase 2 (see the Master Engineering
 * Instruction doc's Section 9, and 0068_job_position_architecture.sql).
 * Real Postgres, no mocks — the two things this entity actually adds over
 * Job/OrgUnit: a position can exist vacant with zero occupants (a
 * first-class state, not an edge case), and the assign/unassign
 * occupancy state transition PositionsService owns end to end (see that
 * service's own class doc comment for why EmployeesService is never
 * involved).
 */
describe("PositionsService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let orgUnits: OrgUnitsService;
  let jobs: JobsService;
  let costCenters: CostCentersService;
  let profitCenters: ProfitCentersService;
  let positions: PositionsService;
  let employees: EmployeesService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    orgUnits = new OrgUnitsService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    jobs = new JobsService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    costCenters = new CostCentersService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    profitCenters = new ProfitCentersService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    positions = new PositionsService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
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

  /** Organization Management Phase 11 (Section 19) — same raw-SQL fixture
   * convention `org-units.service.spec.ts` already established. */
  async function assignDataScope(userAccountId: string, companyId: string, scopeType: string, scopeEntityId: string) {
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      await client.query(
        "INSERT INTO data_scope_assignments (user_account_id, company_id, scope_type, scope_entity_id) VALUES ($1, $2, $3, $4)",
        [userAccountId, companyId, scopeType, scopeEntityId]
      );
    });
  }

  describe("CRUD, effective-dating, lifecycle transitions, and RBAC", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let managerClaims: RequestClaims;
    let engineeringUnitId: string;
    let engineerJobId: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Position Co");
      const stamp = Date.now();
      const hrAdminUserId = await createUser(`pos-hr-${stamp}@example.com`);
      const managerUserId = await createUser(`pos-mgr-${stamp}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      await assignRole(managerUserId, companyId, "line_manager");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      managerClaims = { is_platform_admin: false, company_id: companyId, sub: managerUserId };

      engineeringUnitId = (await orgUnits.create(hrAdminClaims, { name: "Engineering", unitType: "department" })).id;
      engineerJobId = (await jobs.create(hrAdminClaims, { title: "Backend Engineer" })).id;
    });

    it("creates a position vacant by default, with headcountFte defaulting to 1.0", async () => {
      const position = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, jobId: engineerJobId });
      expect(position).toMatchObject({
        orgUnitId: engineeringUnitId,
        jobId: engineerJobId,
        positionTitle: "Backend Engineer",
        headcountFte: 1,
        status: "vacant",
      });

      const history = await positions.getHistory(hrAdminClaims, position.id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ status: "vacant", effectiveTo: null });
    });

    it("a vacant position with zero occupants is a first-class valid state, not an error", async () => {
      const position = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, positionTitle: "Standalone Seat" });
      expect(position.status).toBe("vacant");
      const fetched = await positions.get(hrAdminClaims, position.id);
      expect(fetched.status).toBe("vacant");
    });

    it("positionTitle defaults from the job's current title when omitted", async () => {
      const position = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, jobId: engineerJobId });
      expect(position.positionTitle).toBe("Backend Engineer");
    });

    it("an explicit positionTitle overrides the job's title and stays independently editable", async () => {
      const position = await positions.create(hrAdminClaims, {
        orgUnitId: engineeringUnitId,
        jobId: engineerJobId,
        positionTitle: "Senior Backend Engineer (Platform)",
      });
      expect(position.positionTitle).toBe("Senior Backend Engineer (Platform)");
    });

    it("requires positionTitle when no jobId is given", async () => {
      await expect(positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId })).rejects.toThrow(BadRequestException);
    });

    it("404s when creating against a nonexistent org unit", async () => {
      await expect(
        positions.create(hrAdminClaims, { orgUnitId: "00000000-0000-0000-0000-000000000000", positionTitle: "Orphan Seat" })
      ).rejects.toThrow(NotFoundException);
    });

    it("404s when creating against a nonexistent job", async () => {
      await expect(
        positions.create(hrAdminClaims, {
          orgUnitId: engineeringUnitId,
          jobId: "00000000-0000-0000-0000-000000000000",
        })
      ).rejects.toThrow(NotFoundException);
    });

    it("rejects a duplicate position code within the same tenant", async () => {
      await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, positionTitle: "Coded Seat", positionCode: "ENG-001" });
      await expect(
        positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, positionTitle: "Another Seat", positionCode: "ENG-001" })
      ).rejects.toThrow(ConflictException);
    });

    it("list() filters by status and orgUnitId", async () => {
      const salesUnitId = (await orgUnits.create(hrAdminClaims, { name: "Sales", unitType: "department" })).id;
      const salesPosition = await positions.create(hrAdminClaims, { orgUnitId: salesUnitId, positionTitle: "Sales Rep" });

      const engineeringOnly = await positions.list(hrAdminClaims, { orgUnitId: engineeringUnitId });
      expect(engineeringOnly.every((p) => p.orgUnitId === engineeringUnitId)).toBe(true);
      expect(engineeringOnly.find((p) => p.id === salesPosition.id)).toBeUndefined();

      const vacantOnly = await positions.list(hrAdminClaims, { status: "vacant" });
      expect(vacantOnly.every((p) => p.status === "vacant")).toBe(true);
    });

    it("update() reparents/retitles/reassigns-job/adjusts-headcount in place", async () => {
      const position = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, positionTitle: "To Edit" });
      const updated = await positions.update(hrAdminClaims, position.id, {
        positionTitle: "Edited Title",
        headcountFte: 0.5,
      });
      expect(updated.positionTitle).toBe("Edited Title");
      expect(updated.headcountFte).toBe(0.5);
    });

    it("update() with jobId: null clears the job link", async () => {
      const position = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, jobId: engineerJobId });
      expect(position.jobId).toBe(engineerJobId);
      const cleared = await positions.update(hrAdminClaims, position.id, { jobId: null });
      expect(cleared.jobId).toBeNull();
    });

    describe("freeze / unfreeze / abolish / reactivate", () => {
      it("freeze() only succeeds from vacant, and unfreeze() only from frozen", async () => {
        const position = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, positionTitle: "Freeze Me" });
        const frozen = await positions.freeze(hrAdminClaims, position.id);
        expect(frozen.status).toBe("frozen");

        await expect(positions.freeze(hrAdminClaims, position.id)).rejects.toThrow(BadRequestException);

        const unfrozen = await positions.unfreeze(hrAdminClaims, position.id);
        expect(unfrozen.status).toBe("vacant");

        await expect(positions.unfreeze(hrAdminClaims, position.id)).rejects.toThrow(BadRequestException);
      });

      it("abolish() succeeds from vacant or frozen; reactivate() only from abolished", async () => {
        const position = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, positionTitle: "Abolish Me" });
        const abolished = await positions.abolish(hrAdminClaims, position.id);
        expect(abolished.status).toBe("abolished");

        await expect(positions.abolish(hrAdminClaims, position.id)).rejects.toThrow(BadRequestException);

        const reactivated = await positions.reactivate(hrAdminClaims, position.id);
        expect(reactivated.status).toBe("vacant");

        await expect(positions.reactivate(hrAdminClaims, position.id)).rejects.toThrow(BadRequestException);
      });

      it("freeze()/abolish() reject a filled position — it must be unassigned first", async () => {
        const position = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, positionTitle: "Filled Seat" });
        const employee = await employees.create(hrAdminClaims, { firstName: "Filled", lastName: "Seat" });
        await positions.assignEmployee(hrAdminClaims, position.id, employee.id);

        await expect(positions.freeze(hrAdminClaims, position.id)).rejects.toThrow(BadRequestException);
        await expect(positions.abolish(hrAdminClaims, position.id)).rejects.toThrow(BadRequestException);
      });
    });

    describe("occupancy: assignEmployee() / unassignEmployee()", () => {
      it("assignEmployee() fills the position and sets employees.positionId — a real, atomic state transition", async () => {
        const position = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, positionTitle: "Assign Target" });
        const employee = await employees.create(hrAdminClaims, { firstName: "Assign", lastName: "Target" });

        const filled = await positions.assignEmployee(hrAdminClaims, position.id, employee.id);
        expect(filled.status).toBe("filled");

        const fetchedEmployee = await employees.get(hrAdminClaims, employee.id);
        expect(fetchedEmployee.positionId).toBe(position.id);
      });

      it("rejects assigning to a position that is not vacant", async () => {
        const position = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, positionTitle: "Not Vacant" });
        const employeeOne = await employees.create(hrAdminClaims, { firstName: "One", lastName: "First" });
        const employeeTwo = await employees.create(hrAdminClaims, { firstName: "Two", lastName: "Second" });
        await positions.assignEmployee(hrAdminClaims, position.id, employeeOne.id);

        await expect(positions.assignEmployee(hrAdminClaims, position.id, employeeTwo.id)).rejects.toThrow(ConflictException);
      });

      it("404s assigning a nonexistent employee", async () => {
        const position = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, positionTitle: "Bad Employee" });
        await expect(
          positions.assignEmployee(hrAdminClaims, position.id, "00000000-0000-0000-0000-000000000000")
        ).rejects.toThrow(NotFoundException);
      });

      it("unassignEmployee() clears the employee and flips the position back to vacant", async () => {
        const position = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, positionTitle: "Unassign Target" });
        const employee = await employees.create(hrAdminClaims, { firstName: "Unassign", lastName: "Target" });
        await positions.assignEmployee(hrAdminClaims, position.id, employee.id);

        const vacated = await positions.unassignEmployee(hrAdminClaims, position.id);
        expect(vacated.status).toBe("vacant");

        const fetchedEmployee = await employees.get(hrAdminClaims, employee.id);
        expect(fetchedEmployee.positionId).toBeNull();
      });

      it("unassignEmployee() on an already-vacant position is a no-op, not an error", async () => {
        const position = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, positionTitle: "Already Vacant" });
        const result = await positions.unassignEmployee(hrAdminClaims, position.id);
        expect(result.status).toBe("vacant");
      });

      it("reassigning an employee to a different position vacates the old one as a side effect", async () => {
        const positionA = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, positionTitle: "Old Seat" });
        const positionB = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, positionTitle: "New Seat" });
        const employee = await employees.create(hrAdminClaims, { firstName: "Reassign", lastName: "Me" });

        await positions.assignEmployee(hrAdminClaims, positionA.id, employee.id);
        const filledB = await positions.assignEmployee(hrAdminClaims, positionB.id, employee.id);
        expect(filledB.status).toBe("filled");

        const oldPosition = await positions.get(hrAdminClaims, positionA.id);
        expect(oldPosition.status).toBe("vacant");

        const fetchedEmployee = await employees.get(hrAdminClaims, employee.id);
        expect(fetchedEmployee.positionId).toBe(positionB.id);
      });

      it("EmployeesService.create() has no positionId field to accept — occupancy is Position Workbench-only", async () => {
        // CreateEmployeeRequest deliberately carries no `positionId` field
        // this phase (see that type's own doc comment in shared-types) —
        // this is a compile-time guarantee, not a runtime one, but this
        // test pins the runtime side of the same contract: even a caller
        // that reaches around the type system (`as any`, e.g. a stale
        // client build) gets silently ignored, not honored, because
        // EmployeesService's INSERT never references a positionId input
        // at all.
        const position = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, positionTitle: "Direct Edit Attempt" });
        const employee = await employees.create(hrAdminClaims, {
          firstName: "Direct",
          lastName: "Edit",
          ...({ positionId: position.id } as Record<string, unknown>),
        });
        expect(employee.positionId).toBeNull();
        const stillVacant = await positions.get(hrAdminClaims, position.id);
        expect(stillVacant.status).toBe("vacant");
      });

      describe("Workbench assignment keeps the employee's primary org assignment in sync (cross-module integration follow-up, 2026-10-01)", () => {
        async function primaryRows(employeeId: string) {
          const result = await db.withClaims(FIXTURE_CLAIMS, (client) =>
            client.query("SELECT * FROM employee_org_assignments WHERE employee_id = $1 AND assignment_type = 'primary' ORDER BY created_at", [
              employeeId,
            ])
          );
          return result.rows;
        }
        async function employeeRow(employeeId: string) {
          const result = await db.withClaims(FIXTURE_CLAIMS, (client) =>
            client.query("SELECT org_unit_id, department, location_id, position_id FROM employees WHERE id = $1", [employeeId])
          );
          return result.rows[0];
        }
        async function jobHistoryOf(employeeId: string) {
          const result = await db.withClaims(FIXTURE_CLAIMS, (client) =>
            client.query("SELECT * FROM employee_job_history WHERE employee_id = $1 ORDER BY created_at", [employeeId])
          );
          return result.rows;
        }

        it("assignEmployee() opens a primary assignment naming the seat (org unit/department follow it); a re-assign supersedes it; unassignEmployee() drops the seat from it", async () => {
          const financeUnitId = (await orgUnits.create(hrAdminClaims, { name: "Finance Workbench", unitType: "department" })).id;
          const locationId = await db.withClaims(FIXTURE_CLAIMS, async (client) =>
            (await client.query("INSERT INTO locations (company_id, location_type, name) VALUES ($1, 'site', 'Workbench HQ') RETURNING id", [companyId]))
              .rows[0].id as string
          );
          const seatA = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, positionTitle: "Workbench Seat A" });
          const seatB = await positions.create(hrAdminClaims, { orgUnitId: financeUnitId, positionTitle: "Workbench Seat B" });
          const employee = await employees.create(hrAdminClaims, { firstName: "Workbench", lastName: "Placed", locationId });
          expect(await primaryRows(employee.id)).toHaveLength(0);

          // Direct Workbench assignment, no prior primary: one is opened.
          await positions.assignEmployee(hrAdminClaims, seatA.id, employee.id);
          let rows = await primaryRows(employee.id);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ status: "active", org_unit_id: engineeringUnitId, position_id: seatA.id, location_id: locationId });
          expect(await employeeRow(employee.id)).toMatchObject({ org_unit_id: engineeringUnitId, department: "Engineering", position_id: seatA.id });

          // Re-assign into a seat in another org unit: old primary ended, new
          // one names seat B, and the employee's org unit follows the seat.
          await positions.assignEmployee(hrAdminClaims, seatB.id, employee.id);
          rows = await primaryRows(employee.id);
          expect(rows.map((r) => [r.status, r.org_unit_id, r.position_id])).toEqual([
            ["ended", engineeringUnitId, seatA.id],
            ["active", financeUnitId, seatB.id],
          ]);
          expect(await employeeRow(employee.id)).toMatchObject({ org_unit_id: financeUnitId, department: "Finance Workbench", position_id: seatB.id });
          expect((await positions.get(hrAdminClaims, seatA.id)).status).toBe("vacant");

          // Unassign: the open primary no longer names a seat, org unit and
          // location kept.
          await positions.unassignEmployee(hrAdminClaims, seatB.id);
          rows = await primaryRows(employee.id);
          const active = rows.filter((r) => r.status === "active");
          expect(active).toHaveLength(1);
          expect(active[0]).toMatchObject({ org_unit_id: financeUnitId, position_id: null, location_id: locationId });
          expect(rows).toHaveLength(3);

          const audit = await db.withClaims(FIXTURE_CLAIMS, (client) =>
            client.query(
              "SELECT metadata FROM audit_log WHERE action = 'employee_org_assignment.create' AND target = $1",
              [active[0].id]
            )
          );
          expect(audit.rows[0].metadata.source).toBe("position_workbench");
        });

        it("rolls the primary-assignment sync back with the seat fill when the seat is not vacant", async () => {
          const seat = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, positionTitle: "Contested Seat" });
          const holder = await employees.create(hrAdminClaims, { firstName: "Seat", lastName: "Holder" });
          const contender = await employees.create(hrAdminClaims, { firstName: "Seat", lastName: "Contender" });
          await positions.assignEmployee(hrAdminClaims, seat.id, holder.id);

          await expect(positions.assignEmployee(hrAdminClaims, seat.id, contender.id)).rejects.toThrow(ConflictException);
          expect(await primaryRows(contender.id)).toHaveLength(0);
          expect((await employeeRow(contender.id)).position_id).toBeNull();
        });

        it("writes an employee_job_history row when assignment moves the employee into a different org unit, but not for a same-unit reseat (cross-module integration follow-up, 2026-10-01)", async () => {
          const financeUnitId = (await orgUnits.create(hrAdminClaims, { name: "Finance Job History", unitType: "department" })).id;
          const seatA = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, positionTitle: "History Seat A" });
          const seatA2 = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, positionTitle: "History Seat A2" });
          const seatB = await positions.create(hrAdminClaims, { orgUnitId: financeUnitId, positionTitle: "History Seat B" });
          const employee = await employees.create(hrAdminClaims, {
            firstName: "History",
            lastName: "Placed",
            designation: "Engineer",
            salaryBand: "E2",
          });
          expect(await jobHistoryOf(employee.id)).toHaveLength(1); // the 'hire' row only

          // First assignment: no prior org unit at all (null -> engineering)
          // is still a change, so it IS logged.
          await positions.assignEmployee(hrAdminClaims, seatA.id, employee.id);
          let history = await jobHistoryOf(employee.id);
          expect(history).toHaveLength(2);
          expect(history[1]).toMatchObject({
            event_type: "position_assignment",
            department: "Engineering",
            designation: "Engineer",
            salary_band: "E2",
          });

          // Re-assigned to a different seat in the SAME org unit: nothing
          // about the employee's org placement changed, so no new row.
          await positions.assignEmployee(hrAdminClaims, seatA2.id, employee.id);
          expect(await jobHistoryOf(employee.id)).toHaveLength(2);

          // Re-assigned into a seat in a DIFFERENT org unit: logged again.
          await positions.assignEmployee(hrAdminClaims, seatB.id, employee.id);
          history = await jobHistoryOf(employee.id);
          expect(history).toHaveLength(3);
          expect(history[2]).toMatchObject({ event_type: "position_assignment", department: "Finance Job History" });
        });
      });
    });

    describe("cost center / profit center tagging (Organization Management Phase 4)", () => {
      let costCenterId: string;
      let profitCenterId: string;

      beforeAll(async () => {
        costCenterId = (await costCenters.create(hrAdminClaims, { name: "Engineering Cost Center" })).id;
        profitCenterId = (await profitCenters.create(hrAdminClaims, { name: "Engineering Profit Center" })).id;
      });

      it("create() tags a position with a cost center and a profit center", async () => {
        const position = await positions.create(hrAdminClaims, {
          orgUnitId: engineeringUnitId,
          positionTitle: "Tagged Seat",
          costCenterId,
          profitCenterId,
        });
        expect(position.costCenterId).toBe(costCenterId);
        expect(position.profitCenterId).toBe(profitCenterId);

        const history = await positions.getHistory(hrAdminClaims, position.id);
        expect(history[0]).toMatchObject({ costCenterId, profitCenterId });
      });

      it("404s when creating with a nonexistent costCenterId or profitCenterId", async () => {
        await expect(
          positions.create(hrAdminClaims, {
            orgUnitId: engineeringUnitId,
            positionTitle: "Bad Cost Center",
            costCenterId: "00000000-0000-0000-0000-000000000000",
          })
        ).rejects.toThrow(NotFoundException);
        await expect(
          positions.create(hrAdminClaims, {
            orgUnitId: engineeringUnitId,
            positionTitle: "Bad Profit Center",
            profitCenterId: "00000000-0000-0000-0000-000000000000",
          })
        ).rejects.toThrow(NotFoundException);
      });

      it("update() sets, then null clears, each link independently", async () => {
        const position = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, positionTitle: "Retag Me" });
        expect(position.costCenterId).toBeNull();
        expect(position.profitCenterId).toBeNull();

        const tagged = await positions.update(hrAdminClaims, position.id, { costCenterId, profitCenterId });
        expect(tagged.costCenterId).toBe(costCenterId);
        expect(tagged.profitCenterId).toBe(profitCenterId);

        const costCleared = await positions.update(hrAdminClaims, position.id, { costCenterId: null });
        expect(costCleared.costCenterId).toBeNull();
        // profitCenterId was omitted, not nulled — it must be unaffected.
        expect(costCleared.profitCenterId).toBe(profitCenterId);
      });

      it("freeze()/abolish()/assignEmployee()/unassignEmployee() preserve the cost/profit center tags across the transition", async () => {
        const position = await positions.create(hrAdminClaims, {
          orgUnitId: engineeringUnitId,
          positionTitle: "Tagged Transition Seat",
          costCenterId,
          profitCenterId,
        });
        const employee = await employees.create(hrAdminClaims, { firstName: "Tagged", lastName: "Occupant" });

        const filled = await positions.assignEmployee(hrAdminClaims, position.id, employee.id);
        expect(filled).toMatchObject({ costCenterId, profitCenterId, status: "filled" });

        const vacated = await positions.unassignEmployee(hrAdminClaims, position.id);
        expect(vacated).toMatchObject({ costCenterId, profitCenterId, status: "vacant" });

        const frozen = await positions.freeze(hrAdminClaims, position.id);
        expect(frozen).toMatchObject({ costCenterId, profitCenterId, status: "frozen" });
      });
    });

    it("a Line Manager (position.view.all only) can read positions but not mutate them", async () => {
      const list = await positions.list(managerClaims);
      expect(Array.isArray(list)).toBe(true);
      await expect(positions.create(managerClaims, { orgUnitId: engineeringUnitId, positionTitle: "Nope" })).rejects.toThrow(
        ForbiddenException
      );
    });

    it("404s the whole module when `employee` is disabled for the tenant", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = false WHERE company_id = $1 AND module_key = 'employee'", [
          companyId,
        ])
      );
      await expect(positions.list(hrAdminClaims)).rejects.toThrow(NotFoundException);
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = true WHERE company_id = $1 AND module_key = 'employee'", [
          companyId,
        ])
      );
    });
  });

  describe("tenant isolation (RLS)", () => {
    it("a position created in one tenant is invisible to another tenant's session", async () => {
      const companyAId = await createFixtureCompany("Position Isolation A");
      const companyBId = await createFixtureCompany("Position Isolation B");
      const hrAdminA = await createUser(`pos-iso-a-${Date.now()}@example.com`);
      const hrAdminB = await createUser(`pos-iso-b-${Date.now()}@example.com`);
      await assignRole(hrAdminA, companyAId, "hr_admin");
      await assignRole(hrAdminB, companyBId, "hr_admin");
      const claimsA: RequestClaims = { is_platform_admin: false, company_id: companyAId, sub: hrAdminA };
      const claimsB: RequestClaims = { is_platform_admin: false, company_id: companyBId, sub: hrAdminB };

      const unitA = await orgUnits.create(claimsA, { name: "A-Only Unit", unitType: "department" });
      const positionA = await positions.create(claimsA, { orgUnitId: unitA.id, positionTitle: "A-Only Seat" });

      await expect(positions.get(claimsB, positionA.id)).rejects.toThrow(NotFoundException);
      const listB = await positions.list(claimsB);
      expect(listB.find((p) => p.id === positionA.id)).toBeUndefined();
    });
  });

  /**
   * Organization Management, Phase 6 — Events. Confirms
   * `org.position.changed` really enqueues end to end through a real
   * WebhookDispatchService, the same pattern as
   * `employees.service.spec.ts`'s own "webhook events" block. `positions`
   * above (this file's shared instance) is built WITHOUT a
   * WebhookDispatchService — proving the optional-dependency design
   * doesn't secretly break anything for it — so this uses its own instance
   * instead.
   */
  describe("webhook events (Organization Management Phase 6)", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let orgUnitId: string;
    let positionsWithWebhooks: PositionsService;
    const platformClaims: RequestClaims = { is_platform_admin: true, company_id: null, sub: "position-webhook-spec" };

    beforeAll(async () => {
      companyId = await createFixtureCompany("Position Webhook Co");
      const hrAdminUserId = await createUser(`position-webhook-hr-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

      await new IntegrationsService(db, new AuditService()).configure(platformClaims, companyId, "webhook", {
        enabled: true,
        config: { url: "http://127.0.0.1:1/hook", signingSecret: "position-trigger-secret" },
      });

      const rbac = new RbacService(db);
      const entitlements = new EntitlementsService(db);
      const audit = new AuditService();
      orgUnitId = (
        await new OrgUnitsService(db, rbac, entitlements, audit, new EffectiveDatingEngine()).create(hrAdminClaims, {
          name: "Webhook Dept",
          unitType: "department",
        })
      ).id;

      positionsWithWebhooks = new PositionsService(
        db,
        rbac,
        entitlements,
        audit,
        new EffectiveDatingEngine(),
        new WebhookDispatchService(db, new AuditService())
      );
    });

    async function latestEventFor(type: string) {
      // enqueue() is fire-and-forget — give its own DB write a moment to
      // land before asserting.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const result = await db.withClaims(platformClaims, (client) =>
        client.query(
          "SELECT * FROM webhook_events WHERE company_id = $1 AND event_type = $2 ORDER BY created_at DESC LIMIT 1",
          [companyId, type]
        )
      );
      return result.rows[0];
    }

    it("enqueues org.position.changed on create()", async () => {
      const created = await positionsWithWebhooks.create(hrAdminClaims, { orgUnitId, positionTitle: "Webhook Seat" });
      const event = await latestEventFor("org.position.changed");
      expect(event).toBeDefined();
      expect(event.payload.eventVersion).toBe(1);
      expect(event.payload.changeType).toBe("create");
      expect(event.payload.position.id).toBe(created.id);
    });

    it("enqueues org.position.changed with changeType 'position.freeze' on freeze()", async () => {
      const created = await positionsWithWebhooks.create(hrAdminClaims, { orgUnitId, positionTitle: "Freeze Seat" });
      await positionsWithWebhooks.freeze(hrAdminClaims, created.id);
      const event = await latestEventFor("org.position.changed");
      expect(event.payload.changeType).toBe("position.freeze");
      expect(event.payload.position.status).toBe("frozen");
    });

    it("enqueues org.position.changed with changeType 'position.assign'/'position.unassign' on occupancy changes", async () => {
      const created = await positionsWithWebhooks.create(hrAdminClaims, { orgUnitId, positionTitle: "Occupied Seat" });
      const employee = await employees.create(hrAdminClaims, { firstName: "Webhook", lastName: "Occupant" });

      await positionsWithWebhooks.assignEmployee(hrAdminClaims, created.id, employee.id);
      const assignedEvent = await latestEventFor("org.position.changed");
      expect(assignedEvent.payload.changeType).toBe("position.assign");
      expect(assignedEvent.payload.position.status).toBe("filled");

      await positionsWithWebhooks.unassignEmployee(hrAdminClaims, created.id);
      const unassignedEvent = await latestEventFor("org.position.changed");
      expect(unassignedEvent.payload.changeType).toBe("position.unassign");
      expect(unassignedEvent.payload.position.status).toBe("vacant");
    });
  });

  describe("Data Scope (Organization Management Phase 11, Section 19)", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let regionalHrClaims: RequestClaims;
    let regionalFinanceClaims: RequestClaims;
    let assignedOrgUnitId: string;
    let otherOrgUnitId: string;
    let assignedCostCenterId: string;
    let positionInScopeByOrgUnit: string;
    let positionInScopeByCostCenterOnly: string;
    let positionOutOfScope: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Position Scope Co");
      const stamp = Date.now();
      const hrAdminUserId = await createUser(`pos-scope-hr-${stamp}@example.com`);
      const regionalHrUserId = await createUser(`pos-scope-regional-hr-${stamp}@example.com`);
      const regionalFinanceUserId = await createUser(`pos-scope-regional-finance-${stamp}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      await assignRole(regionalHrUserId, companyId, "regional_hr");
      await assignRole(regionalFinanceUserId, companyId, "regional_finance");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      regionalHrClaims = { is_platform_admin: false, company_id: companyId, sub: regionalHrUserId };
      regionalFinanceClaims = { is_platform_admin: false, company_id: companyId, sub: regionalFinanceUserId };

      assignedOrgUnitId = (await orgUnits.create(hrAdminClaims, { name: "Scoped Division", unitType: "division" })).id;
      otherOrgUnitId = (await orgUnits.create(hrAdminClaims, { name: "Other Division", unitType: "division" })).id;
      assignedCostCenterId = (await costCenters.create(hrAdminClaims, { name: "Scoped CC" })).id;

      positionInScopeByOrgUnit = (
        await positions.create(hrAdminClaims, { orgUnitId: assignedOrgUnitId, positionTitle: "In-Scope by Org Unit" })
      ).id;
      positionInScopeByCostCenterOnly = (
        await positions.create(hrAdminClaims, {
          orgUnitId: otherOrgUnitId,
          positionTitle: "In-Scope by Cost Center Only",
          costCenterId: assignedCostCenterId,
        })
      ).id;
      positionOutOfScope = (
        await positions.create(hrAdminClaims, { orgUnitId: otherOrgUnitId, positionTitle: "Out of Scope" })
      ).id;

      await assignDataScope(regionalHrUserId, companyId, "org_unit", assignedOrgUnitId);
      await assignDataScope(regionalFinanceUserId, companyId, "cost_center", assignedCostCenterId);
    });

    it("regional_hr (org-unit scope) sees positions in their unit but not elsewhere, regardless of cost center", async () => {
      const visible = await positions.list(regionalHrClaims);
      const ids = visible.map((p) => p.id);
      expect(ids).toContain(positionInScopeByOrgUnit);
      expect(ids).not.toContain(positionInScopeByCostCenterOnly);
      expect(ids).not.toContain(positionOutOfScope);
    });

    it("regional_finance (cost-center scope) sees positions tagged with their cost center regardless of org unit, but nothing else", async () => {
      const visible = await positions.list(regionalFinanceClaims);
      const ids = visible.map((p) => p.id);
      expect(ids).toContain(positionInScopeByCostCenterOnly);
      expect(ids).not.toContain(positionInScopeByOrgUnit);
      expect(ids).not.toContain(positionOutOfScope);
    });

    it("get() 404s a scoped caller on a position outside every dimension they hold", async () => {
      await expect(positions.get(regionalHrClaims, positionOutOfScope)).rejects.toThrow(NotFoundException);
      await expect(positions.get(regionalFinanceClaims, positionOutOfScope)).rejects.toThrow(NotFoundException);
    });

    // Cross-module integration audit (2026-10-01), gap #3/#7 —
    // 0111_write_scope_data_scope_enforcement.sql gave `regional_hr`/
    // `regional_finance` the write-side `position.manage.scoped`
    // alongside their existing read-side `.view.scoped` — these cover the
    // create/update/assign/unassign paths the audit found were still
    // `.all`-only even after Phase 11's read-side fix.
    describe("write-side (position.manage.scoped, gap #3/#7)", () => {
      it("regional_hr can create a position inside their assigned org unit", async () => {
        const created = await positions.create(regionalHrClaims, {
          orgUnitId: assignedOrgUnitId,
          positionTitle: "Regional HR Created",
        });
        expect(created.orgUnitId).toBe(assignedOrgUnitId);
      });

      it("regional_hr cannot create a position outside their assigned org unit or cost center", async () => {
        await expect(
          positions.create(regionalHrClaims, { orgUnitId: otherOrgUnitId, positionTitle: "Should Be Blocked" })
        ).rejects.toThrow(ForbiddenException);
      });

      it("regional_hr cannot update a position outside their scope", async () => {
        await expect(
          positions.update(regionalHrClaims, positionOutOfScope, { positionTitle: "Renamed by regional_hr" })
        ).rejects.toThrow(ForbiddenException);
      });

      it("regional_hr can rename a position inside their scope but cannot move it to an org unit outside their scope", async () => {
        const renamed = await positions.update(regionalHrClaims, positionInScopeByOrgUnit, {
          positionTitle: "Renamed In Scope",
        });
        expect(renamed.positionTitle).toBe("Renamed In Scope");

        await expect(
          positions.update(regionalHrClaims, positionInScopeByOrgUnit, { orgUnitId: otherOrgUnitId })
        ).rejects.toThrow(ForbiddenException);
      });

      it("regional_hr cannot freeze, assign to, or unassign a position outside their scope", async () => {
        await expect(positions.freeze(regionalHrClaims, positionOutOfScope)).rejects.toThrow(ForbiddenException);
        await expect(
          positions.assignEmployee(regionalHrClaims, positionOutOfScope, "00000000-0000-0000-0000-000000000000")
        ).rejects.toThrow(ForbiddenException);
        await expect(positions.unassignEmployee(regionalHrClaims, positionOutOfScope)).rejects.toThrow(ForbiddenException);
      });

      it("regional_finance (cost-center scope) can update the position tagged with their cost center but not one tagged with no cost center outside their org unit", async () => {
        const renamed = await positions.update(regionalFinanceClaims, positionInScopeByCostCenterOnly, {
          positionTitle: "Renamed by regional_finance",
        });
        expect(renamed.positionTitle).toBe("Renamed by regional_finance");

        await expect(
          positions.update(regionalFinanceClaims, positionOutOfScope, { positionTitle: "Should Be Blocked" })
        ).rejects.toThrow(ForbiddenException);
      });
    });
  });
});
