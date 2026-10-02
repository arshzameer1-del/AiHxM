/**
 * Core Employee Enterprise, Phase 2 (0082_hiring_process_engine.sql) — the
 * fixed 20-card catalogue from the spec's own Section 6, seeded per
 * company on first use (see HiringProcessService.ensureCardDefinitions()).
 * This is the ENGINE's default data, not a hardcoded UI — every card here
 * is a real row in `core_employee_card_definitions` once seeded, and
 * Phase 3's admin surface edits those rows (enable/disable, reorder), not
 * this file. This file only supplies what a brand-new company starts
 * from.
 *
 * `EMPLOYEE_MAPPED_CARD_KEYS` marks the cards that project directly onto
 * `CreateEmployeeRequest` fields at completion: Phase 2/4's
 * personal_identity/employment; Phase 5's organization_assignment ->
 * `orgUnitId`/`locationId` (EmployeesService's own existing
 * resolveDepartment/resolveLocation logic from Organization Management
 * Phase 1/4 — no new mapping code needed); and Phase 6's
 * reporting_relationships -> `managerId`, the same pre-existing legacy
 * field EmployeesService.create() already writes. All three reuse fields
 * `CreateEmployeeRequest` already had. `organization_assignment.positionId`
 * is NOT a `CreateEmployeeRequest` field; since 2026-10-01 it is occupied
 * separately at completion via `OrgOccupancyService` (same transaction) —
 * see HiringProcessService.complete()'s own comment.
 * Contact/Addresses (also Phase 6) project onto their OWN dedicated
 * tables instead (`employee_contacts`/`employee_addresses`), fetched and
 * inserted separately in complete() — not part of this constant, since
 * they don't map onto a `CreateEmployeeRequest` field at all. Every other
 * card's data is captured and stored, but not yet projected into a
 * dedicated sub-entity table until its own phase lands (Phase 8 for
 * Compensation/Bank/Cost Allocation, Phase 9 for Family/Education/
 * Qualifications/Assets). Capturing now and projecting later is
 * deliberate: a tenant that starts using the hiring flow before every
 * phase ships doesn't lose the data they entered.
 */

export type CardDefinitionSeed = {
  cardKey: string;
  label: string;
  description: string;
  dependsOnCardKey?: string;
  isRequired: boolean;
};

export const CARD_CATALOG: readonly CardDefinitionSeed[] = [
  { cardKey: "personal_identity", label: "Personal Identity", description: "Legal/preferred names, date of birth, gender, nationality, identity numbers.", isRequired: true },
  { cardKey: "employment", label: "Employment", description: "Hire action, employment status, employment type, contract and probation.", isRequired: true },
  { cardKey: "organization_assignment", label: "Organization Assignment", description: "Org unit, position, job, location, cost center.", isRequired: true },
  { cardKey: "reporting_relationships", label: "Reporting Relationships", description: "Direct, dotted-line, matrix, acting and secondment relationships.", isRequired: false },
  { cardKey: "contact", label: "Contact", description: "Business/personal email, phone numbers, emergency contacts.", isRequired: false },
  { cardKey: "addresses", label: "Addresses", description: "Permanent, current and mailing addresses.", isRequired: false },
  { cardKey: "working_time", label: "Working Time", description: "Work schedule, time profile, shift and work percentage.", isRequired: false },
  { cardKey: "compensation", label: "Compensation", description: "Salary, pay components, currency and frequency.", isRequired: false },
  { cardKey: "payment_bank", label: "Payment / Bank", description: "Payment method, bank account and IBAN details.", dependsOnCardKey: "employment", isRequired: false },
  { cardKey: "important_dates", label: "Important Dates", description: "Joining, confirmation, probation, contract and document expiry dates.", isRequired: false },
  { cardKey: "family_dependents", label: "Family / Dependents", description: "Dependents, relationships and beneficiaries.", isRequired: false },
  { cardKey: "education", label: "Education", description: "Degrees, institutions and specialization.", isRequired: false },
  { cardKey: "qualifications_skills", label: "Qualifications / Skills", description: "Certificates, licenses, skills and proficiency.", isRequired: false },
  { cardKey: "documents", label: "Documents", description: "Identity, contract, certificate and permit documents.", isRequired: false },
  { cardKey: "cost_allocation", label: "Cost Allocation", description: "Primary and split costing across cost centers.", isRequired: false },
  { cardKey: "assets", label: "Assets", description: "Equipment and company asset assignments.", isRequired: false },
  { cardKey: "time_leave_setup", label: "Time / Leave Setup", description: "Leave eligibility and profile initialization.", isRequired: false },
  { cardKey: "benefits", label: "Benefits", description: "Benefit eligibility and enrollment inputs.", isRequired: false },
  { cardKey: "emergency_safety", label: "Emergency & Safety", description: "Emergency contacts and safety information.", isRequired: false },
  { cardKey: "review_completion", label: "Review / Completion", description: "Consolidated validation and finalization.", isRequired: true },
] as const;

/** The cards that project onto `EmployeesService.create()`'s own input fields at completion time — see this file's own header comment. */
export const EMPLOYEE_MAPPED_CARD_KEYS = ["personal_identity", "employment", "organization_assignment", "reporting_relationships"] as const;
