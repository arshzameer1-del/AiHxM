import { Pool } from "pg";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { EmployeesService } from "../employees/employees.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { OrgRelationshipsService } from "./org-relationships.service";
import { PositionsService } from "./positions.service";
import { LegacyReconciliationService } from "./legacy-reconciliation.service";
import { OrgReconciliationService } from "./org-reconciliation.service";
import { OrgOccupancyService } from "./occupancy/org-occupancy.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "org-recon-step7" };

/** Gap Register ORG-03 (single writer + drift repair), ORG-09 (unambiguous-only backfill with an unresolved log). */
describe("Organization reconciliation (Step 7A)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let employees: EmployeesService;
  let recon: OrgReconciliationService;
  let companyId: string;
  let hr: RequestClaims;
  let nobody: RequestClaims;
  let engId: string, salesId: string, fin1Id: string, fin2Id: string, lahoreId: string;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const sql = <T = Record<string, unknown>>(q: string, p: unknown[] = []) => db.withClaims(FIXTURE, async (c) => (await c.query(q, p)).rows as T[]);

  async function legacyEmployee(first: string, patch: { department?: string; location?: string; managerId?: string } = {}) {
    const e = await employees.create(hr, { firstName: first, lastName: "Legacy" });
    if (patch.department || patch.location || patch.managerId) {
      await sql("UPDATE employees SET department = COALESCE($2, department), location = COALESCE($3, location), manager_id = COALESCE($4, manager_id) WHERE id = $1", [e.id, patch.department ?? null, patch.location ?? null, patch.managerId ?? null]);
    }
    return e;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    const eff = new EffectiveDatingEngine();
    const occupancy = new OrgOccupancyService(audit, eff);
    employees = new EmployeesService(db, rbac, ent, audit, new LocalFileStorageService());
    const relationships = new OrgRelationshipsService(db, rbac, ent, audit, eff);
    const positions = new PositionsService(db, rbac, ent, audit, eff);
    const legacy = new LegacyReconciliationService(db, ent, rbac, employees, relationships, positions);
    recon = new OrgReconciliationService(db, rbac, ent, audit, legacy, occupancy);

    companyId = await db.withClaims(FIXTURE, async (c) => {
      const co = await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Recon7 ${stamp}`, `recon7-${stamp}`]);
      await c.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format) VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [co.rows[0].id]
      );
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true)", [co.rows[0].id]);
      return co.rows[0].id as string;
    });
    const mk = async (label: string, role: string) =>
      db.withClaims(FIXTURE, async (c) => {
        const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`recon7-${label}-${stamp}@example.com`]);
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE key=$3))", [u.rows[0].id, companyId, role]);
        return { is_platform_admin: false, company_id: companyId, sub: u.rows[0].id } as RequestClaims;
      });
    hr = await mk("hr", "hr_admin");
    nobody = await mk("nobody", "system_admin");
    [engId, salesId, fin1Id, fin2Id] = await db.withClaims(FIXTURE, async (c) => {
      const ids: string[] = [];
      for (const n of ["Engineering", "Sales", "Finance", "Finance"]) {
        ids.push((await c.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1,'department',$2) RETURNING id", [companyId, n])).rows[0].id);
      }
      return ids;
    });
    lahoreId = (await sql<{ id: string }>("INSERT INTO locations (company_id, location_type, name) VALUES ($1,'site','Lahore Office') RETURNING id", [companyId]))[0].id;
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  describe("ORG-03: the primary assignment is kept in step by the generic employee writes", () => {
    it("creating an employee with an org unit opens its primary assignment", async () => {
      const e = await employees.create(hr, { firstName: "Created", lastName: "InUnit", orgUnitId: engId });
      const [a] = await sql<{ org_unit_id: string }>("SELECT org_unit_id FROM employee_org_assignments WHERE employee_id = $1 AND assignment_type = 'primary' AND status = 'active'", [e.id]);
      expect(a.org_unit_id).toBe(engId);
    });

    it("changing the org unit / location through PATCH moves the assignment in the same transaction", async () => {
      const e = await employees.create(hr, { firstName: "Patched", lastName: "Unit", orgUnitId: engId });
      await employees.update(hr, e.id, { orgUnitId: salesId, locationId: lahoreId });
      const [a] = await sql<{ org_unit_id: string; location_id: string }>("SELECT org_unit_id, location_id FROM employee_org_assignments WHERE employee_id = $1 AND assignment_type = 'primary' AND status = 'active'", [e.id]);
      expect(a).toMatchObject({ org_unit_id: salesId, location_id: lahoreId });
      const history = await sql("SELECT 1 FROM employee_org_assignments WHERE employee_id = $1 AND assignment_type = 'primary'", [e.id]);
      expect(history.length).toBe(2); // the old one ended, the new one opened
    });

    it("an employee who holds a seat in another unit cannot be re-pointed with a plain PATCH", async () => {
      const e = await employees.create(hr, { firstName: "Seated", lastName: "Person", orgUnitId: engId });
      const pos = (await sql<{ id: string }>("INSERT INTO positions (company_id, org_unit_id, position_title) VALUES ($1,$2,'Engineer') RETURNING id", [companyId, engId]))[0].id;
      await sql("UPDATE employees SET position_id = $2 WHERE id = $1", [e.id, pos]);
      await expect(employees.update(hr, e.id, { orgUnitId: salesId })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("ORG-09: unambiguous-only backfill with an unresolved-mapping log", () => {
    let exact: string, ambiguous: string, fuzzy: string, none: string, mgrGap: string, mgr: string;
    beforeAll(async () => {
      mgr = (await employees.create(hr, { firstName: "Boss", lastName: "Person" })).id;
      exact = (await legacyEmployee("Exact", { department: "  engineering " })).id;
      ambiguous = (await legacyEmployee("Ambig", { department: "Finance" })).id;
      fuzzy = (await legacyEmployee("Fuzzy", { department: "Eng" })).id;
      none = (await legacyEmployee("None", { department: "Narnia" })).id;
      mgrGap = (await legacyEmployee("Mgr", { managerId: mgr })).id;
      void fin1Id; void fin2Id;
    });

    it("refuses callers without employee.manage.all", async () => {
      await expect(recon.runLegacyBackfill(nobody, {})).rejects.toBeInstanceOf(ForbiddenException);
      await expect(recon.runDriftRepair(nobody, {})).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("a dry run (the default) changes nothing but records what would happen", async () => {
      const { run, items } = await recon.runLegacyBackfill(hr, { gapTypes: ["department", "manager"] });
      expect(run).toMatchObject({ kind: "legacy_backfill", dryRun: true, status: "completed" });
      const byEmployee = new Map(items.map((i) => [i.employeeId, i]));
      expect(byEmployee.get(exact)).toMatchObject({ outcome: "would_apply", targetId: engId });
      expect(byEmployee.get(mgrGap)).toMatchObject({ outcome: "would_apply", targetId: mgr });
      expect(byEmployee.get(ambiguous)).toMatchObject({ outcome: "unresolved" });
      expect(byEmployee.get(ambiguous)!.reason).toMatch(/ambiguous/);
      expect(byEmployee.get(fuzzy)!.reason).toMatch(/fuzzy/);
      expect(byEmployee.get(none)!.reason).toMatch(/no matching/);
      expect((await sql<{ org_unit_id: string | null }>("SELECT org_unit_id FROM employees WHERE id = $1", [exact]))[0].org_unit_id).toBeNull();
    });

    it("applying links only the unambiguous ones, through the normal services, and logs the rest", async () => {
      const { run, items } = await recon.runLegacyBackfill(hr, { dryRun: false, gapTypes: ["department", "manager"] });
      expect(run.dryRun).toBe(false);
      expect(run.counts.applied).toBeGreaterThanOrEqual(2);
      const [e] = await sql<{ org_unit_id: string; department: string }>("SELECT org_unit_id, department FROM employees WHERE id = $1", [exact]);
      expect(e).toMatchObject({ org_unit_id: engId, department: "Engineering" }); // department re-derived from the canonical unit
      const [a] = await sql("SELECT 1 FROM employee_org_assignments WHERE employee_id = $1 AND assignment_type = 'primary' AND status = 'active'", [exact]);
      expect(a).toBeDefined(); // ORG-03 single writer: the assignment followed
      const [rel] = await sql<{ manager_employee_id: string }>("SELECT manager_employee_id FROM org_relationships WHERE employee_id = $1 AND relationship_type = 'direct' AND status = 'active'", [mgrGap]);
      expect(rel.manager_employee_id).toBe(mgr);
      for (const id of [ambiguous, fuzzy, none]) {
        expect(items.find((i) => i.employeeId === id)!.outcome).toBe("unresolved");
        expect((await sql<{ org_unit_id: string | null }>("SELECT org_unit_id FROM employees WHERE id = $1", [id]))[0].org_unit_id).toBeNull();
      }
      const unresolved = await recon.listUnresolved(hr, "department");
      expect(unresolved.map((u) => u.employeeId)).toEqual(expect.arrayContaining([ambiguous, fuzzy, none]));
      const detail = await recon.getRun(hr, run.id, "unresolved");
      expect(detail.items.length).toBe(3);
      expect((await recon.listRuns(hr)).some((r) => r.id === run.id)).toBe(true);
    });

    it("a repeat run finds nothing new to apply (idempotent)", async () => {
      const { run } = await recon.runLegacyBackfill(hr, { dryRun: false, gapTypes: ["department", "manager"] });
      expect(run.counts.applied ?? 0).toBe(0);
    });
  });

  describe("ORG-03: projection drift repair", () => {
    let drifted: string, noAssign: string;
    beforeAll(async () => {
      drifted = (await employees.create(hr, { firstName: "Drifted", lastName: "Unit", orgUnitId: engId })).id;
      await sql("UPDATE employees SET org_unit_id = $2, department = 'Sales' WHERE id = $1", [drifted, salesId]); // simulate a raw-SQL / legacy writer
      noAssign = (await employees.create(hr, { firstName: "NoAssign", lastName: "Unit" })).id;
      await sql("UPDATE employees SET org_unit_id = $2, department = 'Sales' WHERE id = $1", [noAssign, salesId]);
    });

    it("reports drift in a dry run without touching anything", async () => {
      const { items } = await recon.runDriftRepair(hr, { prefer: "assignment" });
      expect(items.find((i) => i.employeeId === drifted)).toMatchObject({ gapType: "projection_drift", outcome: "would_apply" });
      expect(items.find((i) => i.employeeId === noAssign)).toMatchObject({ gapType: "missing_primary_assignment", outcome: "would_apply" });
      expect((await sql<{ org_unit_id: string }>("SELECT org_unit_id FROM employees WHERE id = $1", [drifted]))[0].org_unit_id).toBe(salesId);
    });

    it("prefer=assignment sets the employee columns from the open primary assignment; missing assignments are opened", async () => {
      const { items } = await recon.runDriftRepair(hr, { dryRun: false, prefer: "assignment" });
      expect(items.find((i) => i.employeeId === drifted)!.outcome).toBe("applied");
      expect((await sql<{ org_unit_id: string; department: string }>("SELECT org_unit_id, department FROM employees WHERE id = $1", [drifted]))[0]).toMatchObject({ org_unit_id: engId, department: "Engineering" });
      const [a] = await sql<{ org_unit_id: string }>("SELECT org_unit_id FROM employee_org_assignments WHERE employee_id = $1 AND assignment_type = 'primary' AND status = 'active'", [noAssign]);
      expect(a.org_unit_id).toBe(salesId);
    });

    it("prefer=employee re-opens the assignment from the employee columns instead", async () => {
      await sql("UPDATE employees SET org_unit_id = $2, department = 'Sales' WHERE id = $1", [drifted, salesId]);
      await recon.runDriftRepair(hr, { dryRun: false, prefer: "employee" });
      const [a] = await sql<{ org_unit_id: string }>("SELECT org_unit_id FROM employee_org_assignments WHERE employee_id = $1 AND assignment_type = 'primary' AND status = 'active'", [drifted]);
      expect(a.org_unit_id).toBe(salesId);
      const { items } = await recon.runDriftRepair(hr, {});
      expect(items.find((i) => i.employeeId === drifted)).toBeUndefined(); // no drift left
    });

    it("a seat that differs is never guessed - it lands in the unresolved log", async () => {
      const e = (await employees.create(hr, { firstName: "Seat", lastName: "Drift", orgUnitId: engId })).id;
      const pos = (await sql<{ id: string }>("INSERT INTO positions (company_id, org_unit_id, position_title) VALUES ($1,$2,'Eng II') RETURNING id", [companyId, engId]))[0].id;
      await sql("UPDATE employees SET position_id = $2 WHERE id = $1", [e, pos]); // assignment still has no seat
      const { items } = await recon.runDriftRepair(hr, { dryRun: false, prefer: "assignment" });
      expect(items.find((i) => i.employeeId === e)).toMatchObject({ gapType: "position_mismatch", outcome: "unresolved" });
      expect((await sql<{ position_id: string }>("SELECT position_id FROM employees WHERE id = $1", [e]))[0].position_id).toBe(pos);
    });
  });
});
