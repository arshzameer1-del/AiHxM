/**
 * BACKLOG46 — the list of "does the employee record agree with the place that owns the value" checks.
 * Each check is a WHERE clause over `employees e` (plus optional joins) so the count, the sample rows and the
 * tests all use the same definition. `fixable` means POST /employees/data-consistency/repair corrects it.
 */
export interface ConsistencyCheck {
  id: string;
  label: string;
  /** What the mismatch means for the person reading the screen. */
  explanation: string;
  severity: "high" | "medium" | "low";
  fixable: boolean;
  /** Extra JOIN text placed after `FROM employees e`. */
  joins?: string;
  where: string;
  /** SQL expression (text) describing the mismatch for one row. */
  detail: string;
}

const LIVE = "e.employment_status <> 'terminated'";
const PRIMARY_CONTACT = (types: string) =>
  `(SELECT c.value FROM employee_contacts c WHERE c.employee_id = e.id AND c.is_primary AND c.status = 'active' AND c.contact_type IN (${types}) ORDER BY CASE c.contact_type WHEN 'business_email' THEN 0 WHEN 'business_phone' THEN 0 ELSE 1 END LIMIT 1)`;

/** The mandatory document types: HR Administration > Business Policies > Document Policy (the company default). */
const REQUIRED_DOCS = `LATERAL (SELECT jsonb_array_elements_text(p.rules->'requiredDocumentTypes') AS document_type
    FROM hr_business_policies p WHERE p.company_id = e.company_id AND p.policy_type = 'document' AND p.is_default AND p.is_active
      AND jsonb_typeof(p.rules->'requiredDocumentTypes') = 'array')`;

export const CONSISTENCY_CHECKS: ConsistencyCheck[] = [
  {
    id: "department_differs_from_org_unit",
    label: "Department differs from the organisation unit",
    explanation: "The department shown on the employee is not the name of the organisation unit they are assigned to.",
    severity: "high",
    fixable: true,
    joins: "JOIN org_units ou ON ou.id = e.org_unit_id",
    where: "e.department IS DISTINCT FROM ou.name",
    detail: "COALESCE(e.department, '(blank)') || ' vs ' || ou.name",
  },
  {
    id: "designation_differs_from_position",
    label: "Designation differs from the position title",
    explanation: "The designation shown on the employee is not the title of the position they hold.",
    severity: "high",
    fixable: true,
    joins: "JOIN positions po ON po.id = e.position_id",
    where: "po.position_title IS NOT NULL AND e.designation IS DISTINCT FROM po.position_title",
    detail: "COALESCE(e.designation, '(blank)') || ' vs ' || po.position_title",
  },
  {
    id: "location_differs_from_master",
    label: "Location differs from the location master",
    explanation: "The location shown on the employee is not the name of the location they are assigned to.",
    severity: "medium",
    fixable: true,
    joins: "JOIN locations lo ON lo.id = e.location_id",
    where: "e.location IS DISTINCT FROM lo.name",
    detail: "COALESCE(e.location, '(blank)') || ' vs ' || lo.name",
  },
  {
    id: "department_text_only",
    label: "Department typed in, not linked to an organisation unit",
    explanation: "Reports and approvals follow the organisation unit, so this department is invisible to them. Pick the unit on the employee.",
    severity: "medium",
    fixable: false,
    where: `${LIVE} AND e.org_unit_id IS NULL AND NULLIF(btrim(e.department), '') IS NOT NULL`,
    detail: "e.department",
  },
  {
    id: "designation_text_only",
    label: "Designation typed in, not linked to a position",
    explanation: "Position-based vacancy and budget reports do not see this person. Assign the position on the employee.",
    severity: "low",
    fixable: false,
    where: `${LIVE} AND e.position_id IS NULL AND NULLIF(btrim(e.designation), '') IS NOT NULL`,
    detail: "e.designation",
  },
  {
    id: "no_org_unit",
    label: "Active employee with no organisation unit",
    explanation: "Approvals, headcount by unit and team reports cannot place this person.",
    severity: "high",
    fixable: false,
    where: `${LIVE} AND e.org_unit_id IS NULL AND NULLIF(btrim(e.department), '') IS NULL`,
    detail: "'No unit and no department'",
  },
  {
    id: "email_differs_from_contact",
    label: "Email differs from the primary business email contact",
    explanation: "The email on the employee and the primary business email in Contact & Address are different.",
    severity: "high",
    fixable: true,
    where: `${PRIMARY_CONTACT("'business_email'")} IS NOT NULL AND e.email IS DISTINCT FROM ${PRIMARY_CONTACT("'business_email'")}`,
    detail: `COALESCE(e.email, '(blank)') || ' vs ' || ${PRIMARY_CONTACT("'business_email'")}`,
  },
  {
    id: "phone_differs_from_contact",
    label: "Phone differs from the primary phone contact",
    explanation: "The phone on the employee and the primary phone in Contact & Address are different.",
    severity: "medium",
    fixable: true,
    where: `${PRIMARY_CONTACT("'business_phone','personal_phone'")} IS NOT NULL AND e.phone IS DISTINCT FROM ${PRIMARY_CONTACT("'business_phone','personal_phone'")}`,
    detail: `COALESCE(e.phone, '(blank)') || ' vs ' || ${PRIMARY_CONTACT("'business_phone','personal_phone'")}`,
  },
  {
    id: "email_without_contact",
    label: "Email on the employee with no contact record",
    explanation: "The email exists only as a plain field, so it does not show in Contact & Address.",
    severity: "low",
    fixable: true,
    where: `NULLIF(btrim(e.email), '') IS NOT NULL AND ${PRIMARY_CONTACT("'business_email'")} IS NULL`,
    detail: "e.email",
  },
  {
    id: "manager_differs_from_reporting_line",
    label: "Manager differs from the direct reporting line",
    explanation: "The manager on the employee is not the manager in the organisation's direct reporting line.",
    severity: "high",
    fixable: true,
    joins: "JOIN org_relationships rl ON rl.employee_id = e.id AND rl.relationship_type = 'direct' AND rl.status = 'active' LEFT JOIN employees mg ON mg.id = e.manager_id LEFT JOIN employees mr ON mr.id = rl.manager_employee_id",
    where: "e.manager_id IS DISTINCT FROM rl.manager_employee_id",
    detail: "COALESCE(mg.employee_number, '(none)') || ' vs ' || mr.employee_number",
  },
  {
    id: "manager_without_reporting_line",
    label: "Manager set but no direct reporting line",
    explanation: "Approvals that follow the reporting line will not find this person's manager.",
    severity: "medium",
    fixable: true,
    joins: "JOIN employees mg ON mg.id = e.manager_id",
    where: "NOT EXISTS (SELECT 1 FROM org_relationships rl WHERE rl.employee_id = e.id AND rl.relationship_type = 'direct' AND rl.status = 'active')",
    detail: "mg.employee_number",
  },
  {
    id: "manager_is_terminated",
    label: "Reports to a manager who has left",
    explanation: "Leave and other approvals will be routed to someone who is no longer employed.",
    severity: "high",
    fixable: false,
    joins: "JOIN employees mg ON mg.id = e.manager_id",
    where: `${LIVE} AND mg.employment_status = 'terminated'`,
    detail: "mg.employee_number || ' ' || mg.first_name || ' ' || mg.last_name",
  },
  {
    id: "name_differs_from_person",
    label: "Name differs from the person record",
    explanation: "The name on the employee does not match the name on the person record that shares their identity.",
    severity: "medium",
    fixable: false,
    joins: "JOIN persons pe ON pe.id = e.person_id",
    where: "pe.first_name IS NOT NULL AND (e.first_name IS DISTINCT FROM pe.first_name OR e.last_name IS DISTINCT FROM pe.last_name)",
    detail: "e.first_name || ' ' || e.last_name || ' vs ' || pe.first_name || ' ' || COALESCE(pe.last_name, '')",
  },
  {
    id: "bank_flat_without_account",
    label: "Bank account number with no active payment account",
    explanation: "The account number exists only as a plain field; payroll bank files read the payment accounts.",
    severity: "high",
    fixable: false,
    where: `${LIVE} AND NULLIF(btrim(e.bank_account_number), '') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM employee_payment_accounts pa WHERE pa.employee_id = e.id AND pa.status = 'active')`,
    detail: "'Account number on the employee only'",
  },
  {
    id: "no_payment_account",
    label: "Active employee with no payment account",
    explanation: "Salary cannot be paid by bank transfer until a bank account is added.",
    severity: "medium",
    fixable: false,
    where: `${LIVE} AND NOT EXISTS (SELECT 1 FROM employee_payment_accounts pa WHERE pa.employee_id = e.id AND pa.status = 'active')`,
    detail: "'No active payment account'",
  },
  {
    id: "terminated_without_date",
    label: "Terminated with no termination date",
    explanation: "Final settlement and attrition reports need the date the person left.",
    severity: "high",
    fixable: false,
    where: "e.employment_status = 'terminated' AND e.termination_date IS NULL",
    detail: "'Status terminated, date missing'",
  },
  {
    id: "termination_date_but_active",
    label: "Has a termination date but is still active",
    explanation: "The person has a leaving date but the status was never changed through Lifecycle Actions.",
    severity: "high",
    fixable: false,
    where: "e.employment_status <> 'terminated' AND e.termination_date IS NOT NULL AND e.termination_date <= CURRENT_DATE",
    detail: "'Left on ' || e.termination_date::text || ', status ' || e.employment_status",
  },
  {
    id: "termination_before_joining",
    label: "Termination date is before the joining date",
    explanation: "One of the two dates is wrong.",
    severity: "high",
    fixable: false,
    where: "e.termination_date IS NOT NULL AND e.termination_date < e.date_of_joining",
    detail: "'Joined ' || e.date_of_joining::text || ', left ' || e.termination_date::text",
  },
  {
    id: "no_current_salary",
    label: "Active employee with no current salary",
    explanation: "Payroll will skip this person or compute zero.",
    severity: "high",
    fixable: false,
    where: `${LIVE} AND NOT EXISTS (SELECT 1 FROM employee_compensation c WHERE c.employee_id = e.id AND c.effective_from <= CURRENT_DATE AND (c.effective_to IS NULL OR c.effective_to >= CURRENT_DATE))`,
    detail: "'No salary record covers today'",
  },
  {
    id: "salary_band_without_salary",
    label: "Salary band set but no current salary",
    explanation: "A band was picked but no salary was ever entered.",
    severity: "low",
    fixable: false,
    where: `${LIVE} AND NULLIF(btrim(e.salary_band), '') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM employee_compensation c WHERE c.employee_id = e.id AND c.effective_from <= CURRENT_DATE AND (c.effective_to IS NULL OR c.effective_to >= CURRENT_DATE))`,
    detail: "e.salary_band",
  },
  {
    id: "position_in_other_unit",
    label: "Position belongs to a different organisation unit",
    explanation: "The employee sits in one unit but holds a position that belongs to another.",
    severity: "medium",
    fixable: false,
    joins: "JOIN positions pp ON pp.id = e.position_id",
    where: "e.org_unit_id IS NOT NULL AND pp.org_unit_id IS NOT NULL AND pp.org_unit_id <> e.org_unit_id",
    detail: "pp.position_code",
  },
  {
    id: "position_not_active",
    label: "Holds a position that is archived or abolished",
    explanation: "The position no longer exists in the organisation structure.",
    severity: "medium",
    fixable: false,
    joins: "JOIN positions pq ON pq.id = e.position_id",
    where: `${LIVE} AND pq.status IN ('archived', 'abolished')`,
    detail: "pq.position_code || ' (' || pq.status || ')'",
  },
  {
    id: "cnic_expired",
    label: "CNIC has expired",
    explanation: "The CNIC expiry date on file is in the past. Ask the employee for the renewed card.",
    severity: "medium",
    fixable: false,
    joins: "JOIN employee_statutory_ids si ON si.employee_id = e.id",
    where: `${LIVE} AND NOT si.cnic_lifetime AND si.cnic_expiry_date < CURRENT_DATE`,
    detail: "'Expired on ' || si.cnic_expiry_date::text",
  },
  {
    id: "cnic_expiring_soon",
    label: "CNIC expires within 60 days",
    explanation: "Remind the employee to renew before it lapses.",
    severity: "low",
    fixable: false,
    joins: "JOIN employee_statutory_ids si ON si.employee_id = e.id",
    where: `${LIVE} AND NOT si.cnic_lifetime AND si.cnic_expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 60`,
    detail: "'Expires on ' || si.cnic_expiry_date::text",
  },
  {
    id: "visa_or_permit_expired",
    label: "Visa or work permit has expired",
    explanation: "A foreign employee's visa or work permit date is in the past.",
    severity: "high",
    fixable: false,
    joins: "JOIN employee_statutory_ids si ON si.employee_id = e.id",
    where: `${LIVE} AND (si.visa_expiry_date < CURRENT_DATE OR si.work_permit_expiry_date < CURRENT_DATE)`,
    detail: "'Visa ' || COALESCE(si.visa_expiry_date::text, '-') || ', permit ' || COALESCE(si.work_permit_expiry_date::text, '-')",
  },
  {
    id: "eobi_deducted_without_number",
    label: "EOBI deducted but no EOBI number on file",
    explanation: "EOBI contributions were taken from this person's pay but their registration number is missing, so the challan cannot be matched.",
    severity: "medium",
    fixable: false,
    where: `${LIVE} AND EXISTS (SELECT 1 FROM payslips p WHERE p.employee_id = e.id AND p.eobi_employee_contribution > 0)
            AND NOT EXISTS (SELECT 1 FROM employee_statutory_ids si WHERE si.employee_id = e.id AND si.eobi_number IS NOT NULL)`,
    detail: "'No EOBI number'",
  },
  {
    id: "nominee_shares_not_100",
    label: "Nominee shares do not add up to 100%",
    explanation: "The employee has beneficiaries, but their shares are missing or do not total 100%.",
    severity: "medium",
    fixable: false,
    where: `${LIVE} AND EXISTS (SELECT 1 FROM employee_family_members f WHERE f.employee_id = e.id AND f.status = 'active' AND f.is_beneficiary)
            AND COALESCE((SELECT SUM(f.beneficiary_share_percent) FROM employee_family_members f WHERE f.employee_id = e.id AND f.status = 'active' AND f.is_beneficiary), 0) <> 100`,
    detail: "'Shares total ' || COALESCE((SELECT SUM(f.beneficiary_share_percent) FROM employee_family_members f WHERE f.employee_id = e.id AND f.status = 'active' AND f.is_beneficiary), 0)::text || '%'",
  },
  {
    id: "mandatory_document_missing",
    label: "Mandatory document missing",
    explanation: "The company lists this document type as mandatory, but no approved copy is on the employee's file.",
    severity: "medium",
    fixable: false,
    where: `${LIVE} AND EXISTS (SELECT 1 FROM ${REQUIRED_DOCS} rd(document_type)
              WHERE NOT EXISTS (SELECT 1 FROM employee_documents d WHERE d.employee_id = e.id AND d.document_type = rd.document_type AND d.review_status = 'approved'))`,
    detail: `'Missing: ' || (SELECT string_agg(rd.document_type, ', ' ORDER BY rd.document_type) FROM ${REQUIRED_DOCS} rd(document_type)
              WHERE NOT EXISTS (SELECT 1 FROM employee_documents d WHERE d.employee_id = e.id AND d.document_type = rd.document_type AND d.review_status = 'approved'))`,
  },
  {
    id: "document_expired",
    label: "A document on file has expired",
    explanation: "The newest approved copy of this document type is past its expiry date and nothing in date replaces it.",
    severity: "medium",
    fixable: false,
    where: `${LIVE} AND EXISTS (SELECT 1 FROM employee_documents d WHERE d.employee_id = e.id AND d.review_status = 'approved' AND d.expiry_date < CURRENT_DATE
              AND NOT EXISTS (SELECT 1 FROM employee_documents n WHERE n.employee_id = e.id AND n.document_type = d.document_type AND n.review_status = 'approved'
                              AND (n.expiry_date IS NULL OR n.expiry_date >= CURRENT_DATE)))`,
    detail: `'Expired: ' || (SELECT string_agg(DISTINCT d.document_type, ', ') FROM employee_documents d WHERE d.employee_id = e.id AND d.review_status = 'approved' AND d.expiry_date < CURRENT_DATE
              AND NOT EXISTS (SELECT 1 FROM employee_documents n WHERE n.employee_id = e.id AND n.document_type = d.document_type AND n.review_status = 'approved'
                              AND (n.expiry_date IS NULL OR n.expiry_date >= CURRENT_DATE)))`,
  },
  {
    id: "same_person_two_active_records",
    label: "The same person has two active records",
    explanation:
      "Two employee records that are both active belong to one person (same CNIC or person record). That is right for a genuine second role, but it also means two payslips, so check it is not a duplicate hire.",
    severity: "medium",
    fixable: false,
    where: `e.person_id IS NOT NULL AND ${LIVE} AND EXISTS (SELECT 1 FROM employees o WHERE o.company_id = e.company_id AND o.person_id = e.person_id AND o.id <> e.id AND o.employment_status <> 'terminated')`,
    detail: "'also active as ' || (SELECT string_agg(o.employee_number, ', ') FROM employees o WHERE o.company_id = e.company_id AND o.person_id = e.person_id AND o.id <> e.id AND o.employment_status <> 'terminated')",
  },
];
