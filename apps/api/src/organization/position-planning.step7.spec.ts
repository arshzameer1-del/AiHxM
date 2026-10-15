import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { EmployeesService } from "../employees/employees.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { WorkflowService } from "../workflow/workflow.service";
import { WorkflowAdapterRegistry } from "../workflow/workflow-adapter.registry";
import { InboxService } from "../workflow/inbox.service";
import { HrBusinessPolicyService } from "../hr-administration/hr-business-policy.service";
import { RecruitmentService } from "../recruitment/recruitment.service";
import { PositionsService } from "./positions.service";
import { PositionPlanningService } from "./position-planning.service";
import { OrgOccupancyService } from "./occupancy/org-occupancy.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "position-planning-step7" };

/** Gap Register ORG-02 (multi-incumbent, budgets, position relationships, position approval) and ORG-01 (requisition <-> position). */
describe("Position planning & requisition link (Step 7B)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let positions: PositionsService;
  let planning: PositionPlanningService;
  let employees: EmployeesService;
  let recruitment: RecruitmentService;
  let workflow: WorkflowService;
  let inbox: InboxService;
  let companyId: string;
  let hr: RequestClaims;
  let approver: RequestClaims;
  let admin: RequestClaims;
  let nobody: RequestClaims;
  let engId: string;
  let salesId: string;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const sql = <T = Record<string, unknown>>(q: string, p: unknown[] = []) => db.withClaims(FIXTURE, async (c) => (await c.query(q, p)).rows as T[]);
  let n = 0;
  const seat = (headcountFte: number, orgUnitId = engId) =>
    positions.create(hr, { orgUnitId, positionTitle: `Seat ${++n}-${stamp}`, headcountFte });
  const person = (name: string) => employees.create(hr, { firstName: name, lastName: "P", orgUnitId: engId });

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    const eff = new EffectiveDatingEngine();
    const registry = new WorkflowAdapterRegistry();
    workflow = new WorkflowService(db, rbac, audit, registry);
    inbox = new InboxService(db, rbac, audit, workflow, registry, new LocalFileStorageService());
    const occupancy = new OrgOccupancyService(audit, eff);
    positions = new PositionsService(db, rbac, ent, audit, eff, undefined, occupancy, workflow);
    planning = new PositionPlanningService(db, positions, audit);
    employees = new EmployeesService(db, rbac, ent, audit, new LocalFileStorageService());
    recruitment = new RecruitmentService(db, rbac, ent, audit, workflow, employees, new HrBusinessPolicyService(db, rbac, ent, audit), occupancy);

    companyId = await db.withClaims(FIXTURE, async (c) => {
      const co = await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Plan7 ${stamp}`, `plan7-${stamp}`]);
      await c.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format) VALUES ($1, '["employee","recruitment"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [co.rows[0].id]
      );
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true), ($1,'recruitment',true)", [co.rows[0].id]);
      return co.rows[0].id as string;
    });
    const mk = async (label: string, role: string) =>
      db.withClaims(FIXTURE, async (c) => {
        const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`plan7-${label}-${stamp}@example.com`]);
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE key=$3))", [u.rows[0].id, companyId, role]);
        return { is_platform_admin: false, company_id: companyId, sub: u.rows[0].id } as RequestClaims;
      });
    hr = await mk("hr", "hr_admin");
    approver = await mk("approver", "hr_admin");
    admin = await mk("admin", "rbac_demo_full_access");
    nobody = await mk("nobody", "system_admin");
    [engId, salesId] = await db.withClaims(FIXTURE, async (c) => {
      const ids: string[] = [];
      for (const name of ["Engineering", "Sales"]) {
        ids.push((await c.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1,'department',$2) RETURNING id", [companyId, name])).rows[0].id);
      }
      return ids;
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  describe("ORG-02: multi-incumbent positions", () => {
    it("a 2-FTE position stays vacant until its capacity is used, then becomes filled; a third assignment is refused", async () => {
      const p = await seat(2);
      const [a, b, c] = [await person("A"), await person("B"), await person("C")];
      expect((await positions.assignEmployee(hr, p.id, a.id)).status).toBe("vacant");
      expect((await positions.assignEmployee(hr, p.id, b.id)).status).toBe("filled");
      await expect(positions.assignEmployee(hr, p.id, c.id)).rejects.toBeInstanceOf(ConflictException);
      const incumbents = await planning.listIncumbents(hr, p.id);
      expect(incumbents.map((i) => i.employeeId).sort()).toEqual([a.id, b.id].sort());
      expect(incumbents.every((i) => i.fte === 1)).toBe(true);
    });

    it("an employee-specific unassign frees one slot and leaves the other incumbent in place", async () => {
      const p = await seat(2);
      const [a, b] = [await person("D"), await person("E")];
      await positions.assignEmployee(hr, p.id, a.id);
      await positions.assignEmployee(hr, p.id, b.id);
      const after = await positions.unassignEmployee(hr, p.id, undefined, a.id);
      expect(after.status).toBe("vacant");
      expect((await planning.listIncumbents(hr, p.id)).map((i) => i.employeeId)).toEqual([b.id]);
      expect((await sql<{ position_id: string | null }>("SELECT position_id FROM employees WHERE id = $1", [a.id]))[0].position_id).toBeNull();
      expect((await sql<{ position_id: string | null }>("SELECT position_id FROM employees WHERE id = $1", [b.id]))[0].position_id).toBe(p.id);
      // history is kept
      expect((await planning.listIncumbents(hr, p.id, true)).length).toBe(2);
    });

    it("a whole-seat unassign ends every incumbent", async () => {
      const p = await seat(2);
      await positions.assignEmployee(hr, p.id, (await person("F")).id);
      await positions.assignEmployee(hr, p.id, (await person("G")).id);
      const after = await positions.unassignEmployee(hr, p.id);
      expect(after.status).toBe("vacant");
      expect(await planning.listIncumbents(hr, p.id)).toEqual([]);
    });

    it("freeze / abolish are refused while anybody still holds a slot, even though the seat reads vacant", async () => {
      const p = await seat(2);
      await positions.assignEmployee(hr, p.id, (await person("H")).id);
      await expect(positions.freeze(hr, p.id)).rejects.toBeInstanceOf(BadRequestException);
      await expect(positions.abolish(hr, p.id)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("raising the approved FTE of a filled single seat reopens capacity", async () => {
      const p = await seat(1);
      await positions.assignEmployee(hr, p.id, (await person("I")).id);
      expect((await positions.get(hr, p.id)).status).toBe("filled");
      expect((await positions.update(hr, p.id, { headcountFte: 2 })).status).toBe("vacant");
    });

    it("moving an employee between seats frees only their own slot on the old one", async () => {
      const [s1, s2] = [await seat(2), await seat(1)];
      const [x, y] = [await person("J"), await person("K")];
      await positions.assignEmployee(hr, s1.id, x.id);
      await positions.assignEmployee(hr, s1.id, y.id);
      await positions.assignEmployee(hr, s2.id, x.id);
      expect((await planning.listIncumbents(hr, s1.id)).map((i) => i.employeeId)).toEqual([y.id]);
      expect((await positions.get(hr, s1.id)).status).toBe("vacant");
      expect((await positions.get(hr, s2.id)).status).toBe("filled");
    });
  });

  describe("ORG-02: budgets and position-to-position relationships", () => {
    it("upserts and lists a fiscal-year budget; the planning summary reports planned vs filled", async () => {
      const p = await seat(2);
      await positions.assignEmployee(hr, p.id, (await person("L")).id);
      const b = await planning.upsertBudget(hr, p.id, 2027, { plannedHeadcount: 3, budgetAmount: 9_000_000 });
      expect(b).toMatchObject({ fiscalYear: 2027, plannedHeadcount: 3, budgetAmount: 9000000, currency: "PKR" });
      const again = await planning.upsertBudget(hr, p.id, 2027, { plannedHeadcount: 1 });
      expect(again.id).toBe(b.id);
      expect((await planning.listBudgets(hr, p.id)).length).toBe(1);
      const row = (await planning.summary(hr, 2027)).find((r) => r.positionId === p.id)!;
      expect(row).toMatchObject({ approvedHeadcount: 2, plannedHeadcount: 1, filledFte: 1, openCapacityFte: 1 });
      await planning.deleteBudget(hr, p.id, 2027);
      expect(await planning.listBudgets(hr, p.id)).toEqual([]);
    });

    it("budget and relationship writes need position.manage (a caller without it is refused)", async () => {
      const p = await seat(1);
      await expect(planning.upsertBudget(nobody, p.id, 2027, { plannedHeadcount: 1 })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("reports_to is single-parent (a new one supersedes) and cycles are refused", async () => {
      const [a, b, c] = [await seat(1), await seat(1), await seat(1)];
      await planning.createRelationship(hr, a.id, { relatedPositionId: b.id, relationshipType: "reports_to" });
      await planning.createRelationship(hr, b.id, { relatedPositionId: c.id, relationshipType: "reports_to" });
      await expect(planning.createRelationship(hr, c.id, { relatedPositionId: a.id, relationshipType: "reports_to" })).rejects.toBeInstanceOf(BadRequestException);
      await expect(planning.createRelationship(hr, a.id, { relatedPositionId: a.id, relationshipType: "reports_to" })).rejects.toBeInstanceOf(BadRequestException);
      await planning.createRelationship(hr, a.id, { relatedPositionId: c.id, relationshipType: "reports_to" });
      const open = await planning.listRelationships(hr, a.id);
      expect(open.filter((r) => r.relationshipType === "reports_to").map((r) => r.relatedPositionId)).toEqual([c.id]);
    });

    it("dotted-line relationships can be several, but not duplicated; ending one removes it from the open list", async () => {
      const [a, b, c] = [await seat(1), await seat(1), await seat(1)];
      const d1 = await planning.createRelationship(hr, a.id, { relatedPositionId: b.id, relationshipType: "dotted_line" });
      await planning.createRelationship(hr, a.id, { relatedPositionId: c.id, relationshipType: "dotted_line" });
      await expect(planning.createRelationship(hr, a.id, { relatedPositionId: b.id, relationshipType: "dotted_line" })).rejects.toBeInstanceOf(ConflictException);
      await planning.endRelationship(hr, a.id, d1.id);
      expect((await planning.listRelationships(hr, a.id)).map((r) => r.relatedPositionId)).toEqual([c.id]);
    });
  });

  describe("ORG-02: creating a position through the workflow engine", () => {
    beforeAll(async () => {
      await workflow.createTemplate(admin, {
        key: `position-${stamp}`,
        name: "Position approval",
        objectKey: "position",
        steps: [{ stepOrder: 1, name: "Head of HR", approvers: [{ approverType: "specific_user", userAccountId: approver.sub }] }],
      });
    });

    it("starts pending_approval, cannot be assigned, and becomes vacant when the approver approves from My Inbox", async () => {
      const p = await seat(1);
      expect(p.status).toBe("pending_approval");
      await expect(positions.assignEmployee(hr, p.id, (await person("M")).id)).rejects.toBeInstanceOf(ConflictException);
      await expect(positions.update(hr, p.id, { positionTitle: "Changed" })).rejects.toBeInstanceOf(BadRequestException);
      const [{ workflow_instance_id: iid }] = await sql<{ workflow_instance_id: string }>("SELECT workflow_instance_id FROM positions WHERE id = $1", [p.id]);
      expect(iid).not.toBeNull();
      await inbox.decide(approver, iid, { decision: "approved" });
      expect((await positions.get(hr, p.id)).status).toBe("vacant");
      expect((await positions.assignEmployee(hr, p.id, (await person("N")).id)).status).toBe("filled");
    });

    it("a rejection marks the position rejected; it can then be abolished but never filled", async () => {
      const p = await seat(1);
      const [{ workflow_instance_id: iid }] = await sql<{ workflow_instance_id: string }>("SELECT workflow_instance_id FROM positions WHERE id = $1", [p.id]);
      await inbox.decide(approver, iid, { decision: "rejected", comment: "no budget" });
      expect((await positions.get(hr, p.id)).status).toBe("rejected");
      await expect(positions.assignEmployee(hr, p.id, (await person("O")).id)).rejects.toBeInstanceOf(ConflictException);
      expect((await positions.abolish(hr, p.id)).status).toBe("abolished");
    });
  });

  describe("ORG-01: requisitions are raised against positions", () => {
    it("derives department from the position's org unit and rejects a mismatching org unit", async () => {
      await sql("UPDATE workflow_templates SET is_active = false WHERE company_id = $1 AND object_key = 'position'", [companyId]);
      const p = await seat(1, salesId);
      const req = await recruitment.createRequisition(hr, { title: "Sales Exec", positionId: p.id });
      expect(req).toMatchObject({ positionId: p.id, orgUnitId: salesId, department: "Sales", status: "draft" });
      await expect(recruitment.createRequisition(hr, { title: "X", positionId: p.id, orgUnitId: engId })).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuses a position that is not vacant, and a headcount beyond the unreserved capacity", async () => {
      const filled = await seat(1);
      await positions.assignEmployee(hr, filled.id, (await person("P")).id);
      await expect(recruitment.createRequisition(hr, { title: "X", positionId: filled.id })).rejects.toBeInstanceOf(BadRequestException);

      const two = await seat(2);
      await recruitment.createRequisition(hr, { title: "First", positionId: two.id, headcount: 2 });
      await expect(recruitment.createRequisition(hr, { title: "Second", positionId: two.id, headcount: 1 })).rejects.toBeInstanceOf(ConflictException);
    });

    it("hiring policy requirePositionForRequisition makes a position mandatory", async () => {
      await sql(`INSERT INTO hr_business_policies (company_id, policy_type, code, name, rules, is_default) VALUES ($1,'hiring','default','Hiring','{"requirePositionForRequisition": true}'::jsonb, true)`, [companyId]);
      await expect(recruitment.createRequisition(hr, { title: "No seat" })).rejects.toBeInstanceOf(BadRequestException);
      const p = await seat(1);
      await expect(recruitment.createRequisition(hr, { title: "With seat", positionId: p.id })).resolves.toMatchObject({ positionId: p.id });
      await sql("UPDATE hr_business_policies SET is_default = false WHERE company_id = $1 AND policy_type = 'hiring'", [companyId]);
    });

    it("a draft can be edited (link re-validated); status actions follow the allowed transitions and need a reason where required", async () => {
      const p = await seat(1);
      const req = await recruitment.createRequisition(hr, { title: "Editable" });
      const edited = await recruitment.updateRequisition(hr, req.id, { positionId: p.id, title: "Edited" });
      expect(edited).toMatchObject({ positionId: p.id, title: "Edited" });
      await sql("UPDATE job_requisitions SET status = 'approved' WHERE id = $1", [req.id]);
      await expect(recruitment.updateRequisition(hr, req.id, { title: "Nope" })).rejects.toBeInstanceOf(BadRequestException);
      expect((await recruitment.applyRequisitionAction(hr, req.id, "open")).status).toBe("open");
      await expect(recruitment.applyRequisitionAction(hr, req.id, "hold")).rejects.toBeInstanceOf(BadRequestException);
      expect((await recruitment.applyRequisitionAction(hr, req.id, "hold", "budget freeze")).status).toBe("on_hold");
      expect((await recruitment.applyRequisitionAction(hr, req.id, "resume")).status).toBe("open");
      expect((await recruitment.applyRequisitionAction(hr, req.id, "fill")).status).toBe("filled");
      await expect(recruitment.applyRequisitionAction(hr, req.id, "open")).rejects.toBeInstanceOf(BadRequestException);
      const other = await recruitment.createRequisition(hr, { title: "To cancel" });
      expect((await recruitment.applyRequisitionAction(hr, other.id, "cancel", "role dropped")).status).toBe("cancelled");
    });

    it("accepting an offer counts the hire, seats the new employee in the position and completes the requisition", async () => {
      const p = await seat(1, salesId);
      const req = await recruitment.createRequisition(hr, { title: "Sales Rep", positionId: p.id });
      await sql("UPDATE job_requisitions SET status = 'open' WHERE id = $1", [req.id]);
      const cand = await recruitment.createCandidate(hr, { firstName: "Hira", lastName: "Seated" });
      const app = await recruitment.createApplication(hr, { requisitionId: req.id, candidateId: cand.id });
      const offer = await recruitment.extendOffer(hr, { applicationId: app.id, salary: 100000, startDate: "2026-11-01" });
      const res = await recruitment.decideOffer(hr, offer.id, "accepted");
      const [emp] = await sql<{ position_id: string | null; org_unit_id: string | null }>("SELECT position_id, org_unit_id FROM employees WHERE id = $1", [res.employee!.id]);
      expect(emp).toMatchObject({ position_id: p.id, org_unit_id: salesId });
      expect((await positions.get(hr, p.id)).status).toBe("filled");
      expect(await recruitment.getRequisition(hr, req.id)).toMatchObject({ filledHeadcount: 1, status: "filled" });
    });
  });
});
