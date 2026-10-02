import type { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import type { RbacService } from "../rbac/rbac.service";

/**
 * Payroll Areas (0101_payroll_areas.sql) — the Data Scope resolution
 * shared by PayrollService (run actions) and PayrollAreasService (area
 * management). A plain function over the `db`/`rbac` both services
 * already hold, rather than a third injectable: PayrollService is
 * hand-constructed positionally by several spec files, and a new
 * constructor dependency would break every one of them for no gain.
 *
 * Same shape as Organization Management's `resolveViewAccess()` helpers
 * (positions.service.ts / org-units.service.ts): `.all` wins outright
 * ("unrestricted"); otherwise `.scoped` resolves to an explicit id set;
 * otherwise the caller has no access at all (`null`) and the calling
 * service throws its own 403.
 */
export type PayrollAreaAccess = { unrestricted: true } | { unrestricted: false; payrollAreaIds: string[] };

export function isPayrollAreaInScope(access: PayrollAreaAccess, payrollAreaId: string | null | undefined): boolean {
  if (access.unrestricted) return true;
  // A company-wide run/record (no payroll area) is NEVER reachable with a
  // `.scoped` permission alone — it covers employees outside any one
  // area, so by definition outside a scoped caller's slice.
  return Boolean(payrollAreaId) && access.payrollAreaIds.includes(payrollAreaId as string);
}

/**
 * `permissionBases` is one or more `<object>.<action>` bases (e.g.
 * `["payroll.calculate"]`); holding `.all` on ANY of them is unrestricted,
 * otherwise holding `.scoped` on any of them resolves the scoped set.
 * Multiple bases exist only for read paths (listing runs/payslips), where
 * any payroll-staff permission is enough to see what it can act on.
 */
export async function resolvePayrollAreaAccess(
  db: DatabaseService,
  rbac: RbacService,
  claims: RequestClaims,
  permissionBases: readonly string[]
): Promise<PayrollAreaAccess | null> {
  const alls = await Promise.all(permissionBases.map((base) => rbac.can(claims, `${base}.all`)));
  if (alls.some(Boolean)) return { unrestricted: true };
  const scopeds = await Promise.all(permissionBases.map((base) => rbac.hasScopedPermission(claims, base)));
  if (!scopeds.some(Boolean)) return null;
  return { unrestricted: false, payrollAreaIds: await resolveScopedPayrollAreaIds(db, rbac, claims) };
}

/**
 * Which Payroll Areas the caller's own `data_scope_assignments` reach: an
 * area is in scope iff at least one of its `payroll_area_scope_links`
 * matches one of the caller's assignments — org units and locations
 * expanded to their full subtree (a regional user assigned "South Region"
 * covers an area linked to "Karachi Branch" under it), cost centers used
 * flat — the same "either dimension" rule PositionsService applies.
 * Expansion is ONLY on the caller's side: an area linked to a unit ABOVE
 * the caller's assigned unit covers employees outside their region, so it
 * is (correctly) out of scope.
 *
 * The subtree walk is this function's own inline recursive CTE — the same
 * duplicate-rather-than-inject choice PositionsService/
 * EmployeeOrgAssignmentsService made (Payroll has no OrganizationModule
 * dependency and shouldn't grow one for one query). `UNION` (not
 * `UNION ALL`) keeps a malformed cyclic hierarchy from recursing forever.
 *
 * Zero assignments -> zero areas: Data Scope fails closed.
 */
export async function resolveScopedPayrollAreaIds(
  db: DatabaseService,
  rbac: RbacService,
  claims: RequestClaims
): Promise<string[]> {
  if (!claims.company_id) return [];
  const [orgUnitIds, locationIds, costCenterIds] = await Promise.all([
    rbac.resolveDataScopeEntityIds(claims, "org_unit"),
    rbac.resolveDataScopeEntityIds(claims, "location"),
    rbac.resolveDataScopeEntityIds(claims, "cost_center"),
  ]);
  if (orgUnitIds.length === 0 && locationIds.length === 0 && costCenterIds.length === 0) return [];
  return db.withClaims(claims, async (client) => {
    const result = await client.query<{ payroll_area_id: string }>(
      `WITH RECURSIVE scoped_org_units AS (
         SELECT id FROM org_units WHERE company_id = $1 AND id = ANY($2::uuid[])
         UNION
         SELECT ou.id FROM org_units ou JOIN scoped_org_units s ON ou.parent_id = s.id WHERE ou.company_id = $1
       ),
       scoped_locations AS (
         SELECT id FROM locations WHERE company_id = $1 AND id = ANY($3::uuid[])
         UNION
         SELECT l.id FROM locations l JOIN scoped_locations s ON l.parent_id = s.id WHERE l.company_id = $1
       )
       SELECT DISTINCT link.payroll_area_id
       FROM payroll_area_scope_links link
       WHERE link.company_id = $1
         AND (
           (link.scope_type = 'org_unit' AND link.scope_entity_id IN (SELECT id FROM scoped_org_units))
           OR (link.scope_type = 'location' AND link.scope_entity_id IN (SELECT id FROM scoped_locations))
           OR (link.scope_type = 'cost_center' AND link.scope_entity_id = ANY($4::uuid[]))
         )`,
      [claims.company_id, orgUnitIds, locationIds, costCenterIds]
    );
    return result.rows.map((row) => row.payroll_area_id);
  });
}
