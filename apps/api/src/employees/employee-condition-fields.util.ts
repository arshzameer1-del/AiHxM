/**
 * API-facing camelCase condition field -> the actual `employees` column it
 * reads. Originally a private constant inside `EmployeeGroupsService`
 * (0012_employee_groups_leave_policy.sql's own condition matcher) — kept
 * as an explicit map instead of a naive snake_case conversion so a future
 * column rename can't silently break matching (see that module's own
 * original doc comment for the full reasoning).
 *
 * Extracted here 2026-09-18 when the Work Schedule & Employee Schedule
 * Assignment Architecture (claude/aihxm-work-schedule-architecture.md)
 * introduced a second real consumer of the identical vocabulary —
 * assignment rules need to branch on the exact same employee attributes
 * Employee Groups' conditions already do ("Department = IT AND Employee
 * Group = Software Engineers -> Schedule FLEX-01"). Two independent
 * hand-copied field maps is exactly the kind of drift risk this
 * codebase's Effective-Dating/Rules Engine extractions already exist to
 * avoid, so this is a same-day extraction rather than a second copy.
 */
export const EMPLOYEE_CONDITION_FIELD_TO_COLUMN: Record<string, string> = {
  department: "department",
  location: "location",
  designation: "designation",
  employmentType: "employment_type",
  employmentStatus: "employment_status",
};
