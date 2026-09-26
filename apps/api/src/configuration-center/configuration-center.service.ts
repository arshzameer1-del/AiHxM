import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeGroupsService } from "../employee-groups/employee-groups.service";
import { ShiftsService } from "../shifts/shifts.service";
import { HolidaysService } from "../holidays/holidays.service";
import { WorkflowService } from "../workflow/workflow.service";
import { PayrollService } from "../payroll/payroll.service";
import { CustomFieldsService } from "../custom-fields/custom-fields.service";
import { OrgUnitsService } from "../organization/org-units.service";
import { JobsService } from "../organization/jobs.service";
import { LocationsService } from "../organization/locations.service";
import { CostCentersService } from "../organization/cost-centers.service";
import { ProfitCentersService } from "../organization/profit-centers.service";
import type { ConfigurationDomainSummary } from "@aihxm/shared-types";

type RegistryRow = {
  domain_key: string;
  label: string;
  description: string;
  admin_route: string;
  supports_effective_dating: boolean;
};

/**
 * Configuration Center (0032_configuration_center.sql): a single, real
 * screen that answers "what is configurable in this system" without
 * already knowing which of six scattered admin screens to open. This is
 * deliberately NOT a new store of configuration -- every count below comes
 * from calling that domain's own existing service method with the
 * caller's real claims, never a duplicated SQL query against that
 * domain's table. Each of those methods already enforces "entitlement,
 * then RBAC" internally (Section 20 of the master audit: AI/UI callers
 * must go through the same Service layer everything else does, never a
 * parallel data-access path) -- so a ForbiddenException here means
 * exactly what it would mean calling that module's own endpoint
 * directly: this caller doesn't currently have access to that domain,
 * and it silently loses its card rather than failing the whole summary.
 */
@Injectable()
export class ConfigurationCenterService {
  constructor(
    private readonly db: DatabaseService,
    private readonly employeeGroups: EmployeeGroupsService,
    private readonly shifts: ShiftsService,
    private readonly holidays: HolidaysService,
    private readonly workflow: WorkflowService,
    private readonly payroll: PayrollService,
    private readonly customFields: CustomFieldsService,
    private readonly orgUnits: OrgUnitsService,
    private readonly jobs: JobsService,
    private readonly locations: LocationsService,
    private readonly costCenters: CostCentersService,
    private readonly profitCenters: ProfitCentersService
  ) {}

  async getSummary(claims: RequestClaims): Promise<ConfigurationDomainSummary[]> {
    const registryRows = await this.db.withClaims(claims, async (client) => {
      const result = await client.query<RegistryRow>(
        `SELECT domain_key, label, description, admin_route, supports_effective_dating
         FROM configuration_registry ORDER BY sort_order ASC`
      );
      return result.rows;
    });

    const summaries: ConfigurationDomainSummary[] = [];
    for (const row of registryRows) {
      const count = await this.countFor(row.domain_key, claims);
      if (count === null) continue; // no access to this domain -- omit the card entirely
      summaries.push({
        domainKey: row.domain_key,
        label: row.label,
        description: row.description,
        adminRoute: row.admin_route,
        supportsEffectiveDating: row.supports_effective_dating,
        count,
      });
    }
    return summaries;
  }

  /** Returns null (not 0) when the caller has no view/manage access to this domain at all. */
  private async countFor(domainKey: string, claims: RequestClaims): Promise<number | null> {
    try {
      switch (domainKey) {
        case "leave_policy":
          return (await this.employeeGroups.listLeavePolicies(claims)).length;
        case "employee_group":
          return (await this.employeeGroups.listGroups(claims)).length;
        case "shift":
          return (await this.shifts.listShifts(claims)).length;
        case "holiday":
          return (await this.holidays.listHolidays(claims)).length;
        case "workflow_template":
          return (await this.workflow.listTemplates(claims)).length;
        case "custom_field":
          return await this.customFields.countAllDefinitions(claims);
        case "org_unit":
          // Organization Management Phase 1 (0065_organization_units.sql)
          // — OrgUnitsService.list() already applies entitlement-then-RBAC
          // (`employee` module, then org_unit.view.all/org_unit.manage.all)
          // exactly like every other case here; this counts every unit in
          // the tenant's hierarchy (flat, not just roots).
          return (await this.orgUnits.list(claims)).length;
        case "job":
          // Organization Management Phase 2 (0068_job_position_architecture.sql)
          // — JobsService.list() applies the same entitlement-then-RBAC
          // gate (`employee` module, then job.view.all/job.manage.all) as
          // every other case here. Position is deliberately NOT registered
          // in configuration_registry (0070's own header comment) — it's
          // operational/transactional data, not a setup catalog, so there
          // is no corresponding "position" case.
          return (await this.jobs.list(claims)).length;
        case "location":
          // Organization Management Phase 4
          // (0073_locations_and_financial_centers.sql) — LocationsService.list()
          // applies the same entitlement-then-RBAC gate (`employee` module,
          // then location.view.all/location.manage.all) as every other case
          // here. Registered because, like Org Units, Locations are reusable
          // setup data (a physical/virtual site catalog), not transactional.
          return (await this.locations.list(claims)).length;
        case "cost_center":
          // Same phase — CostCentersService.list() gated on
          // cost_center.view.all/cost_center.manage.all. A flat catalog like
          // Job, so it's registered the same way Job is.
          return (await this.costCenters.list(claims)).length;
        case "profit_center":
          // Same phase — ProfitCentersService.list() gated on
          // profit_center.view.all/profit_center.manage.all.
          return (await this.profitCenters.list(claims)).length;
        case "tax_slab":
          // listTaxSlabs lazily seeds the default FBR bracket table the
          // first time a payroll-enabled tenant has none -- an accepted
          // side effect of reusing the real method rather than forking a
          // read-only counting path; it's the same seed that would fire
          // the first time this tenant opens the real Payroll Settings
          // screen, just possibly a little earlier.
          return (await this.payroll.listTaxSlabs(claims)).length;
        default:
          return null;
      }
    } catch (err) {
      // ForbiddenException: entitled but lacks the permission.
      // NotFoundException: the module itself isn't entitled for this
      // tenant at all -- every domain service here deliberately 404s
      // rather than 403s on a disabled module (Decision #5: "a disabled
      // module 404s, never 403 or an empty list", so a caller can't
      // distinguish "not licensed" from "licensed but no rows"). Either
      // way it means "no card for this caller", never "fail the whole
      // summary" -- a tenant with Payroll disabled must still see every
      // OTHER domain's card, not a blanket 404 from one omitted domain.
      if (err instanceof ForbiddenException || err instanceof NotFoundException) return null;
      throw err;
    }
  }
}
