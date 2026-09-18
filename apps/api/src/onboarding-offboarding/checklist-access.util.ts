import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { RequestClaims } from "../database/tenant-context";
import type { RbacService } from "../rbac/rbac.service";
import type { ChecklistResponsibleRole } from "@boostfactor/shared-types";

/**
 * The exact self/team/all scoped-access resolution `ShiftsService.
 * requireViewAccess()` already established (apps/api/src/shifts/
 * shifts.service.ts) — factored out here because Onboarding and
 * Offboarding both need it twice each (once to view an employee's
 * checklist, once to decide who may complete a given item), and this
 * increment introduces both consumers at once rather than waiting for a
 * third caller to justify the extraction, since it's a pure, already-
 * proven-correct read with zero design risk to generalize.
 *
 * Resolves whether `claims` may act at `manageScope` (unconditional),
 * `selfPermission` (only if `claims.sub` IS the employee's own login),
 * or `teamPermission` (only if `claims.sub` IS that employee's direct
 * manager's login) — throwing `ForbiddenException` if none apply, or
 * `NotFoundException` if the employee itself doesn't exist.
 */
export async function requireScopedEmployeeAccess(
  rbac: RbacService,
  claims: RequestClaims,
  client: PoolClient,
  employeeId: string,
  manageScope: string,
  selfPermission: string,
  teamPermission: string,
  forbiddenMessage: string
): Promise<void> {
  const employee = await client.query<{ user_account_id: string | null; manager_id: string | null }>(
    "SELECT user_account_id, manager_id FROM employees WHERE id = $1",
    [employeeId]
  );
  if (employee.rowCount === 0) throw new NotFoundException("Employee not found");
  const { user_account_id, manager_id } = employee.rows[0];

  if (await rbac.can(claims, manageScope)) return;
  if (await rbac.can(claims, selfPermission, { ownerId: user_account_id })) return;

  let teamOwnerId: string | null = null;
  if (manager_id) {
    const manager = await client.query<{ user_account_id: string | null }>(
      "SELECT user_account_id FROM employees WHERE id = $1",
      [manager_id]
    );
    teamOwnerId = manager.rows[0]?.user_account_id ?? null;
  }
  if (await rbac.can(claims, teamPermission, { teamOwnerId })) return;

  throw new ForbiddenException(forbiddenMessage);
}

/**
 * Authorizes completing/editing ONE checklist item specifically, which
 * is narrower than viewing the whole checklist: holding `manageScope`
 * (HR) can always act; otherwise the caller must hold the permission
 * matching the ITEM's own `responsibleRole` (not just any view access to
 * the employee) — a line manager with `view.team` may still not be the
 * one meant to tick off a `self`-responsible item, and vice versa.
 */
export async function requireItemCompletionAccess(
  rbac: RbacService,
  claims: RequestClaims,
  client: PoolClient,
  employeeId: string,
  responsibleRole: ChecklistResponsibleRole,
  manageScope: string,
  selfPermission: string,
  teamPermission: string,
  forbiddenMessage: string
): Promise<void> {
  if (await rbac.can(claims, manageScope)) return;

  const employee = await client.query<{ user_account_id: string | null; manager_id: string | null }>(
    "SELECT user_account_id, manager_id FROM employees WHERE id = $1",
    [employeeId]
  );
  if (employee.rowCount === 0) throw new NotFoundException("Employee not found");
  const { user_account_id, manager_id } = employee.rows[0];

  if (responsibleRole === "self") {
    if (await rbac.can(claims, selfPermission, { ownerId: user_account_id })) return;
  } else if (responsibleRole === "team") {
    let teamOwnerId: string | null = null;
    if (manager_id) {
      const manager = await client.query<{ user_account_id: string | null }>(
        "SELECT user_account_id FROM employees WHERE id = $1",
        [manager_id]
      );
      teamOwnerId = manager.rows[0]?.user_account_id ?? null;
    }
    if (await rbac.can(claims, teamPermission, { teamOwnerId })) return;
  }
  // responsibleRole === "all" requires manageScope, already checked and failed above.

  throw new ForbiddenException(forbiddenMessage);
}
