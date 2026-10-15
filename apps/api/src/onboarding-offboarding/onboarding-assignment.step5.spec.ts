import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EmployeesService } from "../employees/employees.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { OnboardingService, matchesApplicability, normalizeApplicability } from "./onboarding.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "onboarding-step5-fixtures" };

/** Gap Register LIF-09: onboarding item assignment, due dates, applicability. */
describe("Onboarding assignment (LIF-09)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let onboarding: OnboardingService;
  let employees: EmployeesService;
  let companyId: string;
  let hr: RequestClaims;
  let staff: RequestClaims;
  let mgrClaims: RequestClaims;
  let staffUserId: string;
  let mgrUserId: string;
  let empId: string;
  let contractorId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const audit = new AuditService();
    onboarding = new OnboardingService(db, new RbacService(db), new EntitlementsService(db), audit);
    employees = new EmployeesService(db, new RbacService(db), new EntitlementsService(db), audit, new LocalFileStorageService());

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const c = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [`Onb Assign ${stamp}`, `onb-assign-${stamp}`]);
      companyId = c.rows[0].id;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee", "recruitment"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [companyId]
      );
      await client.query(
        "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true), ($1, 'recruitment', true)",
        [companyId]
      );
    });
    const mkUser = async (email: string, role: string) =>
      db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const u = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]);
        const r = await client.query("SELECT id FROM roles WHERE key = $1", [role]);
        await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, companyId, r.rows[0].id]);
        return u.rows[0].id as string;
      });
    const hrId = await mkUser(`onb5-hr-${stamp}@example.com`, "hr_admin");
    staffUserId = await mkUser(`onb5-staff-${stamp}@example.com`, "employee_self_service");
    mgrUserId = await mkUser(`onb5-mgr-${stamp}@example.com`, "line_manager");
    hr = { is_platform_admin: false, company_id: companyId, sub: hrId };
    staff = { is_platform_admin: false, company_id: companyId, sub: staffUserId };
    mgrClaims = { is_platform_admin: false, company_id: companyId, sub: mgrUserId };

    const mgrEmp = await employees.create(hr, { firstName: "Mina", lastName: "Manager" });
    await db.withClaims(FIXTURE_CLAIMS, (c) => c.query("UPDATE employees SET user_account_id = $1 WHERE id = $2", [mgrUserId, mgrEmp.id]));
    const e = await employees.create(hr, { firstName: "Esha", lastName: "Employee", managerId: mgrEmp.id });
    empId = e.id;
    await db.withClaims(FIXTURE_CLAIMS, (c) => c.query("UPDATE employees SET user_account_id = $1 WHERE id = $2", [staffUserId, empId]));
    const k = await employees.create(hr, { firstName: "Kamran", lastName: "Contractor", managerId: mgrEmp.id });
    contractorId = k.id;
    await db.withClaims(FIXTURE_CLAIMS, (c) => c.query("UPDATE employees SET employment_type = 'contract' WHERE id = $1", [contractorId]));
  });

  afterAll(async () => {
    await pool.end();
  });

  it("normalizes applicability and matches only when every restricted dimension matches", () => {
    expect(normalizeApplicability({ employmentTypes: ["a", "a", " "], orgUnitIds: [] })).toEqual({ employmentTypes: ["a"] });
    expect(normalizeApplicability(null)).toEqual({});
    const emp = { employment_type: "permanent", org_unit_id: "u1", location_id: null };
    expect(matchesApplicability({}, emp)).toBe(true);
    expect(matchesApplicability({ employmentTypes: ["permanent"] }, emp)).toBe(true);
    expect(matchesApplicability({ employmentTypes: ["contract"] }, emp)).toBe(false);
    expect(matchesApplicability({ orgUnitIds: ["u1"], employmentTypes: ["permanent"] }, emp)).toBe(true);
    // restricted on location but the employee has none -> not applicable
    expect(matchesApplicability({ locationIds: ["l1"] }, emp)).toBe(false);
  });

  it("template create/update persists applicability, assignee rule and due offset", async () => {
    const t = await onboarding.createItemTemplate(hr, {
      title: "Sign contract addendum", category: "hr", responsibleRole: "all",
      applicability: { employmentTypes: ["contract"] }, assigneeRule: "manager", dueOffsetDays: 5,
    });
    expect(t.applicability).toEqual({ employmentTypes: ["contract"] });
    expect(t.assigneeRule).toBe("manager");
    expect(t.dueOffsetDays).toBe(5);
    const u = await onboarding.updateItemTemplate(hr, t.id, { dueOffsetDays: null, assigneeRule: "none" });
    expect(u.dueOffsetDays).toBeNull();
    expect(u.assigneeRule).toBe("none");
    expect(u.applicability).toEqual({ employmentTypes: ["contract"] });
    await onboarding.deactivateItemTemplate(hr, t.id);
  });

  it("initiate filters by applicability and resolves assignee + due date", async () => {
    await onboarding.createItemTemplate(hr, { title: "Read handbook", category: "hr", responsibleRole: "self", assigneeRule: "employee", dueOffsetDays: 3 });
    await onboarding.createItemTemplate(hr, { title: "Approve probation plan", category: "hr", responsibleRole: "team", assigneeRule: "manager", dueOffsetDays: 0 });
    await onboarding.createItemTemplate(hr, { title: "Contractor NDA", category: "hr", responsibleRole: "all", applicability: { employmentTypes: ["contract"] } });
    await onboarding.createItemTemplate(hr, { title: "Karachi office badge", category: "facilities", responsibleRole: "all", applicability: { locationIds: ["00000000-0000-0000-0000-0000000000aa"] } });

    const permanent = await onboarding.initiateOnboarding(hr, empId);
    const titles = permanent.items.map((i) => i.title);
    expect(titles).toContain("Read handbook");
    expect(titles).not.toContain("Contractor NDA");
    expect(titles).not.toContain("Karachi office badge");
    const handbook = permanent.items.find((i) => i.title === "Read handbook")!;
    expect(handbook.assignedToUserAccountId).toBe(staffUserId);
    expect(handbook.assignedAt).not.toBeNull();
    expect(handbook.dueDate).not.toBeNull();
    const probation = permanent.items.find((i) => i.title === "Approve probation plan")!;
    expect(probation.assignedToUserAccountId).toBe(mgrUserId);
    expect(probation.isOverdue).toBe(false);

    const contract = await onboarding.initiateOnboarding(hr, contractorId);
    expect(contract.items.map((i) => i.title)).toContain("Contractor NDA");
    const nda = contract.items.find((i) => i.title === "Contractor NDA")!;
    expect(nda.assignedToUserAccountId).toBeNull();
    expect(nda.dueDate).toBeNull();
  });

  it("my-items lists the caller's pending assigned items, soonest first", async () => {
    const mine = await onboarding.listMyItems(staff);
    expect(mine.map((i) => i.title)).toEqual(["Read handbook"]);
    expect(mine[0].employeeName).toBe("Esha Employee");
    const mgrItems = await onboarding.listMyItems(mgrClaims);
    expect(mgrItems.map((i) => i.title)).toContain("Approve probation plan");
  });

  it("HR can reassign, clear and re-date; rejects non-members, non-HR and decided items", async () => {
    const mine = await onboarding.listMyItems(staff);
    const itemId = mine[0].id;
    await expect(onboarding.assignItem(staff, itemId, { assignedToUserAccountId: mgrUserId })).rejects.toThrow(ForbiddenException);

    const outsider = await db.withClaims(FIXTURE_CLAIMS, async (c) => {
      const r = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`onb5-out-${Date.now()}@example.com`]);
      return r.rows[0].id as string;
    });
    await expect(onboarding.assignItem(hr, itemId, { assignedToUserAccountId: outsider })).rejects.toThrow(BadRequestException);

    const moved = await onboarding.assignItem(hr, itemId, { assignedToUserAccountId: mgrUserId, dueDate: "2020-01-01" });
    expect(moved.assignedToUserAccountId).toBe(mgrUserId);
    expect(moved.dueDate).toBe("2020-01-01");
    expect(moved.isOverdue).toBe(true);

    const overdue = await onboarding.listOverdue(hr);
    expect(overdue.map((i) => i.id)).toContain(itemId);
    await expect(onboarding.listOverdue(staff)).rejects.toThrow(ForbiddenException);

    const cleared = await onboarding.assignItem(hr, itemId, { assignedToUserAccountId: null, dueDate: null });
    expect(cleared.assignedToUserAccountId).toBeNull();
    expect(cleared.assignedAt).toBeNull();
    expect(cleared.dueDate).toBeNull();

    await onboarding.updateItem(hr, itemId, { status: "completed" });
    await expect(onboarding.assignItem(hr, itemId, { assignedToUserAccountId: mgrUserId })).rejects.toThrow(ConflictException);
  });

  it("the assignment audit trail is recorded", async () => {
    const rows = await db.withClaims(FIXTURE_CLAIMS, (c) =>
      c.query("SELECT 1 FROM audit_log WHERE company_id = $1 AND action = 'onboarding.item.assign'", [companyId])
    );
    expect(rows.rowCount).toBeGreaterThanOrEqual(2);
  });
});
