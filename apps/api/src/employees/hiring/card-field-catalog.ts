/**
 * Hiring Card Field Configuration (2026-09-27) — the canonical, per-card
 * list of BUILT-IN fields every one of `card-catalog.ts`'s 20 cards
 * already renders in `cardForms.tsx` (the Hiring Wizard's own form
 * components). This file is the single source of truth for what "this
 * card's fields" even means server-side — `field_key` here MUST match the
 * exact key each card form component reads/writes on its own `data`
 * object (e.g. Personal Identity's `firstName`), because disabling a
 * field here is what tells the Hiring Wizard to stop rendering that input
 * at all. Getting a key wrong here would silently make a real field
 * un-configurable rather than error — cross-checked against
 * `cardForms.tsx` field-by-field when this file was written.
 *
 * `employment`'s three fields (employmentType/dateOfJoining/designation)
 * are listed under its own `cardKey` even though `cardForms.tsx` renders
 * them inside Organization Assignment's own form — that presentation-only
 * merge is `HiringWizardPage.tsx`'s own `EMPLOYMENT_MERGE_TARGET` doing
 * (see that file's header comment), not a reason to also merge their
 * field-configuration identity; the underlying `hire_process_card_data`
 * row, and this field catalog, both still treat them as `employment`'s
 * own fields.
 *
 * `review_completion` intentionally has NO built-in fields listed — it is
 * a computed validation/summary screen, not a data-entry form, so there is
 * nothing to enable or disable on it. It still exists as its own
 * `cardKey` in the seed loop below (an empty field list), and the custom-
 * field engine is skipped for it too for the same reason (see
 * `HiringWizardPage.tsx`'s own review-screen rendering, which never goes
 * through `CARD_FORM_REGISTRY`/`cardForms.tsx` at all).
 */

export type CardFieldSeed = {
  cardKey: string;
  fieldKey: string;
  label: string;
  sortOrder: number;
  defaultRequired: boolean;
};

export const CARD_FIELD_CATALOG: readonly CardFieldSeed[] = [
  // personal_identity — PersonalIdentityForm
  { cardKey: "personal_identity", fieldKey: "firstName", label: "First name", sortOrder: 0, defaultRequired: true },
  { cardKey: "personal_identity", fieldKey: "lastName", label: "Last name", sortOrder: 1, defaultRequired: true },
  { cardKey: "personal_identity", fieldKey: "cnic", label: "CNIC", sortOrder: 2, defaultRequired: false },
  { cardKey: "personal_identity", fieldKey: "dateOfBirth", label: "Date of birth", sortOrder: 3, defaultRequired: false },
  { cardKey: "personal_identity", fieldKey: "gender", label: "Gender", sortOrder: 4, defaultRequired: false },
  { cardKey: "personal_identity", fieldKey: "maritalStatus", label: "Marital status", sortOrder: 5, defaultRequired: false },

  // employment — fields render inside Organization Assignment's own form
  // (presentation-only merge, see this file's header comment) but are
  // configured here under their own real card key.
  { cardKey: "employment", fieldKey: "employmentType", label: "Employment type", sortOrder: 0, defaultRequired: true },
  { cardKey: "employment", fieldKey: "dateOfJoining", label: "Date of joining", sortOrder: 1, defaultRequired: false },
  { cardKey: "employment", fieldKey: "designation", label: "Designation", sortOrder: 2, defaultRequired: false },

  // organization_assignment — OrganizationAssignmentForm
  { cardKey: "organization_assignment", fieldKey: "orgUnitId", label: "Org unit", sortOrder: 0, defaultRequired: false },
  { cardKey: "organization_assignment", fieldKey: "locationId", label: "Location", sortOrder: 1, defaultRequired: false },
  { cardKey: "organization_assignment", fieldKey: "positionId", label: "Position", sortOrder: 2, defaultRequired: false },

  // reporting_relationships — ReportingRelationshipsForm
  { cardKey: "reporting_relationships", fieldKey: "directManagerEmployeeId", label: "Direct manager", sortOrder: 0, defaultRequired: false },

  // contact — ContactForm (RepeatableListEditor over CONTACT_TYPE_FIELDS)
  { cardKey: "contact", fieldKey: "contactType", label: "Type", sortOrder: 0, defaultRequired: true },
  { cardKey: "contact", fieldKey: "value", label: "Value", sortOrder: 1, defaultRequired: true },
  { cardKey: "contact", fieldKey: "label", label: "Label", sortOrder: 2, defaultRequired: false },
  { cardKey: "contact", fieldKey: "isPrimary", label: "Primary", sortOrder: 3, defaultRequired: false },

  // addresses — AddressesForm (RepeatableListEditor over ADDRESS_FIELDS)
  { cardKey: "addresses", fieldKey: "addressType", label: "Type", sortOrder: 0, defaultRequired: true },
  { cardKey: "addresses", fieldKey: "line1", label: "Address line 1", sortOrder: 1, defaultRequired: true },
  { cardKey: "addresses", fieldKey: "city", label: "City", sortOrder: 2, defaultRequired: false },
  { cardKey: "addresses", fieldKey: "country", label: "Country", sortOrder: 3, defaultRequired: false },

  // working_time — WorkingTimeForm
  { cardKey: "working_time", fieldKey: "shiftId", label: "Shift", sortOrder: 0, defaultRequired: false },
  { cardKey: "working_time", fieldKey: "effectiveFrom", label: "Effective from", sortOrder: 1, defaultRequired: false },

  // compensation — CompensationForm
  { cardKey: "compensation", fieldKey: "monthlySalary", label: "Monthly salary", sortOrder: 0, defaultRequired: false },
  { cardKey: "compensation", fieldKey: "effectiveFrom", label: "Effective from", sortOrder: 1, defaultRequired: false },

  // payment_bank — PaymentBankForm
  { cardKey: "payment_bank", fieldKey: "paymentMethod", label: "Payment method", sortOrder: 0, defaultRequired: false },
  { cardKey: "payment_bank", fieldKey: "bankName", label: "Bank name", sortOrder: 1, defaultRequired: false },
  { cardKey: "payment_bank", fieldKey: "accountTitle", label: "Account title", sortOrder: 2, defaultRequired: false },
  { cardKey: "payment_bank", fieldKey: "accountNumber", label: "Account number", sortOrder: 3, defaultRequired: false },
  { cardKey: "payment_bank", fieldKey: "iban", label: "IBAN", sortOrder: 4, defaultRequired: false },

  // important_dates — ImportantDatesForm (RepeatableListEditor over IMPORTANT_DATE_FIELDS)
  { cardKey: "important_dates", fieldKey: "dateType", label: "Type", sortOrder: 0, defaultRequired: true },
  { cardKey: "important_dates", fieldKey: "dateValue", label: "Date", sortOrder: 1, defaultRequired: true },
  { cardKey: "important_dates", fieldKey: "label", label: "Label", sortOrder: 2, defaultRequired: false },

  // cost_allocation — CostAllocationForm
  { cardKey: "cost_allocation", fieldKey: "costCenterId", label: "Cost center", sortOrder: 0, defaultRequired: true },
  { cardKey: "cost_allocation", fieldKey: "allocationPercentage", label: "Percentage", sortOrder: 1, defaultRequired: true },
  { cardKey: "cost_allocation", fieldKey: "isPrimary", label: "Primary", sortOrder: 2, defaultRequired: false },

  // family_dependents — FamilyDependentsForm
  { cardKey: "family_dependents", fieldKey: "relationship", label: "Relationship", sortOrder: 0, defaultRequired: true },
  { cardKey: "family_dependents", fieldKey: "fullName", label: "Full name", sortOrder: 1, defaultRequired: true },
  { cardKey: "family_dependents", fieldKey: "dateOfBirth", label: "Date of birth", sortOrder: 2, defaultRequired: false },
  { cardKey: "family_dependents", fieldKey: "isDependent", label: "Dependent", sortOrder: 3, defaultRequired: false },
  { cardKey: "family_dependents", fieldKey: "isBeneficiary", label: "Beneficiary", sortOrder: 4, defaultRequired: false },

  // education — EducationForm
  { cardKey: "education", fieldKey: "degreeTitle", label: "Degree / Title", sortOrder: 0, defaultRequired: true },
  { cardKey: "education", fieldKey: "institution", label: "Institution", sortOrder: 1, defaultRequired: false },
  { cardKey: "education", fieldKey: "fieldOfStudy", label: "Field of study", sortOrder: 2, defaultRequired: false },

  // qualifications_skills — QualificationsSkillsForm
  { cardKey: "qualifications_skills", fieldKey: "qualificationType", label: "Type", sortOrder: 0, defaultRequired: true },
  { cardKey: "qualifications_skills", fieldKey: "title", label: "Title", sortOrder: 1, defaultRequired: true },
  { cardKey: "qualifications_skills", fieldKey: "issuingAuthority", label: "Issuing authority", sortOrder: 2, defaultRequired: false },

  // assets — AssetsForm
  { cardKey: "assets", fieldKey: "assetType", label: "Asset type", sortOrder: 0, defaultRequired: true },
  { cardKey: "assets", fieldKey: "assetTag", label: "Asset tag", sortOrder: 1, defaultRequired: false },

  // documents / time_leave_setup / benefits / emergency_safety —
  // GenericNotesForm; each has exactly one built-in field, the shared
  // free-text `notes` box, so an admin can still disable/require it, and
  // — more usefully for these four not-yet-projected cards — add custom
  // fields to actually capture structured data on them.
  { cardKey: "documents", fieldKey: "notes", label: "Notes", sortOrder: 0, defaultRequired: false },
  { cardKey: "time_leave_setup", fieldKey: "notes", label: "Notes", sortOrder: 0, defaultRequired: false },
  { cardKey: "benefits", fieldKey: "notes", label: "Notes", sortOrder: 0, defaultRequired: false },
  { cardKey: "emergency_safety", fieldKey: "notes", label: "Notes", sortOrder: 0, defaultRequired: false },

  // review_completion — deliberately empty, see this file's header comment.
] as const;

/** Every card key this catalog knows about, including `review_completion` (empty field list) — used to seed a zero-row placeholder-free company without special-casing it. */
export const CARD_KEYS_WITH_FIELD_CONFIG: readonly string[] = [
  "personal_identity",
  "employment",
  "organization_assignment",
  "reporting_relationships",
  "contact",
  "addresses",
  "working_time",
  "compensation",
  "payment_bank",
  "important_dates",
  "cost_allocation",
  "family_dependents",
  "education",
  "qualifications_skills",
  "assets",
  "documents",
  "time_leave_setup",
  "benefits",
  "emergency_safety",
  "review_completion",
] as const;
