import type { PoolClient } from "pg";

/**
 * Gap Register CFG-07 -- impact preview for a configuration change.
 *
 * Computed when a change request is validated and stored on the request
 * (impact_summary / affected_counts / risk_level). Approval is refused until
 * one exists, so an approver always sees what they are approving.
 *
 * Counts are deliberately cheap, indexed counts, not per-employee evaluation:
 *   employees          people the change can reach (scope-based upper bound)
 *   openHireDrafts     hire processes still in progress (they read live config)
 *   referencingRows    rows pointing at a catalog item (app.catalog_item_usage)
 *   groupAssignments   employee groups that use a business policy
 *   overrides          scoped overrides registered against a policy type
 * Workflows, roles and integrations do not reference these three domains
 * today, so they are not counted (add them here when that changes).
 */
export type ImpactResult = {
  summary: string[];
  counts: Record<string, number>;
  risk: "low" | "medium" | "high";
};

type Row = {
  config_domain: string;
  operation: string;
  target_id: string | null;
  payload: Record<string, unknown> | null;
  before_snapshot: Record<string, unknown> | null;
};

export function riskFor(employees: number, extra: { deactivatesUsedItem?: boolean; companyWide?: boolean }): "low" | "medium" | "high" {
  let level = employees > 100 ? 2 : employees > 10 ? 1 : 0;
  if (extra.deactivatesUsedItem) level = Math.max(level, 1);
  if (extra.companyWide && employees > 10) level = 2;
  return (["low", "medium", "high"] as const)[level];
}

async function count(client: PoolClient, sql: string, params: unknown[]): Promise<number> {
  const r = await client.query<{ n: number }>(sql, params);
  return r.rows[0]?.n ?? 0;
}

export async function computeImpact(client: PoolClient, companyId: string, row: Row): Promise<ImpactResult> {
  const payload = row.payload ?? {};
  const snap = row.before_snapshot ?? {};
  const counts: Record<string, number> = {};
  const summary: string[] = [];

  const employeesTotal = await count(client, "SELECT count(*)::int AS n FROM employees WHERE company_id = $1 AND employment_status <> 'terminated'", [companyId]);
  counts.openHireDrafts = await count(
    client,
    "SELECT count(*)::int AS n FROM hire_processes WHERE company_id = $1 AND status IN ('draft', 'in_progress', 'validation_required', 'ready_for_completion', 'submitted', 'approved', 'rejected', 'failed')",
    [companyId]
  );

  let employees = 0;
  let deactivatesUsedItem = false;
  let companyWide = false;

  if (row.config_domain === "hr_reference_catalog_item") {
    if (row.target_id) {
      counts.referencingRows = await count(client, "SELECT app.catalog_item_usage($1)::int AS n", [row.target_id]);
      employees = await count(
        client,
        `SELECT count(*)::int AS n FROM employees WHERE company_id = $1 AND (
           employment_type_catalog_item_id = $2 OR gender_catalog_item_id = $2 OR marital_status_catalog_item_id = $2
           OR salary_band_catalog_item_id = $2 OR termination_reason_catalog_item_id = $2 OR worker_type_catalog_item_id = $2)`,
        [companyId, row.target_id]
      );
      deactivatesUsedItem = payload.isActive === false && counts.referencingRows > 0;
      summary.push(`${counts.referencingRows} existing record(s) reference this item; ${employees} employee(s) carry it directly.`);
      if (deactivatesUsedItem) summary.push("Deactivating keeps those records readable but stops new data from choosing this value.");
    } else {
      summary.push("A new catalog item: nothing existing references it yet.");
    }
  } else if (row.config_domain === "hr_business_policy") {
    const policyType = String(row.operation === "create" ? payload.policyType ?? "" : snap.policyType ?? "");
    counts.groupAssignments = row.target_id
      ? await count(client, "SELECT count(*)::int AS n FROM employee_group_policy_assignments WHERE company_id = $1 AND policy_id = $2", [companyId, row.target_id])
      : 0;
    counts.overrides = await count(
      client,
      "SELECT count(*)::int AS n FROM configuration_rule_mappings WHERE company_id = $1 AND config_domain = 'hr_business_policy' AND config_key = $2 AND is_active = true",
      [companyId, policyType]
    );
    const becomesDefault = payload.isDefault === true || (row.operation !== "create" && snap.isDefault === true);
    if (becomesDefault) {
      employees = employeesTotal;
      companyWide = true;
      summary.push(`This is (or becomes) the company-wide default ${policyType} policy: it applies to up to ${employeesTotal} employee(s) with no override.`);
    }
    if (counts.groupAssignments > 0) summary.push(`${counts.groupAssignments} employee group(s) are assigned this policy.`);
    if (counts.overrides > 0) summary.push(`${counts.overrides} scoped override(s) sit on top of ${policyType} policies and keep winning where they match.`);
  } else {
    const scopeType = String(row.operation === "create" ? payload.scopeType ?? "" : snap.scopeType ?? "");
    const scopeValue = String(row.operation === "create" ? payload.scopeValue ?? "" : snap.scopeValue ?? "");
    const uuid = /^[0-9a-f-]{36}$/i.test(scopeValue);
    switch (scopeType) {
      case "tenant":
        employees = employeesTotal;
        companyWide = true;
        break;
      case "employee":
        employees = 1;
        break;
      case "location":
        employees = uuid ? await count(client, "SELECT count(*)::int AS n FROM employees WHERE company_id = $1 AND location_id = $2 AND employment_status <> 'terminated'", [companyId, scopeValue]) : 0;
        break;
      case "position":
        employees = uuid ? await count(client, "SELECT count(*)::int AS n FROM employees WHERE company_id = $1 AND position_id = $2 AND employment_status <> 'terminated'", [companyId, scopeValue]) : 0;
        break;
      case "job":
        employees = uuid
          ? await count(client, "SELECT count(*)::int AS n FROM employees e JOIN positions p ON p.id = e.position_id WHERE e.company_id = $1 AND p.job_id = $2 AND e.employment_status <> 'terminated'", [companyId, scopeValue])
          : 0;
        break;
      case "employee_group":
        employees = uuid ? await count(client, "SELECT count(*)::int AS n FROM employee_group_memberships WHERE company_id = $1 AND group_id = $2 AND effective_to IS NULL", [companyId, scopeValue]) : 0;
        break;
      case "org_unit":
        employees = uuid
          ? await count(
              client,
              `WITH RECURSIVE down AS (
                 SELECT id FROM org_units WHERE id = $2 AND company_id = $1
                 UNION ALL SELECT o.id FROM org_units o JOIN down d ON o.parent_id = d.id WHERE o.company_id = $1)
               SELECT count(*)::int AS n FROM employees WHERE company_id = $1 AND org_unit_id IN (SELECT id FROM down) AND employment_status <> 'terminated'`,
              [companyId, scopeValue]
            )
          : 0;
        break;
    }
    counts.overridesOnSameKey = await count(
      client,
      "SELECT count(*)::int AS n FROM configuration_rule_mappings WHERE company_id = $1 AND config_domain = $2 AND config_key = $3 AND is_active = true",
      [companyId, String(payload.configDomain ?? snap.configDomain ?? ""), String(payload.configKey ?? snap.configKey ?? "")]
    );
    summary.push(`Scope ${scopeType || "(unknown)"}: reaches up to ${employees} employee(s).`);
  }

  counts.employees = employees;
  counts.employeesTotal = employeesTotal;
  if (counts.openHireDrafts > 0) summary.push(`${counts.openHireDrafts} hire(s) in progress will see the change as soon as it is published.`);
  return { summary, counts, risk: riskFor(employees, { deactivatesUsedItem, companyWide }) };
}
