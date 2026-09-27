import type { FieldSensitivityTier, EmployeeFieldSensitivityEntry } from "@aihxm/shared-types";

/**
 * Core Employee Enterprise Phase 11 — gap #10 from the audit: a real,
 * flat role-based field permission engine already exists
 * (`field_permission_rules`, enforced by `RbacService.filterRecordFields()`
 * / `filterRecordFieldsWithScope()`) and already covers every field in
 * `EmployeesService`'s own `SENSITIVE_FIELDS`. What was missing was a
 * NAMED classification independent of any tenant's own role setup — a
 * field is labeled "this is Restricted data" as a fixed fact about the
 * field itself, not a side effect of which roles a given tenant happens
 * to grant view/edit on it — plus audit logging when the two most
 * sensitive tiers are actually exposed to a viewer.
 *
 * FIXED, SPEC-DEFINED VOCABULARY, NOT A NEW TABLE — the same "closed list
 * -> union type" call this codebase has made everywhere else a
 * vocabulary is closed rather than tenant-configurable (job history event
 * types, employee document types, ...). If a future phase needs
 * per-tenant overrides of these tiers, that's real, additive, separate
 * scope — not silently assumed here.
 *
 * CLASSIFICATION RATIONALE (Pakistan HR/payroll context):
 *   - `cnic` — the national identity number. RESTRICTED: a single
 *     government-issued identifier, the classic identity-theft target.
 *   - `bankAccountNumber` — HIGHLY RESTRICTED: direct access to an
 *     employee's own money: the single most sensitive field this object
 *     carries.
 *   - `dateOfBirth`, `salaryBand`, `terminationReason` — CONFIDENTIAL:
 *     each is personal or compensation-related, but none is a bare
 *     identifier or a path to funds the way `cnic`/`bankAccountNumber`
 *     are.
 *   - Every other field on `EmployeeView` — NORMAL: ordinary business
 *     data already visible to anyone holding `employee.view`.
 */
export const EMPLOYEE_FIELD_SENSITIVITY: Readonly<Record<string, FieldSensitivityTier>> = Object.freeze({
  cnic: "restricted",
  bankAccountNumber: "highly_restricted",
  dateOfBirth: "confidential",
  salaryBand: "confidential",
  terminationReason: "confidential",
});

export function sensitivityTierOf(fieldKey: string): FieldSensitivityTier {
  return EMPLOYEE_FIELD_SENSITIVITY[fieldKey] ?? "normal";
}

/** The full classification list (every field this codebase names a tier
 * for, plus nothing else — fields not listed here are implicitly
 * `"normal"` and not enumerated, since that set is unbounded). Powers
 * `GET /employees/field-sensitivity` — visible to any caller who can see
 * the Employee object at all, since the classification itself is
 * metadata, not the sensitive data it describes. */
export function listFieldSensitivity(): EmployeeFieldSensitivityEntry[] {
  return Object.entries(EMPLOYEE_FIELD_SENSITIVITY).map(([fieldKey, tier]) => ({ fieldKey, tier }));
}

/** Of the field keys actually present on a filtered response (i.e. ones
 * this specific viewer's role/scope did NOT hide), which ones are
 * classified `"restricted"` or `"highly_restricted"` — the two tiers
 * Phase 11 requires view-audit-logging for. Returns `[]` (no audit entry
 * to write) when none of the exposed fields reach that bar, which is the
 * common case for most roles most of the time. */
export function restrictedFieldsExposed(exposedFieldKeys: readonly string[]): EmployeeFieldSensitivityEntry[] {
  return exposedFieldKeys
    .map((fieldKey) => ({ fieldKey, tier: sensitivityTierOf(fieldKey) }))
    .filter((entry) => entry.tier === "restricted" || entry.tier === "highly_restricted");
}
