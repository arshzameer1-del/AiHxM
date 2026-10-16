import type { TenantRoleKey } from "@aihxm/shared-types";

/**
 * Self-service access is held by two roles with the same permissions: Employee (employee_self_service) and
 * Employee Self Service (ess_portal, the role whose home is the ESS launchpad). UI gates that mean "this person
 * works with their own record" use this instead of naming one of the keys.
 */
export function isSelfService(roleKeys: readonly TenantRoleKey[]): boolean {
  return roleKeys.includes("employee_self_service") || roleKeys.includes("ess_portal");
}

/** True for a login that holds the Employee Self Service role. */
export function hasEssPortalRole(roleKeys: readonly TenantRoleKey[]): boolean {
  return roleKeys.includes("ess_portal");
}

/**
 * Role-key check that also accepts keys outside the TenantRoleKey list (the scoped Regional roles are granted by
 * System Admin and come back in the session's role list as plain keys).
 */
export function hasAnyRoleKey(roleKeys: readonly string[], ...keys: string[]): boolean {
  return keys.some((k) => roleKeys.includes(k));
}
