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
];
