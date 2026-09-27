import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import type { EmployeeAnalyticsSummary, EmployeeHeadcountBreakdown } from "@aihxm/shared-types";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";

/**
 * Core Employee Enterprise Phase 12 — Workforce Analytics. One
 * dashboard-shaped read, the same scope `OrganizationCommandCenterService`
 * already set for Organization Management's own integrity dashboard: a
 * fixed set of real aggregate queries against the tables this initiative
 * already built (Phase 1's base `employees` row, Phase 7's Important
 * Dates, Phase 9's Assets), not a generic ad-hoc reporting engine.
 *
 * GATED ON `employee.manage.all`, not `employee.view` — the same call
 * `LegacyReconciliationService` made for its own aggregate report: every
 * number here is company-wide (headcount by department, terminations,
 * ...), not filtered to whatever subset of employees a `.self`/`.team`
 * scope would normally let a given viewer see, so this is an HR-Admin-
 * shaped screen, not a per-employee self-service one.
 */
@Injectable()
export class EmployeeAnalyticsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
    private readonly rbac: RbacService
  ) {}

  async getSummary(claims: RequestClaims): Promise<EmployeeAnalyticsSummary> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id;

      const [
        totalResult,
        departmentResult,
        employmentTypeResult,
        genderResult,
        tenureResult,
        terminationsResult,
        upcomingDatesResult,
        assetsResult,
      ] = await Promise.all([
        client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM employees WHERE company_id = $1 AND employment_status <> 'terminated'`,
          [companyId]
        ),
        client.query<{ key: string; n: string }>(
          `SELECT COALESCE(NULLIF(department, ''), 'Unassigned') AS key, COUNT(*) AS n
           FROM employees WHERE company_id = $1 AND employment_status <> 'terminated'
           GROUP BY key ORDER BY n DESC, key ASC`,
          [companyId]
        ),
        client.query<{ key: string; n: string }>(
          `SELECT COALESCE(NULLIF(employment_type, ''), 'Unspecified') AS key, COUNT(*) AS n
           FROM employees WHERE company_id = $1 AND employment_status <> 'terminated'
           GROUP BY key ORDER BY n DESC, key ASC`,
          [companyId]
        ),
        client.query<{ key: string; n: string }>(
          `SELECT COALESCE(NULLIF(gender, ''), 'Unspecified') AS key, COUNT(*) AS n
           FROM employees WHERE company_id = $1 AND employment_status <> 'terminated'
           GROUP BY key ORDER BY n DESC, key ASC`,
          [companyId]
        ),
        client.query<{ avg_years: string | null }>(
          `SELECT AVG((COALESCE(termination_date, CURRENT_DATE) - date_of_joining) / 365.25)::text AS avg_years
           FROM employees
           WHERE company_id = $1 AND employment_status <> 'terminated' AND date_of_joining IS NOT NULL`,
          [companyId]
        ),
        client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM employees
           WHERE company_id = $1 AND termination_date IS NOT NULL AND termination_date >= (CURRENT_DATE - INTERVAL '90 days')`,
          [companyId]
        ),
        client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM employee_important_dates
           WHERE company_id = $1 AND status = 'active'
             AND date_value BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '30 days')`,
          [companyId]
        ),
        client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM employee_assets WHERE company_id = $1 AND status = 'assigned'`,
          [companyId]
        ),
      ]);

      const toBreakdown = (rows: Array<{ key: string; n: string }>): EmployeeHeadcountBreakdown[] =>
        rows.map((r) => ({ key: r.key, count: Number(r.n) }));

      const avgYearsRaw = tenureResult.rows[0]?.avg_years;

      return {
        generatedAt: new Date().toISOString(),
        totalActiveEmployees: Number(totalResult.rows[0]?.n ?? 0),
        headcountByDepartment: toBreakdown(departmentResult.rows),
        headcountByEmploymentType: toBreakdown(employmentTypeResult.rows),
        genderBreakdown: toBreakdown(genderResult.rows),
        averageTenureYears: avgYearsRaw === null || avgYearsRaw === undefined ? null : Math.round(Number(avgYearsRaw) * 100) / 100,
        terminationsLast90Days: Number(terminationsResult.rows[0]?.n ?? 0),
        upcomingImportantDatesNext30Days: Number(upcomingDatesResult.rows[0]?.n ?? 0),
        assetsCurrentlyAssigned: Number(assetsResult.rows[0]?.n ?? 0),
      };
    });
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to view employee analytics");
    }
  }
}
