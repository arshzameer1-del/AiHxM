import { IsUUID } from "class-validator";

/** `POST /organization/legacy-reconciliation/:employeeId/link-org-unit`
 * (Phase 12, Section 24). Deliberately just the one field: which
 * canonical org unit this employee's legacy `department` text refers to
 * — `LegacyReconciliationService.linkOrgUnit()` looks the employee up
 * itself and delegates the actual write to `EmployeesService.update()`,
 * which already derives `department` from the unit's own current name. */
export class LinkOrgUnitDto {
  @IsUUID()
  orgUnitId!: string;
}
