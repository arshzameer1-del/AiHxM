/**
 * HR Administration reference-catalog type registry (Core Employee
 * Configuration/HR-Admin v2, 2026-09-27, Section 6). Every entry here is a
 * simple named list a tenant's own hr_admin manages — NOT Configuration
 * Center (see that document's Section 7: "Do not turn HR Administration
 * into a second Configuration Center"). New catalog types are added HERE,
 * not as a shared-types literal union and not as a new migration/table —
 * `hr_reference_catalog_items` (0090_hr_administration_reference_catalog.sql)
 * is the one generic table every entry below is stored in.
 *
 * `wiredInto` is documentation, not code — a plain note (surfaced in the
 * admin UI) of whether anything in the product actually reads this
 * catalog's codes today, or whether it's seeded and editable but not yet
 * enforced anywhere. Per the project's gap-analysis doc, only
 * `employment_type` and the 9 `lifecycle_reason:*` types
 * `EmployeeLifecycleService`'s own explicit transactions cover are wired;
 * the rest (hire/rehire/position_change/compensation_change/
 * probation_extension/confirmation/suspension/retirement/resignation/
 * contract_extension) are real, seeded, HR-Admin-editable catalogs with no
 * consuming transaction yet — honestly labeled as such rather than
 * silently implying they do something they don't.
 */
export type HrCatalogTypeDefinition = {
  catalogType: string;
  groupLabel: string;
  label: string;
  description: string;
  wiredInto: string;
};

export const HR_CATALOG_REGISTRY: HrCatalogTypeDefinition[] = [
  // --- 6.1 Employment & Workforce Setup ---------------------------------
  {
    catalogType: "employment_type",
    groupLabel: "Employment & Workforce Setup",
    label: "Employment Types",
    description: "The employment classifications this company uses (permanent, contract, probationary, intern, etc.).",
    wiredInto: "Employee record (create/edit) and the Hiring Wizard's Organization Assignment card.",
  },

  // --- 6.2 Lifecycle Reason Catalogs ------------------------------------
  {
    catalogType: "lifecycle_reason:hire",
    groupLabel: "Lifecycle Reason Catalogs",
    label: "Hire Reasons",
    description: "Reasons recorded when a new employee is hired.",
    wiredInto: "Not yet consumed by any transaction — seeded and editable, ready for future wiring into the Hiring Wizard.",
  },
  {
    catalogType: "lifecycle_reason:rehire",
    groupLabel: "Lifecycle Reason Catalogs",
    label: "Rehire Reasons",
    description: "Reasons recorded when a former employee is rehired.",
    wiredInto: "Not yet consumed by any transaction — seeded and editable.",
  },
  {
    catalogType: "lifecycle_reason:transfer",
    groupLabel: "Lifecycle Reason Catalogs",
    label: "Transfer Reasons",
    description: "Reasons recorded when an employee is transferred to a new organization unit or location.",
    wiredInto: "Employee Profile → Lifecycle Actions → Transfer.",
  },
  {
    catalogType: "lifecycle_reason:promotion",
    groupLabel: "Lifecycle Reason Catalogs",
    label: "Promotion Reasons",
    description: "Reasons recorded when an employee is promoted.",
    wiredInto: "Employee Profile → Lifecycle Actions → Promote.",
  },
  {
    catalogType: "lifecycle_reason:demotion",
    groupLabel: "Lifecycle Reason Catalogs",
    label: "Demotion Reasons",
    description: "Reasons recorded when an employee is demoted.",
    wiredInto: "Employee Profile → Lifecycle Actions → Demote.",
  },
  {
    catalogType: "lifecycle_reason:position_change",
    groupLabel: "Lifecycle Reason Catalogs",
    label: "Position Change Reasons",
    description: "Reasons recorded when an employee's position changes independently of a promotion or demotion.",
    wiredInto: "Not yet consumed by any transaction — seeded and editable.",
  },
  {
    catalogType: "lifecycle_reason:manager_change",
    groupLabel: "Lifecycle Reason Catalogs",
    label: "Manager Change Reasons",
    description: "Reasons recorded when an employee's manager changes.",
    wiredInto: "Employee Profile → Lifecycle Actions → Change manager.",
  },
  {
    catalogType: "lifecycle_reason:location_change",
    groupLabel: "Lifecycle Reason Catalogs",
    label: "Location Change Reasons",
    description: "Reasons recorded when an employee's work location changes.",
    wiredInto: "Employee Profile → Lifecycle Actions → Change location.",
  },
  {
    catalogType: "lifecycle_reason:secondment",
    groupLabel: "Lifecycle Reason Catalogs",
    label: "Secondment Reasons",
    description: "Reasons recorded when an employee is seconded to a temporary posting.",
    wiredInto: "Employee Profile → Lifecycle Actions → Second.",
  },
  {
    catalogType: "lifecycle_reason:acting_assignment",
    groupLabel: "Lifecycle Reason Catalogs",
    label: "Acting Assignment Reasons",
    description: "Reasons recorded when an employee is assigned an acting role.",
    wiredInto: "Employee Profile → Lifecycle Actions → Assign acting role.",
  },
  {
    catalogType: "lifecycle_reason:compensation_change",
    groupLabel: "Lifecycle Reason Catalogs",
    label: "Compensation Change Reasons",
    description: "Reasons recorded when an employee's compensation changes.",
    wiredInto: "Not yet consumed by any transaction — seeded and editable.",
  },
  {
    catalogType: "lifecycle_reason:probation_extension",
    groupLabel: "Lifecycle Reason Catalogs",
    label: "Probation Extension Reasons",
    description: "Reasons recorded when an employee's probation period is extended.",
    wiredInto: "Not yet consumed by any transaction — seeded and editable.",
  },
  {
    catalogType: "lifecycle_reason:confirmation",
    groupLabel: "Lifecycle Reason Catalogs",
    label: "Confirmation Reasons",
    description: "Reasons recorded when an employee's employment is confirmed after probation.",
    wiredInto: "Not yet consumed by any transaction — seeded and editable.",
  },
  {
    catalogType: "lifecycle_reason:suspension",
    groupLabel: "Lifecycle Reason Catalogs",
    label: "Suspension Reasons",
    description: "Reasons recorded when an employee is suspended.",
    wiredInto: "Not yet consumed by any transaction — seeded and editable.",
  },
  {
    catalogType: "lifecycle_reason:termination",
    groupLabel: "Lifecycle Reason Catalogs",
    label: "Termination Reasons",
    description: "Reasons recorded when an employee's employment ends.",
    wiredInto: "Employee Profile → Lifecycle Actions → Terminate.",
  },
  {
    catalogType: "lifecycle_reason:retirement",
    groupLabel: "Lifecycle Reason Catalogs",
    label: "Retirement Reasons",
    description: "Reasons recorded when an employee retires.",
    wiredInto: "Not yet consumed by any transaction — seeded and editable.",
  },
  {
    catalogType: "lifecycle_reason:resignation",
    groupLabel: "Lifecycle Reason Catalogs",
    label: "Resignation Reasons",
    description: "Reasons recorded when an employee resigns.",
    wiredInto: "Not yet consumed by any transaction — seeded and editable.",
  },
  {
    catalogType: "lifecycle_reason:contract_extension",
    groupLabel: "Lifecycle Reason Catalogs",
    label: "Contract Extension Reasons",
    description: "Reasons recorded when a fixed-term employee's contract is extended.",
    wiredInto: "Not yet consumed by any transaction — seeded and editable.",
  },
  {
    catalogType: "lifecycle_reason:return_from_leave",
    groupLabel: "Lifecycle Reason Catalogs",
    label: "Return From Leave Reasons",
    description: "Reasons recorded when an employee returns from an extended leave or a terminated employee is reactivated.",
    wiredInto: "Employee Profile → Lifecycle Actions → Reactivate.",
  },

  // --- 6.3 Personal & Reference Catalogs (gap-table item #7, 2026-10-01) ---
  // Six of the seven below already have a real, exposed data field —
  // each previously a hardcoded CHECK constraint or unconstrained free
  // text, both replaced by application-level validation against this
  // registry this same phase (0106_hr_administration_personal_reference_catalogs.sql's
  // own header comment has the full per-catalog mapping).
  {
    catalogType: "family_relationship_type",
    groupLabel: "Personal & Reference Catalogs",
    label: "Family Relationship Types",
    description: "The relationships available when recording an employee's family members / dependents (spouse, child, parent, etc.).",
    wiredInto: "Employee Profile → Family & Education, and the Hiring Wizard's Family/Dependents card.",
  },
  {
    catalogType: "marital_status",
    groupLabel: "Personal & Reference Catalogs",
    label: "Marital Status",
    description: "The marital status values available for an employee's personal record.",
    wiredInto: "Hiring Wizard's Personal Identity card.",
  },
  {
    catalogType: "qualification_type",
    groupLabel: "Personal & Reference Catalogs",
    label: "Qualification Types",
    description: "The categories available when recording an employee's qualifications/skills (certificate, license, skill, etc.).",
    wiredInto: "Employee Profile → Family & Education, and the Hiring Wizard's Qualifications/Skills card.",
  },
  {
    catalogType: "address_type",
    groupLabel: "Personal & Reference Catalogs",
    label: "Address Types",
    description: "The address types available on an employee's record (permanent, current, mailing).",
    wiredInto: "Employee Profile → Contact & Address, and the Hiring Wizard's Addresses card.",
  },
  {
    catalogType: "contact_type",
    groupLabel: "Personal & Reference Catalogs",
    label: "Contact Types",
    description: "The contact method types available on an employee's record (business email, personal phone, emergency contact, etc.).",
    wiredInto: "Employee Profile → Contact & Address, and the Hiring Wizard's Contact card.",
  },
  {
    catalogType: "document_type",
    groupLabel: "Personal & Reference Catalogs",
    label: "Document Types",
    description: "The document types available when uploading a file to an employee's document vault (CNIC, passport, degree certificate, etc.).",
    wiredInto: "Employee document upload (POST /employees/:id/documents).",
  },
  // The following are registered and seeded so an hr_admin can already
  // see and manage them here, but — like several of this file's own
  // `lifecycle_reason:*` entries above — none has a consuming field yet.
  // `nationality` is the nearest exception: the column exists
  // (persons.nationality, 0081_person_identity.sql) but no UI or API path
  // writes it today (persons.service.ts's own doc comment: no Person
  // UI/API surface exists yet). Honestly labeled rather than implying any
  // of these already govern real data — wiring each to a real field is
  // separately-scoped follow-up work.
  {
    catalogType: "nationality",
    groupLabel: "Personal & Reference Catalogs",
    label: "Nationality",
    description: "The nationality values available for an employee's personal record.",
    wiredInto: "Not yet consumed by any field — persons.nationality exists in the schema but has no UI/API write path yet. Seeded and editable, ready for future wiring.",
  },
  {
    catalogType: "language",
    groupLabel: "Personal & Reference Catalogs",
    label: "Language",
    description: "The spoken/primary language values available for an employee's personal record.",
    wiredInto: "Not yet consumed by any field — seeded and editable, ready for future wiring.",
  },
  {
    catalogType: "education_level",
    groupLabel: "Personal & Reference Catalogs",
    label: "Education Levels",
    description: "The education level values available on an employee's education entries (matriculation, bachelors, masters, etc.).",
    wiredInto: "Not yet consumed by any field — seeded and editable, ready for future wiring into the Education card.",
  },
  {
    catalogType: "institution_type",
    groupLabel: "Personal & Reference Catalogs",
    label: "Institution Types",
    description: "The institution type values available on an employee's education entries (university, college, vocational institute, etc.).",
    wiredInto: "Not yet consumed by any field — seeded and editable, ready for future wiring into the Education card.",
  },
  {
    catalogType: "certification_type",
    groupLabel: "Personal & Reference Catalogs",
    label: "Certification Types",
    description: "A finer classification of certificate-type qualifications (professional, vendor, compliance/regulatory, etc.).",
    wiredInto: "Not yet consumed by any field — seeded and editable, ready for future wiring into the Qualifications/Skills card.",
  },
  {
    catalogType: "document_category",
    groupLabel: "Personal & Reference Catalogs",
    label: "Document Categories",
    description: "A grouping of document types for the employee document vault (identity, educational, employment, financial, etc.).",
    wiredInto: "Not yet consumed by any field — seeded and editable, ready for future wiring into the document vault.",
  },
  {
    catalogType: "id_document_type",
    groupLabel: "Personal & Reference Catalogs",
    label: "ID Document Types",
    description: "The government identity document types a person's primary identifier can be (CNIC, NICOP, Passport, B-Form).",
    wiredInto: "Not yet consumed by any field — seeded and editable, ready for future wiring onto the Person record.",
  },
];

const REGISTRY_BY_TYPE = new Map(HR_CATALOG_REGISTRY.map((entry) => [entry.catalogType, entry]));

export function getCatalogTypeDefinition(catalogType: string): HrCatalogTypeDefinition | undefined {
  return REGISTRY_BY_TYPE.get(catalogType);
}

export function isRegisteredCatalogType(catalogType: string): boolean {
  return REGISTRY_BY_TYPE.has(catalogType);
}

/** The `lifecycle_reason:*` catalog type each of EmployeeLifecycleService's
 * 9 explicit transactions maps onto — see that service's own comment for
 * why `reactivate()` maps to `return_from_leave` rather than a dedicated
 * "reactivation" reason type (the spec's Section 6.2 list has no exact
 * match; "returning to active status" is the closest fit). */
export const LIFECYCLE_EVENT_REASON_CATALOG: Record<string, string> = {
  transfer: "lifecycle_reason:transfer",
  promotion: "lifecycle_reason:promotion",
  demotion: "lifecycle_reason:demotion",
  secondment: "lifecycle_reason:secondment",
  acting: "lifecycle_reason:acting_assignment",
  manager_change: "lifecycle_reason:manager_change",
  location_change: "lifecycle_reason:location_change",
  termination: "lifecycle_reason:termination",
  reactivation: "lifecycle_reason:return_from_leave",
};
