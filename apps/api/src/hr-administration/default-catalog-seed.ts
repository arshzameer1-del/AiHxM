/**
 * The starter catalog items every company gets by default — the exact
 * same list `0090_hr_administration_reference_catalog.sql` inserted for
 * every company that existed when that migration ran. Kept here, as data,
 * so `HrReferenceCatalogService.ensureDefaultCatalogItems()` can lazily
 * seed the SAME defaults for any company created AFTER that migration
 * (new signups, Platform-Admin-created companies) — the identical
 * "ensureX() seeds once per company on first real read" pattern
 * `HiringProcessService.ensureCardDefinitions()` already established, so
 * this migration's own seed and this file never need to be kept in sync
 * by hand at more than this one list.
 */
export const DEFAULT_CATALOG_SEED: { catalogType: string; code: string; label: string; sortOrder: number }[] = [
  { catalogType: "employment_type", code: "permanent", label: "Permanent", sortOrder: 0 },
  { catalogType: "employment_type", code: "contract", label: "Contract", sortOrder: 1 },
  { catalogType: "employment_type", code: "probation", label: "Probationary", sortOrder: 2 },
  { catalogType: "employment_type", code: "intern", label: "Intern", sortOrder: 3 },

  { catalogType: "lifecycle_reason:hire", code: "new_position", label: "New position", sortOrder: 0 },
  { catalogType: "lifecycle_reason:hire", code: "replacement", label: "Replacement hire", sortOrder: 1 },
  { catalogType: "lifecycle_reason:hire", code: "business_growth", label: "Business growth", sortOrder: 2 },
  { catalogType: "lifecycle_reason:hire", code: "referral", label: "Employee referral", sortOrder: 3 },

  { catalogType: "lifecycle_reason:rehire", code: "rejoined", label: "Rejoined after resignation", sortOrder: 0 },
  { catalogType: "lifecycle_reason:rehire", code: "contract_renewed", label: "Contract renewed", sortOrder: 1 },
  { catalogType: "lifecycle_reason:rehire", code: "seasonal_return", label: "Seasonal return", sortOrder: 2 },

  { catalogType: "lifecycle_reason:transfer", code: "business_need", label: "Business need", sortOrder: 0 },
  { catalogType: "lifecycle_reason:transfer", code: "employee_request", label: "Employee request", sortOrder: 1 },
  { catalogType: "lifecycle_reason:transfer", code: "restructuring", label: "Departmental restructuring", sortOrder: 2 },
  { catalogType: "lifecycle_reason:transfer", code: "skill_match", label: "Better skill match", sortOrder: 3 },

  { catalogType: "lifecycle_reason:promotion", code: "merit", label: "Merit-based", sortOrder: 0 },
  { catalogType: "lifecycle_reason:promotion", code: "role_change", label: "Role change", sortOrder: 1 },
  { catalogType: "lifecycle_reason:promotion", code: "annual_review", label: "Annual review outcome", sortOrder: 2 },

  { catalogType: "lifecycle_reason:demotion", code: "performance", label: "Performance issue", sortOrder: 0 },
  { catalogType: "lifecycle_reason:demotion", code: "restructuring", label: "Restructuring", sortOrder: 1 },
  { catalogType: "lifecycle_reason:demotion", code: "voluntary", label: "Employee request", sortOrder: 2 },

  { catalogType: "lifecycle_reason:position_change", code: "restructuring", label: "Organizational restructuring", sortOrder: 0 },
  { catalogType: "lifecycle_reason:position_change", code: "reclassification", label: "Position reclassification", sortOrder: 1 },

  { catalogType: "lifecycle_reason:manager_change", code: "restructuring", label: "Team restructuring", sortOrder: 0 },
  { catalogType: "lifecycle_reason:manager_change", code: "manager_exit", label: "Manager left the company", sortOrder: 1 },
  { catalogType: "lifecycle_reason:manager_change", code: "realignment", label: "Reporting realignment", sortOrder: 2 },

  { catalogType: "lifecycle_reason:location_change", code: "relocation", label: "Employee relocation", sortOrder: 0 },
  { catalogType: "lifecycle_reason:location_change", code: "business_need", label: "Business need", sortOrder: 1 },
  { catalogType: "lifecycle_reason:location_change", code: "office_closure", label: "Office closure", sortOrder: 2 },

  { catalogType: "lifecycle_reason:secondment", code: "project_assignment", label: "Project assignment", sortOrder: 0 },
  { catalogType: "lifecycle_reason:secondment", code: "cross_training", label: "Cross-training", sortOrder: 1 },
  { catalogType: "lifecycle_reason:secondment", code: "business_need", label: "Business need", sortOrder: 2 },

  { catalogType: "lifecycle_reason:acting_assignment", code: "vacancy_coverage", label: "Covering a vacancy", sortOrder: 0 },
  { catalogType: "lifecycle_reason:acting_assignment", code: "leave_coverage", label: "Covering leave", sortOrder: 1 },
  { catalogType: "lifecycle_reason:acting_assignment", code: "interim_need", label: "Interim business need", sortOrder: 2 },

  { catalogType: "lifecycle_reason:compensation_change", code: "annual_increment", label: "Annual increment", sortOrder: 0 },
  { catalogType: "lifecycle_reason:compensation_change", code: "market_adjustment", label: "Market adjustment", sortOrder: 1 },
  { catalogType: "lifecycle_reason:compensation_change", code: "promotion_linked", label: "Linked to promotion", sortOrder: 2 },

  { catalogType: "lifecycle_reason:probation_extension", code: "performance_review", label: "Performance needs more time", sortOrder: 0 },
  { catalogType: "lifecycle_reason:probation_extension", code: "attendance", label: "Attendance concerns", sortOrder: 1 },
  { catalogType: "lifecycle_reason:probation_extension", code: "training_incomplete", label: "Training not yet complete", sortOrder: 2 },

  { catalogType: "lifecycle_reason:confirmation", code: "satisfactory_performance", label: "Satisfactory performance", sortOrder: 0 },
  { catalogType: "lifecycle_reason:confirmation", code: "probation_completed", label: "Probation period completed", sortOrder: 1 },

  { catalogType: "lifecycle_reason:suspension", code: "misconduct_investigation", label: "Misconduct under investigation", sortOrder: 0 },
  { catalogType: "lifecycle_reason:suspension", code: "policy_violation", label: "Policy violation", sortOrder: 1 },
  { catalogType: "lifecycle_reason:suspension", code: "disciplinary", label: "Disciplinary action", sortOrder: 2 },

  { catalogType: "lifecycle_reason:termination", code: "resignation", label: "Resignation", sortOrder: 0 },
  { catalogType: "lifecycle_reason:termination", code: "performance", label: "Performance", sortOrder: 1 },
  { catalogType: "lifecycle_reason:termination", code: "misconduct", label: "Misconduct", sortOrder: 2 },
  { catalogType: "lifecycle_reason:termination", code: "redundancy", label: "Redundancy", sortOrder: 3 },
  { catalogType: "lifecycle_reason:termination", code: "end_of_contract", label: "End of contract", sortOrder: 4 },

  { catalogType: "lifecycle_reason:retirement", code: "normal_retirement", label: "Normal retirement age", sortOrder: 0 },
  { catalogType: "lifecycle_reason:retirement", code: "early_retirement", label: "Early retirement", sortOrder: 1 },

  { catalogType: "lifecycle_reason:resignation", code: "better_opportunity", label: "Better opportunity", sortOrder: 0 },
  { catalogType: "lifecycle_reason:resignation", code: "personal_reasons", label: "Personal reasons", sortOrder: 1 },
  { catalogType: "lifecycle_reason:resignation", code: "relocation", label: "Relocation", sortOrder: 2 },
  { catalogType: "lifecycle_reason:resignation", code: "higher_education", label: "Higher education", sortOrder: 3 },

  { catalogType: "lifecycle_reason:contract_extension", code: "business_need", label: "Continued business need", sortOrder: 0 },
  { catalogType: "lifecycle_reason:contract_extension", code: "satisfactory_performance", label: "Satisfactory performance", sortOrder: 1 },

  { catalogType: "lifecycle_reason:return_from_leave", code: "leave_completed", label: "Leave period completed", sortOrder: 0 },
  { catalogType: "lifecycle_reason:return_from_leave", code: "early_return", label: "Early return from leave", sortOrder: 1 },

  // HR Administration v2, "then 2" Phase 1 (2026-10-01, gap-table item #7)
  // — same list 0106_hr_administration_personal_reference_catalogs.sql
  // seeded for every company that existed at migration time; kept here so
  // a company created afterward gets the identical starter set lazily,
  // the same "ensureX() seeds once per company" rule this file's own doc
  // comment already documents.
  { catalogType: "family_relationship_type", code: "spouse", label: "Spouse", sortOrder: 0 },
  { catalogType: "family_relationship_type", code: "child", label: "Child", sortOrder: 1 },
  { catalogType: "family_relationship_type", code: "parent", label: "Parent", sortOrder: 2 },
  { catalogType: "family_relationship_type", code: "sibling", label: "Sibling", sortOrder: 3 },
  { catalogType: "family_relationship_type", code: "other", label: "Other", sortOrder: 4 },

  { catalogType: "qualification_type", code: "certificate", label: "Certificate", sortOrder: 0 },
  { catalogType: "qualification_type", code: "license", label: "License", sortOrder: 1 },
  { catalogType: "qualification_type", code: "skill", label: "Skill", sortOrder: 2 },

  { catalogType: "address_type", code: "permanent", label: "Permanent", sortOrder: 0 },
  { catalogType: "address_type", code: "current", label: "Current", sortOrder: 1 },
  { catalogType: "address_type", code: "mailing", label: "Mailing", sortOrder: 2 },

  { catalogType: "contact_type", code: "business_email", label: "Business email", sortOrder: 0 },
  { catalogType: "contact_type", code: "personal_email", label: "Personal email", sortOrder: 1 },
  { catalogType: "contact_type", code: "business_phone", label: "Business phone", sortOrder: 2 },
  { catalogType: "contact_type", code: "personal_phone", label: "Personal phone", sortOrder: 3 },
  { catalogType: "contact_type", code: "emergency_contact", label: "Emergency contact", sortOrder: 4 },

  { catalogType: "document_type", code: "cnic", label: "CNIC", sortOrder: 0 },
  { catalogType: "document_type", code: "cnic_copy", label: "CNIC copy", sortOrder: 1 },
  { catalogType: "document_type", code: "passport", label: "Passport", sortOrder: 2 },
  { catalogType: "document_type", code: "driving_license", label: "Driving license", sortOrder: 3 },
  { catalogType: "document_type", code: "degree_certificate", label: "Degree certificate", sortOrder: 4 },
  { catalogType: "document_type", code: "experience_letter", label: "Experience letter", sortOrder: 5 },
  { catalogType: "document_type", code: "offer_letter", label: "Offer letter", sortOrder: 6 },
  { catalogType: "document_type", code: "bank_statement", label: "Bank statement", sortOrder: 7 },
  { catalogType: "document_type", code: "photograph", label: "Photograph", sortOrder: 8 },
  { catalogType: "document_type", code: "other", label: "Other", sortOrder: 9 },

  { catalogType: "marital_status", code: "single", label: "Single", sortOrder: 0 },
  { catalogType: "marital_status", code: "married", label: "Married", sortOrder: 1 },
  { catalogType: "marital_status", code: "divorced", label: "Divorced", sortOrder: 2 },
  { catalogType: "marital_status", code: "widowed", label: "Widowed", sortOrder: 3 },

  { catalogType: "nationality", code: "pk", label: "Pakistani", sortOrder: 0 },
  { catalogType: "nationality", code: "other", label: "Other", sortOrder: 1 },

  { catalogType: "language", code: "ur", label: "Urdu", sortOrder: 0 },
  { catalogType: "language", code: "en", label: "English", sortOrder: 1 },
  { catalogType: "language", code: "pa", label: "Punjabi", sortOrder: 2 },
  { catalogType: "language", code: "sd", label: "Sindhi", sortOrder: 3 },
  { catalogType: "language", code: "ps", label: "Pashto", sortOrder: 4 },
  { catalogType: "language", code: "other", label: "Other", sortOrder: 5 },

  { catalogType: "education_level", code: "matric", label: "Matriculation", sortOrder: 0 },
  { catalogType: "education_level", code: "intermediate", label: "Intermediate", sortOrder: 1 },
  { catalogType: "education_level", code: "bachelors", label: "Bachelors", sortOrder: 2 },
  { catalogType: "education_level", code: "masters", label: "Masters", sortOrder: 3 },
  { catalogType: "education_level", code: "phd", label: "PhD", sortOrder: 4 },
  { catalogType: "education_level", code: "other", label: "Other", sortOrder: 5 },

  { catalogType: "institution_type", code: "university", label: "University", sortOrder: 0 },
  { catalogType: "institution_type", code: "college", label: "College", sortOrder: 1 },
  { catalogType: "institution_type", code: "vocational", label: "Vocational institute", sortOrder: 2 },
  { catalogType: "institution_type", code: "online", label: "Online platform", sortOrder: 3 },
  { catalogType: "institution_type", code: "other", label: "Other", sortOrder: 4 },

  { catalogType: "certification_type", code: "professional", label: "Professional certification", sortOrder: 0 },
  { catalogType: "certification_type", code: "vendor", label: "Vendor certification", sortOrder: 1 },
  { catalogType: "certification_type", code: "compliance", label: "Compliance / regulatory", sortOrder: 2 },
  { catalogType: "certification_type", code: "other", label: "Other", sortOrder: 3 },

  { catalogType: "document_category", code: "identity", label: "Identity", sortOrder: 0 },
  { catalogType: "document_category", code: "educational", label: "Educational", sortOrder: 1 },
  { catalogType: "document_category", code: "employment", label: "Employment", sortOrder: 2 },
  { catalogType: "document_category", code: "financial", label: "Financial", sortOrder: 3 },
  { catalogType: "document_category", code: "other", label: "Other", sortOrder: 4 },

  { catalogType: "id_document_type", code: "cnic", label: "CNIC", sortOrder: 0 },
  { catalogType: "id_document_type", code: "nicop", label: "NICOP", sortOrder: 1 },
  { catalogType: "id_document_type", code: "passport", label: "Passport", sortOrder: 2 },
  { catalogType: "id_document_type", code: "b_form", label: "B-Form", sortOrder: 3 },
];
