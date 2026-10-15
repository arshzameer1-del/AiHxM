import { Pool } from "pg";
import { BadRequestException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { WorkflowService } from "../workflow/workflow.service";
import { OrgChangesService } from "./org-changes.service";
import { OrgOccupancyService } from "./occupancy/org-occupancy.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "org-changes-step7" };

/** Gap Register ORG-07: a reorganization can batch positions, locations, cost / profit centers and assignments, and a failed batch can be resumed. */
describe("Reorganization of more than org units (Step 7C / ORG-07)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let changes: OrgChangesService;
  let occupancy: OrgOccupancyService;
  let companyId: string;
  let hr: RequestClaims;
  let unitA: string;
  let unitB: string;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const sql = <T = Record<string, unknown>>(q: string, p: unknown[] = []) => db.withClaims(FIXTURE, async (c) => (await c.query(q, p)).rows as T[]);
  let n = 0;

  const newPosition = async (title: string, orgUnitId = unitA) =>
    (await sql<{ id: string }>("INSERT INTO positions (company_id, org_unit_id, position_title) VALUES ($1,$2,$3) RETURNING id", [companyId, orgUnitId, title]))[0].id;
  const newEmployee = async (first: string, orgUnitId = unitA) =>
    (
      await sql<{ id: string }>(
        "INSERT INTO employees (company_id, employee_number, first_name, last_name, org_unit_id) VALUES ($1,$2,$3,'Reorg',$4) RETURNING id",
        [companyId, `RG-${stamp}-${++n}`, first, orgUnitId]
      )
    )[0].id;

  async function approve(changeId: string) {
    await changes.validate(hr, changeId);
    await changes.analyzeImpact(hr, changeId);
    const submitted = await changes.submitForApproval(hr, changeId);
    return changes.decide(hr, submitted.id, { decision: "approved" });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    const eff = new EffectiveDatingEngine();
    const workflow = new WorkflowService(db, rbac, audit);
    occupancy = new OrgOccupancyService(audit, eff);
    changes = new OrgChangesService(db, rbac, ent, audit, eff, workflow, undefined, occupancy);

    companyId = await db.withClaims(FIXTURE, async (c) => {
      const co = await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Reorg7 ${stamp}`, `reorg7-${stamp}`]);
      await c.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format) VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [co.rows[0].id]
      );
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true)", [co.rows[0].id]);
      return co.rows[0].id as string;
    });
    hr = await db.withClaims(FIXTURE, async (c) => {
      const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`reorg7-hr-${stamp}@example.com`]);
      for (const role of ["hr_admin", "rbac_demo_full_access"]) {
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE key=$3))", [u.rows[0].id, companyId, role]);
      }
      return { is_platform_admin: false, company_id: companyId, sub: u.rows[0].id } as RequestClaims;
    });
    [unitA, unitB] = await db.withClaims(FIXTURE, async (c) => {
      const ids: string[] = [];
      for (const name of ["Ops", "Delivery"]) {
        ids.push((await c.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1,'department',$2) RETURNING id", [companyId, name])).rows[0].id);
      }
      return ids;
    });
    const roleId = (await sql<{ id: string }>("SELECT id FROM roles WHERE key = 'hr_admin'"))[0].id;
    await new WorkflowService(db, rbac, audit).createTemplate(hr, {
      key: "org_reorganization",
      name: "Reorganization Approval",
      objectKey: "org_reorganization",
      steps: [{ stepOrder: 1, name: "HR Admin approves", approvers: [{ approverType: "role", roleId }] }],
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  it("applies a mixed batch - position, location, cost / profit center and employee transfer - as versioned, audited changes", async () => {
    const seat = await newPosition("Ops Lead");
    const frozen = await newPosition("Ops Analyst");
    const mover = await newEmployee("Transferred");
    const loc = (await sql<{ id: string }>("INSERT INTO locations (company_id, location_type, name) VALUES ($1,'site','Old Site') RETURNING id", [companyId]))[0].id;
    const cc = (await sql<{ id: string }>("INSERT INTO cost_centers (company_id, code, name) VALUES ($1,'CC-7','Ops CC') RETURNING id", [companyId]))[0].id;
    const pc = (await sql<{ id: string }>("INSERT INTO profit_centers (company_id, code, name) VALUES ($1,'PC-7','Ops PC') RETURNING id", [companyId]))[0].id;

    const change = await changes.create(hr, {
      title: "Ops restructure",
      effectiveDate: "2020-01-01",
      items: [
        { entityType: "position", entityId: seat, action: "position_rename", newName: "Head of Ops" },
        { entityType: "position", entityId: frozen, action: "position_freeze" },
        { entityType: "position", entityId: seat, action: "position_move", payload: { orgUnitId: unitB } },
        { entityType: "location", entityId: loc, action: "location_rename", newName: "New Site" },
        { entityType: "cost_center", entityId: cc, action: "cost_center_archive" },
        { entityType: "profit_center", entityId: pc, action: "profit_center_rename", newName: "Delivery PC" },
        { entityType: "assignment", entityId: mover, action: "assignment_transfer", payload: { orgUnitId: unitB } },
      ],
    });
    expect(change.items.map((i) => i.entityType)).toEqual(["position", "position", "position", "location", "cost_center", "profit_center", "assignment"]);

    const done = await approve(change.id);
    expect(done.status).toBe("published");
    expect(done.items.every((i) => i.appliedAt)).toBe(true);

    expect((await sql<{ position_title: string; org_unit_id: string }>("SELECT position_title, org_unit_id FROM positions WHERE id = $1", [seat]))[0]).toEqual({ position_title: "Head of Ops", org_unit_id: unitB });
    expect((await sql<{ status: string }>("SELECT status FROM positions WHERE id = $1", [frozen]))[0].status).toBe("frozen");
    expect((await sql<{ name: string }>("SELECT name FROM locations WHERE id = $1", [loc]))[0].name).toBe("New Site");
    expect((await sql<{ status: string }>("SELECT status FROM cost_centers WHERE id = $1", [cc]))[0].status).toBe("archived");
    expect((await sql<{ name: string }>("SELECT name FROM profit_centers WHERE id = $1", [pc]))[0].name).toBe("Delivery PC");
    expect((await sql<{ org_unit_id: string; department: string }>("SELECT org_unit_id, department FROM employees WHERE id = $1", [mover]))[0]).toEqual({ org_unit_id: unitB, department: "Delivery" });
    expect((await sql<{ org_unit_id: string }>("SELECT org_unit_id FROM employee_org_assignments WHERE employee_id = $1 AND assignment_type = 'primary' AND status = 'active'", [mover]))[0].org_unit_id).toBe(unitB);

    // versioned history exists for the entities, not just the base rows
    expect((await sql("SELECT 1 FROM position_versions WHERE position_id = $1 AND position_title = 'Head of Ops'", [seat])).length).toBe(1);
    expect((await sql("SELECT 1 FROM location_versions WHERE location_id = $1 AND name = 'New Site'", [loc])).length).toBe(1);
    expect((await sql("SELECT 1 FROM audit_log WHERE company_id = $1 AND action = 'position.freeze' AND target = $2", [companyId, frozen])).length).toBe(1);
  });

  it("rejects an action that does not belong to the entity type, and validate() reports missing / unknown targets", async () => {
    const seat = await newPosition("Wrong Action");
    await expect(
      changes.create(hr, { title: "bad", effectiveDate: "2020-01-01", items: [{ entityType: "position", entityId: seat, action: "location_rename", newName: "x" }] })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      changes.create(hr, { title: "no id", effectiveDate: "2020-01-01", items: [{ entityType: "location", action: "location_archive" }] })
    ).rejects.toBeInstanceOf(BadRequestException);

    const change = await changes.create(hr, {
      title: "validation",
      effectiveDate: "2020-01-01",
      items: [
        { entityType: "position", entityId: seat, action: "position_rename" },
        { entityType: "location", entityId: "00000000-0000-0000-0000-000000000001", action: "location_archive" },
        { entityType: "assignment", entityId: seat, action: "assignment_transfer", payload: {} },
      ],
    });
    const result = await changes.validate(hr, change.id);
    expect(result.valid).toBe(false);
    const text = result.errors.join(" | ");
    expect(text).toMatch(/position_rename.*requires a newName/);
    expect(text).toMatch(/location 00000000.* not found/);
    expect(text).toMatch(/assignment_transfer.*requires payload.orgUnitId/);
  });

  it("a failed batch can be resumed: applied items are skipped, the failing one runs once the data problem is fixed", async () => {
    const renamed = await newPosition("To Rename");
    const occupied = await newPosition("Occupied Seat");
    const holder = await newEmployee("Holder");
    await db.withClaims(hr, (c) => occupancy.assignPositionWithinTransaction(c, hr, { positionId: occupied, employeeId: holder }));

    const change = await changes.create(hr, {
      title: "Resumable",
      effectiveDate: "2020-01-01",
      items: [
        { entityType: "position", entityId: renamed, action: "position_rename", newName: "Renamed Once" },
        { entityType: "position", entityId: occupied, action: "position_move", payload: { orgUnitId: unitB } },
      ],
    });
    const failed = await approve(change.id);
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toMatch(/Item 2 \(position_move on position/);
    expect(failed.items[0].appliedAt).not.toBeNull();
    expect(failed.items[1].appliedAt).toBeNull();
    const firstApplied = failed.items[0].appliedAt;

    await expect(changes.resume(hr, "00000000-0000-0000-0000-000000000009")).rejects.toThrow();
    // still blocked while the seat is occupied
    expect((await changes.resume(hr, change.id)).status).toBe("failed");

    await db.withClaims(hr, (c) => occupancy.vacatePositionWithinTransaction(c, hr, { positionId: occupied }));
    const resumed = await changes.resume(hr, change.id);
    expect(resumed.status).toBe("published");
    expect(resumed.failureReason).toBeNull();
    expect(resumed.items[0].appliedAt).toBe(firstApplied); // not re-applied
    expect((await sql<{ org_unit_id: string }>("SELECT org_unit_id FROM positions WHERE id = $1", [occupied]))[0].org_unit_id).toBe(unitB);
    expect((await sql("SELECT 1 FROM audit_log WHERE company_id = $1 AND action = 'position.rename' AND target = $2", [companyId, renamed])).length).toBe(1);

    await expect(changes.resume(hr, change.id)).rejects.toBeInstanceOf(BadRequestException);
  });
});
