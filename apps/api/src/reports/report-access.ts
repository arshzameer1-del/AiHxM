import type { ReportScope } from "@aihxm/shared-types";
import { DOMAIN_POLICIES, REPORTS_EXPORT, REPORTS_EXPORT_SENSITIVE, REPORTS_VIEW_SENSITIVE } from "./catalog/categories";
import type { ReportDefinition } from "./catalog/report-catalog.types";

/** Rights that gate the v2 tools around the reports (builder, sharing, schedules, dashboards), not any one report. */
export const V2_PERMISSIONS = ["reports.build", "reports.share", "reports.schedule", "reports.dashboard"] as const;

export type ReportAccess = { scope: ReportScope; canExport: boolean };

/** Every permission key the catalog can ask about, so one query can answer them all. */
export function allPermissionKeysForCatalog(domains: Iterable<ReportDefinition["domain"]>, extra: Iterable<string> = []): string[] {
  const keys = new Set<string>(["reports.view", REPORTS_VIEW_SENSITIVE, REPORTS_EXPORT, REPORTS_EXPORT_SENSITIVE, ...V2_PERMISSIONS, ...extra]);
  for (const d of domains) {
    for (const k of DOMAIN_POLICIES[d].tenantPermissions) keys.add(k);
    for (const k of DOMAIN_POLICIES[d].teamPermissions) keys.add(k);
  }
  return [...keys];
}

/**
 * The single authorisation decision for one report. Deny by default: a report is reachable only when the licence is on,
 * a data permission for its domain is held, and (for sensitive and restricted reports) reports.view.sensitive is held.
 * Holding reports.view alone opens the area but no data. Pure, so it is unit-tested without a database.
 */
export function decideAccess(def: ReportDefinition, held: ReadonlySet<string>, enabledModules: ReadonlySet<string>): ReportAccess | null {
  if (!held.has("reports.view")) return null;
  const policy = DOMAIN_POLICIES[def.domain];
  if (policy.module && !enabledModules.has(policy.module)) return null;
  if (def.extraPermissions.some((k) => !held.has(k))) return null;
  if ((def.sensitivity === "sensitive" || def.sensitivity === "restricted") && !held.has(REPORTS_VIEW_SENSITIVE)) return null;

  let scope: ReportScope | null = null;
  if (def.domain === "payroll") {
    if (policy.tenantPermissions.some((k) => k.endsWith(".all") && held.has(k))) scope = "tenant";
    else if (policy.tenantPermissions.some((k) => k.endsWith(".scoped") && held.has(k))) scope = "scoped";
  } else if (policy.tenantPermissions.some((k) => held.has(k))) scope = "tenant";
  else if (policy.teamPermissions.some((k) => held.has(k))) scope = "team";
  if (!scope) return null;

  // Sensitive and restricted reports need the separate sensitive-export grant on top of reports.export.
  const sensitive = def.sensitivity === "sensitive" || def.sensitivity === "restricted";
  const canExport = held.has(REPORTS_EXPORT) && def.status === "available" && (!sensitive || held.has(REPORTS_EXPORT_SENSITIVE));
  return { scope, canExport };
}
