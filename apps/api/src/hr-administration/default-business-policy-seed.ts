/**
 * The starter default policy every company gets per registered policy
 * type — the exact same 9 rows `0107_hr_business_policies.sql` inserted
 * for every company that existed when that migration ran. Kept here, as
 * data, so `HrBusinessPolicyService.ensureDefaultPolicies()` can lazily
 * seed the SAME defaults for any company created AFTER that migration,
 * the identical `DEFAULT_CATALOG_SEED`/`ensureDefaultCatalogItems()`
 * pattern Phase 1 already established for `hr_reference_catalog_items`.
 */
export const DEFAULT_BUSINESS_POLICY_SEED: {
  policyType: string;
  code: string;
  name: string;
  description: string;
  rules: Record<string, unknown>;
}[] = [
  {
    policyType: "probation",
    code: "default",
    name: "Standard Probation",
    description: "How long a new probationary hire's probation period runs, and whether/how it can be extended.",
    rules: { durationDays: 90, maxExtensions: 1, extensionDays: 30 },
  },
  {
    policyType: "confirmation",
    code: "default",
    name: "Standard Confirmation",
    description: "The minimum time that must elapse before a probationary employee can be confirmed, and the default confirmation reason.",
    rules: { minProbationDays: 90, defaultReasonCode: "probation_completed" },
  },
  {
    policyType: "document",
    code: "default",
    name: "Standard Document Requirements",
    description: "The documents every employee is expected to have on file.",
    rules: { requiredDocumentTypes: ["cnic", "photograph"] },
  },
  {
    policyType: "correction",
    code: "default",
    name: "Standard Correction Window",
    description: "How long after a record is created HR can correct it without extra approval.",
    rules: { editableWindowDays: 30, requiresApprovalAfterWindow: true },
  },
  {
    policyType: "transfer",
    code: "default",
    name: "Standard Transfer Notice",
    description: "The minimum notice period and approval requirement for an internal transfer.",
    rules: { minNoticeDays: 7, requiresApproval: true },
  },
  {
    policyType: "rehire",
    code: "default",
    name: "Standard Rehire Eligibility",
    description: "How soon a previously terminated employee becomes eligible for rehire, and whether their old employee number is preserved.",
    rules: { cooldownDays: 0, preserveEmployeeNumber: false },
  },
  {
    policyType: "termination_exit",
    code: "default",
    name: "Standard Termination / Exit",
    description: "Notice period, exit-clearance checklist requirement, and final-settlement timing on termination.",
    rules: { noticeDays: 30, requiresClearanceChecklist: true, finalSettlementDays: 15 },
  },
  {
    policyType: "retention",
    code: "default",
    name: "Standard Data Retention",
    description: "How long a terminated employee's records are retained before they become eligible for purge/anonymization.",
    rules: { postTerminationRetentionDays: 2555 },
  },
  {
    policyType: "required_info",
    code: "default",
    name: "Standard Required Information",
    description: "The personal/employment fields that must be filled in before a hire can be completed.",
    rules: { requiredFieldKeys: ["cnic", "dateOfBirth", "emergencyContact"] },
  },
];
