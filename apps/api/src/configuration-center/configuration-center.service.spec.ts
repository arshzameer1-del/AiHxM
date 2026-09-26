import { Pool } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EmployeeGroupsService } from "../employee-groups/employee-groups.service";
import { ShiftsService } from "../shifts/shifts.service";
import { HolidaysService } from "../holidays/holidays.service";
import { WorkflowService } from "../workflow/workflow.service";
import { PayrollService } from "../payroll/payroll.service";
import { CustomFieldsService } from "../custom-fields/custom-fields.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { RulesEngine } from "../rules-engine/rules-engine.engine";
import { OrgUnitsService } from "../organization/org-units.service";
import { JobsService } from "../organization/jobs.service";
import { LocationsService } from "../organization/locations.service";
import { CostCentersService } from "../organization/cost-centers.service";
import { ProfitCentersService } from "../organization/profit-centers.service";
import { ConfigurationCenterService } from "./configuration-center.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "config-center-spec-fixtures" };

/**
 * Real Postgres, no mocks — same discipline as every other module this
 * session. This is deliberately a thin aggregation layer, so its own
 * tests are less about business logic and more about proving the two
 * things that matter for a cross-module index: (1) it reuses each
 * domain's real permission check rather than a parallel one -- a role
 * that can't manage workflow templates (hr_admin, without also holding
 * system_admin) genuinely doesn't get that card, not because this
 * service re-implements RBAC, but because WorkflowService.listTemplates
 * itself throws; and (2) counts reflect real rows in real tables.
 */
describe("ConfigurationCenterService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let configurationCenter: ConfigurationCenterService;
  let employeeGroups: EmployeeGroupsService;
  let holidays: HolidaysService;
  let orgUnits: OrgUnitsService;
  let jobs: JobsService;
  let locations: LocationsService;
  let costCenters: CostCentersService;
  let profitCenters: ProfitCentersService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    employeeGroups = new EmployeeGroupsService(db, rbac, entitlements, new EffectiveDatingEngine(), new RulesEngine());
    const shifts = new ShiftsService(db, rbac, entitlements, audit, new EffectiveDatingEngine(), new RulesEngine());
    holidays = new HolidaysService(db, rbac, entitlements, audit);
    const workflow = new WorkflowService(db, rbac, audit);
    const payroll = new PayrollService(db, rbac, entitlements, audit, {} as never, new EffectiveDatingEngine());
    const customFields = new CustomFieldsService(db, rbac);
    orgUnits = new OrgUnitsService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    jobs = new JobsService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    locations = new LocationsService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    costCenters = new CostCentersService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    profitCenters = new ProfitCentersService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    configurationCenter = new ConfigurationCenterService(
      db,
      employeeGroups,
      shifts,
      holidays,
      workflow,
      payroll,
      customFields,
      orgUnits,
      jobs,
      locations,
      costCenters,
      profitCenters
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createFixtureCompany(namePrefix: string, modules: string[] = ["employee", "leave", "payroll"]) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `${namePrefix} ${stamp}`,
        `${namePrefix.toLowerCase().replace(/\s+/g, "-")}-${stamp}`,
      ]);
      const companyId = company.rows[0].id;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, $2::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [companyId, JSON.stringify(modules)]
      );
      for (const moduleKey of modules) {
        await client.query(
          "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, $2, true)",
          [companyId, moduleKey]
        );
      }
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

  describe("getSummary()", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let hrAdminAndSystemAdminClaims: RequestClaims;
    let staffClaims: RequestClaims;
    let systemAdminOnlyClaims: RequestClaims;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Config Center Co");

      const hrAdminUserId = await createUser(`config-center-hr-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

      const dualUserId = await createUser(`config-center-dual-${Date.now()}@example.com`);
      await assignRole(dualUserId, companyId, "hr_admin");
      await assignRole(dualUserId, companyId, "system_admin");
      hrAdminAndSystemAdminClaims = { is_platform_admin: false, company_id: companyId, sub: dualUserId };

      const staffUserId = await createUser(`config-center-staff-${Date.now()}@example.com`);
      await assignRole(staffUserId, companyId, "employee_self_service");
      staffClaims = { is_platform_admin: false, company_id: companyId, sub: staffUserId };

      // Holds NEITHER org_unit.view.all NOR org_unit.manage.all (0066's
      // seed grants those only to hr_admin/line_manager/employee_self_
      // service) — the one seeded role combination that can prove the
      // org_unit card is really gated by OrgUnitsService's own RBAC check,
      // the same way workflow_template's own test below proves it for
      // WorkflowService.
      const systemAdminOnlyUserId = await createUser(`config-center-sysadmin-only-${Date.now()}@example.com`);
      await assignRole(systemAdminOnlyUserId, companyId, "system_admin");
      systemAdminOnlyClaims = { is_platform_admin: false, company_id: companyId, sub: systemAdminOnlyUserId };

      // Real data in a couple of domains so counts are provably non-zero,
      // not just "didn't throw".
      await employeeGroups.createLeavePolicy(hrAdminClaims, { name: "Config Center Test Policy" });
      await holidays.createHoliday(hrAdminClaims, { name: "Config Center Test Holiday", holidayDate: "2026-11-11" });
      await orgUnits.create(hrAdminClaims, { name: "Config Center Test Unit", unitType: "department" });
      await jobs.create(hrAdminClaims, { title: "Config Center Test Job" });
      // Organization Management Phase 4 — real Location/Cost Center/Profit
      // Center rows so those three cards' counts are provably non-zero too.
      await locations.create(hrAdminClaims, { name: "Config Center Test Location", locationType: "site" });
      await costCenters.create(hrAdminClaims, { name: "Config Center Test Cost Center" });
      await profitCenters.create(hrAdminClaims, { name: "Config Center Test Profit Center" });
    });

    it("includes every domain hr_admin can manage, with real counts, but omits Workflow Templates", async () => {
      const summary = await configurationCenter.getSummary(hrAdminClaims);
      const byKey = Object.fromEntries(summary.map((s) => [s.domainKey, s]));

      expect(byKey.leave_policy).toBeDefined();
      expect(byKey.leave_policy.count).toBeGreaterThanOrEqual(1);
      expect(byKey.holiday).toBeDefined();
      expect(byKey.holiday.count).toBeGreaterThanOrEqual(1);
      expect(byKey.employee_group).toBeDefined();
      expect(byKey.shift).toBeDefined();
      expect(byKey.tax_slab).toBeDefined();
      expect(byKey.custom_field).toBeDefined();
      // Organization Management Phase 1 — the Org Units card, backed by
      // OrgUnitsService.list(), not a duplicated count query.
      expect(byKey.org_unit).toBeDefined();
      expect(byKey.org_unit.count).toBeGreaterThanOrEqual(1);
      expect(byKey.org_unit.adminRoute).toBe("/app/organization");
      expect(byKey.org_unit.supportsEffectiveDating).toBe(true);

      // Organization Management Phase 2 — the Job Catalog card, backed by
      // JobsService.list(), not a duplicated count query. Position is
      // deliberately absent (0070's own header comment — it's operational
      // data, not a setup catalog, so it never gets a registry row at all).
      expect(byKey.job).toBeDefined();
      expect(byKey.job.count).toBeGreaterThanOrEqual(1);
      expect(byKey.job.adminRoute).toBe("/app/organization/jobs");
      expect(byKey.job.supportsEffectiveDating).toBe(true);
      expect(byKey.position).toBeUndefined();

      // Organization Management Phase 4 — Location/Cost Center/Profit
      // Center cards, each backed by that domain's own list(), not a
      // duplicated count query (0075's own header comment).
      expect(byKey.location).toBeDefined();
      expect(byKey.location.count).toBeGreaterThanOrEqual(1);
      expect(byKey.location.supportsEffectiveDating).toBe(true);
      expect(byKey.cost_center).toBeDefined();
      expect(byKey.cost_center.count).toBeGreaterThanOrEqual(1);
      expect(byKey.profit_center).toBeDefined();
      expect(byKey.profit_center.count).toBeGreaterThanOrEqual(1);

      // hr_admin does not hold workflow_template.manage.all (that's
      // system_admin's job, per Decision #20) -- this proves the
      // aggregator really defers to WorkflowService's own RBAC check
      // rather than granting access itself.
      expect(byKey.workflow_template).toBeUndefined();
    });

    it("includes Workflow Templates once the caller also holds system_admin", async () => {
      const summary = await configurationCenter.getSummary(hrAdminAndSystemAdminClaims);
      const byKey = Object.fromEntries(summary.map((s) => [s.domainKey, s]));
      expect(byKey.workflow_template).toBeDefined();
      expect(byKey.workflow_template.count).toBeGreaterThanOrEqual(0);
    });

    it("returns a much narrower summary for a plain employee_self_service login", async () => {
      const summary = await configurationCenter.getSummary(staffClaims);
      const domainKeys = summary.map((s) => s.domainKey);
      // Staff manage nothing HR-configuration-shaped. Two domains
      // legitimately still appear: custom_field (no permission gate at
      // all, matching CustomFieldsService.listDefinitions) and holiday
      // (holiday.view.all is deliberately granted broadly to every role
      // per Holiday Management's own design -- "every employee
      // legitimately needs to see the identical calendar").
      expect(domainKeys).not.toContain("leave_policy");
      expect(domainKeys).not.toContain("shift");
      expect(domainKeys).not.toContain("employee_group");
      expect(domainKeys).not.toContain("tax_slab");
      expect(domainKeys).not.toContain("workflow_template");
      expect(domainKeys).toEqual(expect.arrayContaining(["holiday", "custom_field"]));
    });

    it("still includes org_unit for a plain employee_self_service login (org_unit.view.all is seeded broadly)", async () => {
      const summary = await configurationCenter.getSummary(staffClaims);
      const orgUnitRow = summary.find((s) => s.domainKey === "org_unit");
      expect(orgUnitRow).toBeDefined();
      expect(typeof orgUnitRow?.count).toBe("number");
    });

    it("still includes job for a plain employee_self_service login (job.view.all is seeded broadly, 0069's seed)", async () => {
      const summary = await configurationCenter.getSummary(staffClaims);
      const jobRow = summary.find((s) => s.domainKey === "job");
      expect(jobRow).toBeDefined();
      expect(typeof jobRow?.count).toBe("number");
    });

    it("omits org_unit for a role holding neither org_unit.view.all nor org_unit.manage.all", async () => {
      const summary = await configurationCenter.getSummary(systemAdminOnlyClaims);
      const domainKeys = summary.map((s) => s.domainKey);
      expect(domainKeys).not.toContain("org_unit");
      // Same caller DOES see workflow_template — proves this is a
      // domain-specific gate (OrgUnitsService's own RBAC check), not this
      // login being denied the whole summary.
      expect(domainKeys).toContain("workflow_template");
    });

    it("omits job for a role holding neither job.view.all nor job.manage.all", async () => {
      const summary = await configurationCenter.getSummary(systemAdminOnlyClaims);
      const domainKeys = summary.map((s) => s.domainKey);
      expect(domainKeys).not.toContain("job");
      expect(domainKeys).not.toContain("position");
    });

    it("every returned summary row carries a real admin route and label from the registry", async () => {
      const summary = await configurationCenter.getSummary(hrAdminClaims);
      for (const row of summary) {
        expect(row.adminRoute).toMatch(/^\/app\//);
        expect(row.label.length).toBeGreaterThan(0);
        expect(typeof row.count).toBe("number");
      }
    });
  });

  describe("getSummary() — a tenant with Payroll disabled", () => {
    // Regression test: EntitlementsService gates every domain BEFORE
    // RBAC, and a disabled module throws NotFoundException, not
    // ForbiddenException (Decision #5 -- "a disabled module 404s, never
    // 403 or an empty list"). ConfigurationCenterService's countFor()
    // originally only caught ForbiddenException, so calling
    // PayrollService.listTaxSlabs() for a tenant with payroll disabled
    // threw an uncaught NotFoundException straight out of getSummary(),
    // which would 404 the ENTIRE endpoint -- hiding every other domain's
    // card too, not just tax_slab's. Fixed by catching NotFoundException
    // alongside ForbiddenException; this test pins that behavior.
    it("still returns every other domain's card instead of failing the whole summary", async () => {
      const companyId = await createFixtureCompany("No Payroll Co", ["employee", "leave"]);
      const hrAdminUserId = await createUser(`config-center-nopayroll-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      const claims: RequestClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

      const summary = await configurationCenter.getSummary(claims);
      const domainKeys = summary.map((s) => s.domainKey);

      expect(domainKeys).not.toContain("tax_slab");
      expect(domainKeys).toEqual(
        expect.arrayContaining([
          "leave_policy",
          "employee_group",
          "shift",
          "holiday",
          "org_unit",
          "job",
          "location",
          "cost_center",
          "profit_center",
        ])
      );
    });
  });
});
