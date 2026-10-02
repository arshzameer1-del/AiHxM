/**
 * HR Administration business-policy type registry (Core Employee
 * Configuration/HR-Admin v2 "then 2" Phase 2, 2026-10-02, gap-table item
 * #8). Every entry here is a NAMED, ASSIGNABLE configuration object a
 * tenant's own hr_admin manages — distinct from `catalog-type-registry.ts`'s
 * flat {code, label} reference lists. New policy types are added HERE,
 * not as a new migration/table — `hr_business_policies`
 * (0107_hr_business_policies.sql) is the one generic table every entry
 * below is stored in, with the type-specific shape living in that row's
 * own `rules` JSONB column (see that migration's header comment for why
 * this is a JSONB-over-EAV design, not 9 bespoke tables).
 *
 * `rulesShape` is documentation, not validation — a short, human-readable
 * description of the keys a policy of this type's `rules` object is
 * expected to carry, surfaced in the admin UI so an hr_admin editing a
 * policy's rules (today, a structured-JSON editor — see
 * `BusinessPoliciesPanel.tsx`) knows what the consuming service actually
 * reads. `wiredInto` is the same honest-labeling convention
 * `catalog-type-registry.ts` already established: a plain note of
 * whether any real transaction in the product reads this policy's rules
 * today, or whether it is seeded/editable with no consumer yet.
 */
export type BusinessPolicyTypeDefinition = {
  policyType: string;
  label: string;
  description: string;
  rulesShape: string;
  wiredInto: string;
};

export const BUSINESS_POLICY_REGISTRY: BusinessPolicyTypeDefinition[] = [
  {
    policyType: "probation",
    label: "Probation Policy",
    description: "How long a new probationary hire's probation period runs, and whether/how it can be extended.",
    rulesShape: "durationDays (number), maxExtensions (number), extensionDays (number)",
    wiredInto:
      "EmployeesService.createWithinTransaction() — when a new hire's employment type is 'probation', the default policy's durationDays auto-computes that employee's 'probation_end' Important Date, unless the hire explicitly supplies one (which always wins).",
  },
  {
    policyType: "confirmation",
    label: "Confirmation Policy",
    description:
      "The minimum time that must elapse before a probationary employee can be confirmed, and the default confirmation reason.",
    rulesShape: "minProbationDays (number), defaultReasonCode (string, a lifecycle_reason:confirmation catalog code)",
    wiredInto: "Not yet consumed by any transaction — seeded and editable, ready for a future Confirm lifecycle action.",
  },
  {
    policyType: "document",
    label: "Document Policy",
    description: "The documents every employee is expected to have on file.",
    rulesShape: "requiredDocumentTypes (string[], document_type catalog codes)",
    wiredInto: "Not yet consumed by any transaction — seeded and editable.",
  },
  {
    policyType: "correction",
    label: "Correction Policy",
    description: "How long after a record is created HR can correct it without extra approval.",
    rulesShape: "editableWindowDays (number), requiresApprovalAfterWindow (boolean)",
    wiredInto: "Not yet consumed by any transaction — seeded and editable.",
  },
  {
    policyType: "transfer",
    label: "Transfer Policy",
    description: "The minimum notice period and approval requirement for an internal transfer.",
    rulesShape: "minNoticeDays (number), requiresApproval (boolean)",
    wiredInto: "Not yet consumed by any transaction — seeded and editable, ready for future wiring into EmployeeLifecycleService.transfer().",
  },
  {
    policyType: "rehire",
    label: "Rehire Policy",
    description:
      "How soon a previously terminated employee becomes eligible for rehire, and whether their old employee number is preserved.",
    rulesShape: "cooldownDays (number, 0 = no restriction), preserveEmployeeNumber (boolean)",
    wiredInto:
      "EmployeesService.createWithinTransaction() — when a hire is matched to an existing person by CNIC (persons.service.ts's own deterministic rehire-matching key) who has a prior terminated employment at this company, the default policy's cooldownDays is enforced against that employment's termination_date. Default cooldownDays is 0 (no restriction), so no tenant's existing behavior changes until they raise it.",
  },
  {
    policyType: "termination_exit",
    label: "Termination / Exit Policy",
    description: "Notice period, exit-clearance checklist requirement, and final-settlement timing on termination.",
    rulesShape: "noticeDays (number), requiresClearanceChecklist (boolean), finalSettlementDays (number)",
    wiredInto: "Not yet consumed by any transaction — seeded and editable, ready for future wiring into EmployeeLifecycleService.terminate().",
  },
  {
    policyType: "retention",
    label: "Retention Policy",
    description: "How long a terminated employee's records are retained before they become eligible for purge/anonymization.",
    rulesShape: "postTerminationRetentionDays (number)",
    wiredInto:
      "Not yet consumed by any transaction — seeded and editable, ready for future wiring into the Data Subject Requests module (0057_data_subject_requests.sql).",
  },
  {
    policyType: "required_info",
    label: "Required Information Policy",
    description: "The personal/employment fields that must be filled in before a hire can be completed.",
    rulesShape: "requiredFieldKeys (string[])",
    wiredInto: "Not yet consumed by any transaction — seeded and editable, ready for future wiring into HiringProcessService.complete().",
  },
];

export function isRegisteredPolicyType(policyType: string): boolean {
  return BUSINESS_POLICY_REGISTRY.some((entry) => entry.policyType === policyType);
}

export function getPolicyTypeDefinition(policyType: string): BusinessPolicyTypeDefinition | undefined {
  return BUSINESS_POLICY_REGISTRY.find((entry) => entry.policyType === policyType);
}
