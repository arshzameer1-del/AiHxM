import type { ReportScope } from "@aihxm/shared-types";

/** Collects bound parameters so every value reaches Postgres as a parameter, never as SQL text. */
export class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The value the filter lists send for "no department / no location set". */
export const UNASSIGNED = "unassigned";

export type EmployeeScopeInput = {
  alias: string;
  companyId: string;
  scope: ReportScope;
  /** The caller's own employee id; only used for team scope. A team caller with no employee record sees nobody. */
  callerEmployeeId: string | null;
  department?: string;
  location?: string;
  employmentType?: string;
};

/**
 * WHERE fragments (joined by AND) that limit an `employees` alias to what the caller may see plus the chosen filters.
 * Tenant isolation is applied here AND by Postgres row-level security; team scope uses the canonical reporting line
 * (org_relationships), not the older manager column on the employee row.
 */
export function employeeConditions(p: Params, o: EmployeeScopeInput): string[] {
  const a = o.alias;
  const out = [`${a}.company_id = ${p.add(o.companyId)}::uuid`];
  if (o.scope === "team") {
    if (!o.callerEmployeeId) out.push("FALSE");
    else
      out.push(
        `${a}.id IN (SELECT r.employee_id FROM org_relationships r WHERE r.company_id = ${p.add(o.companyId)}::uuid AND r.manager_employee_id = ${p.add(o.callerEmployeeId)}::uuid AND r.relationship_type = 'direct' AND r.status = 'active')`
      );
  }
  if (o.department) out.push(o.department === UNASSIGNED ? `${a}.org_unit_id IS NULL` : `${a}.org_unit_id = ${p.add(o.department)}::uuid`);
  if (o.location) out.push(o.location === UNASSIGNED ? `${a}.location_id IS NULL` : `${a}.location_id = ${p.add(o.location)}::uuid`);
  if (o.employmentType) out.push(`${a}.employment_type = ${p.add(o.employmentType)}`);
  return out;
}

/** An employee who has started and has not left, as of the date bound to `todayParam` (a `$n::date` placeholder). */
export const CURRENT_HEADCOUNT = (alias: string, todayParam: string) =>
  `(${alias}.employment_status <> 'terminated' AND ${alias}.date_of_joining <= ${todayParam})`;

export const prettyKey = (v: string): string => v.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
