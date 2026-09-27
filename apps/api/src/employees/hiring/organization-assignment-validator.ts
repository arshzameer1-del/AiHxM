import { BadRequestException } from "@nestjs/common";
import type { PoolClient } from "pg";

/**
 * Core Employee Enterprise, Phase 5 — Organization Assignment card
 * validation. Wired into HiringProcessService.saveCard() only for
 * cardKey === "organization_assignment" (see that method's own call
 * site). Implements the spec's Section 15 Assignment Validation Matrix
 * against Organization Management's REAL tables (org_units / positions /
 * locations / cost_centers / employees) via plain SQL on the caller's own
 * transaction client (`client` is already inside `db.withClaims()`'s
 * BEGIN/COMMIT, so RLS applies exactly as it does everywhere else) —
 * the same "mustExistX" existence-check pattern
 * EmployeeOrgAssignmentsService already uses, extended here to the real
 * STATUS checks Section 15 actually asks for.
 *
 * WHY THIS ISN'T EmployeeOrgAssignmentsService.create(): at this point in
 * the hiring process the employee does not exist yet — it is only
 * created at HiringProcessService.complete(), inside the same transaction
 * that marks the hire process 'hired'. There is no employee_id yet to
 * pass EmployeeOrgAssignmentsService.create(), so this card validates the
 * PROPOSED assignment directly against reference data instead. Two of
 * Section 15's rules are therefore STRUCTURALLY not applicable pre-hire,
 * and are deliberately not checked here (documented, not silently
 * dropped):
 *   - "direct manager = employee" (self-management) — the new hire has no
 *     id yet to compare against.
 *   - "multiple primary assignments overlap" — a brand-new hire cannot
 *     already hold an open primary assignment of their own.
 * Both rules keep applying, unchanged, to
 * EmployeeOrgAssignmentsService.create() for an EXISTING employee — that
 * is a separate, already-shipped code path this validator does not touch
 * or duplicate (Section 52: smallest appropriate change; never fork a
 * parallel copy of an existing service's own logic).
 *
 * Every violation found is collected and reported together (one
 * BadRequestException, semicolon-joined) rather than failing fast on the
 * first one — an HR user filling this card benefits from seeing every
 * problem in one round trip instead of fixing them one at a time.
 */
export async function validateOrganizationAssignmentCard(
  client: PoolClient,
  companyId: string,
  data: Record<string, unknown>,
  employmentCardData: Record<string, unknown> | undefined
): Promise<void> {
  const violations: string[] = [];

  const orgUnitId = typeof data.orgUnitId === "string" ? data.orgUnitId : undefined;
  const positionId = typeof data.positionId === "string" ? data.positionId : undefined;
  const locationId = typeof data.locationId === "string" ? data.locationId : undefined;
  const costCenterId = typeof data.costCenterId === "string" ? data.costCenterId : undefined;
  const directManagerEmployeeId = typeof data.directManagerEmployeeId === "string" ? data.directManagerEmployeeId : undefined;
  const effectiveFrom = typeof data.effectiveFrom === "string" ? data.effectiveFrom : undefined;

  if (orgUnitId) {
    const orgUnit = await client.query("SELECT status FROM org_units WHERE id = $1 AND company_id = $2", [orgUnitId, companyId]);
    if (orgUnit.rowCount === 0) violations.push("Selected organization unit was not found");
    else if (orgUnit.rows[0].status !== "active") violations.push("Selected organization unit is archived and cannot receive a new assignment");
  }

  if (positionId) {
    const position = await client.query("SELECT status, org_unit_id FROM positions WHERE id = $1 AND company_id = $2", [
      positionId,
      companyId,
    ]);
    if (position.rowCount === 0) {
      violations.push("Selected position was not found");
    } else {
      const pos = position.rows[0];
      if (pos.status === "filled") violations.push("Selected position is already occupied");
      else if (pos.status === "frozen") violations.push("Selected position is frozen and cannot be filled");
      else if (pos.status === "abolished") violations.push("Selected position has been abolished");
      if (orgUnitId && pos.org_unit_id !== orgUnitId) {
        violations.push("Selected position belongs to a different organization unit than the one selected");
      }
    }
  }

  if (locationId) {
    const location = await client.query("SELECT status FROM locations WHERE id = $1 AND company_id = $2", [locationId, companyId]);
    if (location.rowCount === 0) violations.push("Selected location was not found");
    else if (location.rows[0].status !== "active") violations.push("Selected location is archived and cannot receive a new assignment");
  }

  if (costCenterId) {
    const costCenter = await client.query("SELECT status FROM cost_centers WHERE id = $1 AND company_id = $2", [costCenterId, companyId]);
    if (costCenter.rowCount === 0) violations.push("Selected cost center was not found");
    else if (costCenter.rows[0].status !== "active") violations.push("Selected cost center is archived and cannot receive a new assignment");
  }

  if (directManagerEmployeeId) {
    const manager = await client.query("SELECT employment_status FROM employees WHERE id = $1 AND company_id = $2", [
      directManagerEmployeeId,
      companyId,
    ]);
    if (manager.rowCount === 0) violations.push("Selected direct manager was not found");
    else if (manager.rows[0].employment_status === "terminated") violations.push("Selected direct manager is no longer active");
  }

  // "effective date before employment start" — only checkable once the
  // Employment card has itself been saved with a dateOfJoining; a caller
  // filling Organization Assignment before Employment (cards may be
  // visited in any order the definitions allow) simply skips this one
  // check until that data exists, rather than blocking on a card this one
  // doesn't `dependsOnCardKey` today.
  const dateOfJoining = typeof employmentCardData?.dateOfJoining === "string" ? employmentCardData.dateOfJoining : undefined;
  if (effectiveFrom && dateOfJoining && effectiveFrom < dateOfJoining) {
    violations.push("Assignment effective date cannot be before the employment date of joining");
  }

  if (violations.length > 0) {
    throw new BadRequestException(violations.join("; "));
  }
}
