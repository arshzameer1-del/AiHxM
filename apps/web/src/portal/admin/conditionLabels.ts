import type { EmployeeGroupConditionField } from "@boostfactor/shared-types";

/**
 * The fixed condition-field set EmployeeGroupConditionDto validates
 * against (see employee-group-condition.dto.ts) — kept as its own tiny
 * module rather than duplicated between EmployeeGroupsPanel's list view
 * and its create/edit form.
 */
export const CONDITION_FIELDS: EmployeeGroupConditionField[] = [
  "department",
  "location",
  "designation",
  "employmentType",
  "employmentStatus",
];

export const CONDITION_FIELD_LABELS: Record<EmployeeGroupConditionField, string> = {
  department: "Department",
  location: "Location",
  designation: "Designation",
  employmentType: "Employment type",
  employmentStatus: "Employment status",
};
