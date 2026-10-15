import { Pool } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { EmployeesService } from "../employees/employees.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { OrgUnitsService } from "./org-units.service";
import { PositionsService } from "./positions.service";
import { OrgStructureService } from "./org-structure.service";
import type { OrgStructureNode } from "@aihxm/shared-types";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "org-structure-spec-fixtures" };

/**
 * The "Staff assignments (structure)" read model: units, their positions (chief position first) and holders as one
 * nested tree with validity dates and each unit's chief. Real Postgres, no mocks.
 */
describe("OrgStructureService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let orgUnits: OrgUnitsService;
  let positions: PositionsService;
  let employees: EmployeesService;
  let structure: OrgStructureService;

  let companyId: string;
  let otherCompanyId: string;
  let hrClaims: RequestClaims;
  let essClaims: RequestClaims;
  let otherHrClaims: RequestClaims;
  let rootId: string;
  let presidentOfficeId: string;
  let sharedServicesId: string;
  let presidentPositionId: string;
  let advisorPositionId: string;
  let ceoId: string;

  async function company(prefix: string) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const c = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [`${prefix} ${stamp}`, `${prefix.toLowerCase()}-${stamp}`]);
      const id = c.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [id]);
      return id;
    });
  }
  async function user(email: string, companyIdForRole: string, roleKey: string) {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const u = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]);
      const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, companyIdForRole, role.rows[0].id]);
      return u.rows[0].id as string;
    });
  }
  const walk = (nodes: OrgStructureNode[]): OrgStructureNode[] => nodes.flatMap((n) => [n, ...walk(n.children)]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    orgUnits = new OrgUnitsService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    positions = new PositionsService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
    structure = new OrgStructureService(db, orgUnits, positions, employees);

    companyId = await company("Structure Co");
    otherCompanyId = await company("Structure Other");
    const stamp = Date.now();
    hrClaims = { is_platform_admin: false, company_id: companyId, sub: await user(`struct-hr-${stamp}@example.com`, companyId, "hr_admin") };
    essClaims = { is_platform_admin: false, company_id: companyId, sub: await user(`struct-ess-${stamp}@example.com`, companyId, "employee_self_service") };
    otherHrClaims = { is_platform_admin: false, company_id: otherCompanyId, sub: await user(`struct-other-${stamp}@example.com`, otherCompanyId, "hr_admin") };

    rootId = (await orgUnits.create(hrClaims, { name: "Marine Services", unitType: "business_unit", code: "AMS" })).id;
    presidentOfficeId = (await orgUnits.create(hrClaims, { name: "President Office", unitType: "division", code: "PRES", parentId: rootId })).id;
    sharedServicesId = (await orgUnits.create(hrClaims, { name: "Shared Services", unitType: "department", code: "SHARED", parentId: presidentOfficeId })).id;
    advisorPositionId = (await positions.create(hrClaims, { orgUnitId: presidentOfficeId, positionTitle: "Financial Advisor", positionCode: "FIN" })).id;
    presidentPositionId = (await positions.create(hrClaims, { orgUnitId: presidentOfficeId, positionTitle: "President", positionCode: "PRESIDENT" })).id;
    await orgUnits.setHeadPosition(hrClaims, presidentOfficeId, { positionId: presidentPositionId });
    ceoId = (await employees.create(hrClaims, { firstName: "Ahmed", lastName: "Aziz", department: "Office" })).id;
    await positions.assignEmployee(hrClaims, presidentPositionId, ceoId);
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = ANY($1::uuid[])", [[companyId, otherCompanyId]]));
    await pool.end();
  });

  it("nests unit, then its positions (chief first), then sub-units, with holders under positions", async () => {
    const view = await structure.getStructure(hrClaims);
    expect(view.peopleVisible).toBe(true);
    expect(view.roots.map((r) => r.name)).toEqual(["Marine Services"]);
    const root = view.roots[0];
    expect(root).toMatchObject({ kind: "unit", code: "AMS", relationshipText: "", status: "active" });
    const office = root.children[0];
    expect(office).toMatchObject({ kind: "unit", name: "President Office", relationshipText: "Is line supervisor of", chiefName: "Ahmed Aziz" });
    // chief position first, then the other position, then the sub-unit
    expect(office.children.map((c) => `${c.kind}:${c.name}`)).toEqual(["position:President", "position:Financial Advisor", "unit:Shared Services"]);
    const president = office.children[0];
    expect(president).toMatchObject({ isChief: true, relationshipText: "Incorporates", code: "PRESIDENT", status: "filled" });
    expect(president.children).toHaveLength(1);
    expect(president.children[0]).toMatchObject({ kind: "holder", name: "Ahmed Aziz", relationshipText: "Holder" });
    expect(office.children[1]).toMatchObject({ isChief: false, status: "vacant", children: [] });
  });

  it("gives every row an object id with its type letter, and today's date as valid-from with no end", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const nodes = walk((await structure.getStructure(hrClaims)).roots);
    for (const n of nodes) {
      expect(n.objectId).toMatch(n.kind === "unit" ? /^O [0-9A-F]{8}$/ : n.kind === "position" ? /^S [0-9A-F]{8}$/ : /^P [0-9A-F]{8}$/);
      expect(n.validFrom).toBe(today);
      expect(n.validTo).toBeNull();
    }
    expect(new Set(nodes.map((n) => n.key)).size).toBe(nodes.length);
  });

  it("shows an archived unit as ended", async () => {
    await orgUnits.archive(hrClaims, sharedServicesId);
    const nodes = walk((await structure.getStructure(hrClaims)).roots);
    const shared = nodes.find((n) => n.id === sharedServicesId)!;
    expect(shared.status).toBe("archived");
    expect(shared.validTo).not.toBeNull();
    await orgUnits.activate(hrClaims, sharedServicesId);
  });

  it("shows an ordinary employee the units and positions but never the people holding them", async () => {
    const nodes = walk((await structure.getStructure(essClaims)).roots);
    expect(nodes.filter((n) => n.kind === "unit").map((n) => n.name).sort()).toEqual(["Marine Services", "President Office", "Shared Services"]);
    expect(nodes.filter((n) => n.kind === "position").map((n) => n.name).sort()).toEqual(["Financial Advisor", "President"]);
    // The holder and the chief are people: an employee who may not open that employee record does not get the name.
    expect(nodes.filter((n) => n.kind === "holder")).toEqual([]);
    expect(nodes.every((n) => n.chiefName === null)).toBe(true);
    expect(JSON.stringify(nodes)).not.toContain("Ahmed");
  });

  it("never mixes tenants", async () => {
    const other = await structure.getStructure(otherHrClaims);
    expect(other.roots).toEqual([]);
    expect(JSON.stringify(other)).not.toContain("Marine Services");
    await expect(structure.getStructure({ is_platform_admin: false, company_id: null, sub: "nobody" })).rejects.toThrow();
  });
});
