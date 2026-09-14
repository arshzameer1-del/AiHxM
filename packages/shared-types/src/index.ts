/**
 * Shared TypeScript types across apps/api and apps/web.
 *
 * Phase 2 adds the Platform Provisioning Panel's domain shapes. These are
 * hand-written rather than generated from a schema (Decision #2 dropped
 * Prisma), so when a migration changes a table shape, update the matching
 * type here in the same PR — there is no build step that would catch the
 * two drifting apart.
 */

export type HealthStatus = {
  status: "ok" | "degraded" | "down";
  service: string;
  phase: string;
  timestamp: string;
};

// --- Module catalog -----------------------------------------------------
// The nine real modules from the prototype, plus `dummy` — Phase 5's
// scaffolding module (see apps/api/migrations/0006_module_entitlement.sql
// header), included here so the existing Company Config "Modules" screen
// can toggle it through the real UI with no separate mechanism. Real
// per-tenant licensing now exists (module_catalog / package_tier /
// package_tier_modules / tenant_module_entitlement, migration 0006) —
// CompanyConfig.enabledModules below is a live view over
// tenant_module_entitlement, not a value anyone sets directly anymore.
export const MODULE_KEYS = [
  "employee",
  "leave",
  "recruitment",
  "performance",
  "payroll",
  "succession",
  "learning",
  "exit",
  "bi",
  "dummy",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export type PackageTier = "starter" | "growth" | "professional" | "enterprise";

export type CompanyStatus = "trial" | "active" | "suspended" | "churned";

// --- Employee Number format (plan doc Section 5) -------------------------
export type EmployeeNumberFormat = {
  prefix: string;
  padding: number;
  startingSequence: number;
  preserveImportedNumbers: boolean;
};

export type CompanyBranding = {
  logoUrl?: string;
  primaryColor?: string;
};

export type Company = {
  id: string;
  name: string;
  slug: string;
  status: CompanyStatus;
  packageTier: PackageTier;
  createdAt: string;
  updatedAt: string;
};

/** Dashboard row — a Company plus display-only figures that aren't real billing data yet. */
export type CompanyDashboardRow = Company & {
  /**
   * Deterministic mock figure, not a real billing integration. Phase 2
   * has no billing system; this exists only so the Dashboard screen the
   * plan doc describes ("all companies, MRR, status") isn't blank. Wire
   * a real value here once billing exists.
   */
  mockMrrUsd: number;
  adminCount: number;
};

export type CompanyConfig = {
  companyId: string;
  branding: CompanyBranding;
  /**
   * Always read fresh from `tenant_module_entitlement` (Phase 5) — the
   * real licensing source of truth `EntitlementsService.isModuleEnabled()`
   * gates on. Setting this via `updateCompanyConfig` writes real
   * entitlement rows, not just a display value.
   */
  enabledModules: ModuleKey[];
  employeeNumberFormat: EmployeeNumberFormat;
  updatedAt: string;
};

export type CompanyAdminStatus = "active" | "locked";

export type CompanyAdmin = {
  id: string;
  companyId: string;
  fullName: string;
  email: string;
  status: CompanyAdminStatus;
  createdAt: string;
  /** Whether a real login (Phase 3 user_accounts row) exists for this admin yet. */
  hasLogin: boolean;
};

export type CompanyDetail = {
  company: Company;
  config: CompanyConfig;
  admins: CompanyAdmin[];
};

export type CreateCompanyRequest = {
  name: string;
  slug: string;
  packageTier?: PackageTier;
  enabledModules?: ModuleKey[];
  employeeNumberFormat?: Partial<EmployeeNumberFormat>;
  initialAdmin?: {
    fullName: string;
    email: string;
  };
};

export type AuditLogEntry = {
  id: string;
  companyId: string | null;
  companyName?: string | null;
  actor: string;
  action: string;
  target: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type ImpersonateResponse = {
  token: string;
  expiresIn: string;
  companyId: string;
  note: string;
};

// --- Phase 3: Auth & Identity --------------------------------------------
// Real per-account authentication (password + mandatory TOTP MFA),
// replacing Phase 2's single shared platform-admin credential. See
// apps/api/migrations/0002_auth_identity.sql and DECISIONS.md Decision #3.

export type LoginRequest = {
  email: string;
  password: string;
};

/**
 * Discriminated on `status`. MFA is mandatory for both admin tiers, so a
 * fresh account always gets `mfa_setup_required` on its very first
 * successful password check, never a bare `ok`.
 */
export type LoginResult =
  | { status: "ok"; token: string }
  | { status: "mfa_setup_required"; mfaTicket: string; otpauthUrl: string; secretForManualEntry: string }
  | { status: "mfa_required"; mfaTicket: string };

export type MfaEnrollConfirmRequest = {
  mfaTicket: string;
  code: string;
};

export type MfaVerifyRequest = {
  mfaTicket: string;
  code: string;
};

export type SessionResult = {
  status: "ok";
  token: string;
};

export type PasswordResetRequestBody = {
  email: string;
};

/**
 * Phase 3 has no email/notification system yet (that's Phase 6's WRICEF
 * Interfaces work) — the reset token comes back directly in this
 * response, clearly labeled, rather than being silently unusable.
 */
export type PasswordResetRequestResult = {
  message: string;
  devModeToken?: string;
};

export type PasswordResetConfirmRequest = {
  token: string;
  newPassword: string;
};

export type CreateLoginRequest = {
  initialPassword: string;
};

/**
 * Platform Admin profile row (platform_admins table). Distinct from
 * CompanyAdmin — no companyId, and creation always bundles a login in one
 * step (see PlatformAdminsService) rather than a separate "add profile,
 * then create login" flow, since a Platform Admin with no login is never
 * a useful intermediate state the way a freshly-imported CompanyAdmin is.
 */
export type PlatformAdmin = {
  id: string;
  fullName: string;
  email: string;
  status: CompanyAdminStatus;
  createdAt: string;
};

export type CreatePlatformAdminRequest = {
  fullName: string;
  email: string;
  initialPassword: string;
};

// --- Phase 4: RBAC + Field-Level Permission Engine -----------------------
// See apps/api/migrations/0004_rbac.sql and apps/api/src/rbac/rbac.service.ts.
// `can()` (object/record-level) and `resolveFieldAccess()` (field-level,
// including conditional sibling-field rules) are the two engines the plan
// doc's enforcement order calls for; these types describe the catalog and
// assignment data they read, plus the dummy_records proof-of-concept
// object used to test them until Employee Core (Phase 7) provides a real one.

export type FieldAccess = "view" | "edit" | "hidden";

export type Role = {
  id: string;
  key: string;
  name: string;
  description: string | null;
};

export type Permission = {
  id: string;
  key: string;
  description: string | null;
};

export type UserRoleAssignment = {
  id: string;
  userAccountId: string;
  companyId: string;
  roleId: string;
  roleKey: string;
  createdAt: string;
};

export type AssignRoleRequest = {
  userAccountId: string;
  companyId: string;
  roleKey: string;
};

/**
 * dummy_records, filtered through RbacService.filterRecordFields before it
 * ever reaches the client — `testField`/`secretField` are simply absent
 * from the object (not present-but-null) when the caller's role doesn't
 * grant them. Never a real product object; exists only to prove the
 * engine (see this phase's own exit criterion).
 */
export type DummyRecordView = {
  id: string;
  companyId: string;
  ownerUserAccountId: string | null;
  title: string;
  status: "locked" | "unlocked";
  createdAt: string;
  testField?: string | null;
  secretField?: string | null;
};

// --- Phase 6: WRICEF Framework Skeleton — Workflow engine -----------------
// See apps/api/migrations/0007_wricef_workflow.sql and
// apps/api/src/workflow/workflow.service.ts. "manager_of_submitter" was
// deliberately not a supported ApproverType at first — it needed the
// employee/manager hierarchy Phase 7 (Employee Core) introduces — and is
// added in Phase 9 (0014_workflow_manager_of_submitter.sql) as that
// phase's own leave-approval routing needs it. It carries neither a
// `roleId` nor a `userAccountId` at template-configuration time (there is
// no fixed role or person to name in advance); WorkflowService resolves
// it fresh, per instance, from the submitting employee's own manager at
// the moment the step activates. It is deliberately NOT a valid
// `escalationApproverType` — escalating to "the manager's manager" is
// unbuilt scope (see KNOWN_ISSUES.md); an escalation target is always
// `role` or `specific_user`, enforced by the DTO independently of this
// shared type.

export type ApproverType = "role" | "specific_user" | "manager_of_submitter";

export type EscalationApproverType = "role" | "specific_user";

export type WorkflowApproverConfig = {
  approverType: ApproverType;
  roleId?: string;
  userAccountId?: string;
  escalationApproverType?: EscalationApproverType;
  escalationRoleId?: string;
  escalationUserAccountId?: string;
};

export type WorkflowFieldCondition = { field: string; equals: unknown };

export type WorkflowStepConfig = {
  stepOrder: number;
  name: string;
  condition?: WorkflowFieldCondition | null;
  /** Hours until a pending approval on this step is escalated. Omit for no SLA. */
  slaHours?: number;
  /** One entry per required approval line — more than one means every line must approve ("parallel"). */
  approvers: WorkflowApproverConfig[];
};

export type WorkflowTemplate = {
  id: string;
  companyId: string;
  key: string;
  name: string;
  objectKey: string;
  isActive: boolean;
  steps: WorkflowStepConfig[];
  createdAt: string;
};

export type CreateWorkflowTemplateRequest = {
  key: string;
  name: string;
  objectKey: string;
  steps: WorkflowStepConfig[];
};

export type WorkflowInstanceStatus = "in_progress" | "approved" | "rejected" | "cancelled";
export type WorkflowStepStatus = "pending" | "skipped" | "approved" | "rejected";
export type WorkflowApprovalStatus = "pending" | "escalated" | "approved" | "rejected";

export type WorkflowStepApprovalView = {
  id: string;
  approverType: ApproverType;
  roleId: string | null;
  userAccountId: string | null;
  status: WorkflowApprovalStatus;
  dueAt: string | null;
  escalatedAt: string | null;
  escalatedToUserAccountId: string | null;
  decidedByUserAccountId: string | null;
  decision: "approved" | "rejected" | null;
  comment: string | null;
};

export type WorkflowStepInstanceView = {
  id: string;
  stepOrder: number;
  name: string;
  status: WorkflowStepStatus;
  approvals: WorkflowStepApprovalView[];
};

export type WorkflowInstanceView = {
  id: string;
  companyId: string;
  templateId: string;
  templateKey: string;
  objectKey: string;
  recordId: string;
  submittedByUserAccountId: string;
  /** See 0014_workflow_manager_of_submitter.sql: who a `manager_of_submitter`
   * approver resolves against — the caller for an ordinary submission, or
   * (for an On-Behalf submission) the employee the request is actually about. */
  subjectUserAccountId: string;
  status: WorkflowInstanceStatus;
  steps: WorkflowStepInstanceView[];
  createdAt: string;
  updatedAt: string;
};

export type SubmitForApprovalRequest = {
  templateKey: string;
  objectKey: string;
  recordId: string;
  /**
   * A snapshot of the record's fields at submission time, used only to
   * evaluate conditional steps (WorkflowStepConfig.condition). The engine
   * never queries the object's own table itself — see
   * 0007_wricef_workflow.sql's header comment.
   */
  record: Record<string, unknown>;
  /** See WorkflowInstanceView.subjectUserAccountId. Omit for an ordinary
   * self-submission; set for an On-Behalf submission. */
  subjectUserAccountId?: string;
};

export type ApprovalDecisionRequest = {
  decision: "approved" | "rejected";
  comment?: string;
};

// --- Phase 6: WRICEF Framework Skeleton — Enhancements (custom fields) ---

export type CustomFieldType = "text" | "number" | "boolean" | "date" | "select";

export type CustomFieldDefinition = {
  id: string;
  companyId: string;
  objectKey: string;
  fieldKey: string;
  label: string;
  fieldType: CustomFieldType;
  options?: string[];
  isRequired: boolean;
  createdAt: string;
};

export type DefineCustomFieldRequest = {
  objectKey: string;
  fieldKey: string;
  label: string;
  fieldType: CustomFieldType;
  options?: string[];
  isRequired?: boolean;
};

export type SetCustomFieldValueRequest = {
  objectKey: string;
  recordId: string;
  fieldKey: string;
  value: unknown;
};

// --- Phase 6: WRICEF Framework Skeleton — Interfaces (notifications) -----
// Logged/stubbed only, per the plan doc's own wording — see
// 0009_wricef_fields_notifications_forms.sql's header comment and
// KNOWN_ISSUES.md for what "real provider" means when it's built.

export type NotificationChannel = "email" | "whatsapp" | "push" | "in_app";

export type DispatchNotificationRequest = {
  channel: NotificationChannel;
  recipient: string;
  templateKey: string;
  payload?: Record<string, unknown>;
};

export type NotificationLogEntry = {
  id: string;
  companyId: string;
  channel: NotificationChannel;
  recipient: string;
  templateKey: string;
  payload: Record<string, unknown>;
  status: "logged" | "sent" | "failed";
  createdAt: string;
};

// --- Phase 6: WRICEF Framework Skeleton — Forms (document templates) -----

export type DocumentTemplate = {
  id: string;
  companyId: string;
  key: string;
  name: string;
  objectKey: string;
  templateBody: string;
  createdAt: string;
};

export type CreateDocumentTemplateRequest = {
  key: string;
  name: string;
  objectKey: string;
  templateBody: string;
};

export type RenderDocumentRequest = {
  templateKey: string;
  record: Record<string, unknown>;
};

export type RenderedDocument = {
  templateKey: string;
  content: string;
};

// --- Phase 6: WRICEF Framework Skeleton — Conversions (import/export) ----
// No dedicated types beyond this — ImportExportService works generically
// against whatever column/DTO shape a caller hands it (see
// apps/api/src/import-export/import-export.service.ts).

export type CsvImportRowError = {
  row: number;
  message: string;
};

export type CsvImportResult<T> = {
  imported: number;
  rows: T[];
  errors: CsvImportRowError[];
};

// --- Phase 7: Employee Core -------------------------------------------
// The first real HR object — plan doc Section 5 (the Employee Number
// rules) and Section 7's Phase 7 row. `EmployeeView` is what the API
// actually returns: a sensitive field the caller's role can't see is
// OMITTED from the object entirely (see RbacService.filterRecordFields
// and its Phase 7 sibling filterRecordFieldsWithScope), so every
// sensitive field below is typed optional, not nullable — `"cnic" in
// employee` is the real presence check, not `employee.cnic != null`.

export type EmploymentStatus = "active" | "on_leave" | "terminated";

// Phase 8 addition (plan doc Section 12's own canonical example names both
// "location" and "employment type" as attributes a tenant would group
// employees by) — a real employee attribute, not scaffolding invented only
// to make Employee Groups have something to condition on.
export type EmploymentType = "permanent" | "contract" | "probation" | "intern";

export type EmployeeView = {
  id: string;
  companyId: string;
  userAccountId: string | null;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  gender: string | null;
  maritalStatus: string | null;
  department: string | null;
  designation: string | null;
  location: string | null;
  employmentType: EmploymentType;
  managerId: string | null;
  employmentStatus: EmploymentStatus;
  dateOfJoining: string;
  terminationDate: string | null;
  createdAt: string;
  updatedAt: string;
  /** Sensitive — present only when the caller's field-level access resolves to non-"hidden". */
  cnic?: string | null;
  dateOfBirth?: string | null;
  salaryBand?: string | null;
  bankAccountNumber?: string | null;
  terminationReason?: string | null;
};

export type CreateEmployeeRequest = {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  cnic?: string;
  dateOfBirth?: string;
  gender?: string;
  maritalStatus?: string;
  department?: string;
  designation?: string;
  location?: string;
  employmentType?: EmploymentType;
  managerId?: string;
  dateOfJoining?: string;
  salaryBand?: string;
  bankAccountNumber?: string;
  userAccountId?: string;
  /**
   * Set only when preserving a client's pre-existing legacy staff number
   * during migration (plan doc Section 5's "bulk import must support
   * preserving... not only auto-generating fresh ones"). Omitted (the
   * normal case): EmployeesService assigns the next number from the
   * company's own configured format/sequence automatically.
   */
  employeeNumber?: string;
};

export type UpdateEmployeeRequest = Partial<
  Omit<CreateEmployeeRequest, "employeeNumber" | "userAccountId">
> & {
  employmentStatus?: EmploymentStatus;
  terminationDate?: string;
  terminationReason?: string;
};

export type OrgChartNode = {
  id: string;
  employeeNumber: string;
  fullName: string;
  designation: string | null;
  department: string | null;
  directReports: OrgChartNode[];
};

export type EmployeeDocumentView = {
  id: string;
  employeeId: string;
  documentType: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
};

export type JobHistoryEventType = "hire" | "promotion" | "transfer" | "salary_change" | "termination" | "rehire" | "other";

export type JobHistoryEntryView = {
  id: string;
  employeeId: string;
  eventType: JobHistoryEventType;
  effectiveDate: string;
  department: string | null;
  designation: string | null;
  salaryBand?: string | null;
  notes: string | null;
  createdAt: string;
};

export type RecordJobHistoryRequest = {
  eventType: JobHistoryEventType;
  effectiveDate: string;
  department?: string;
  designation?: string;
  salaryBand?: string;
  notes?: string;
};

// --- Phase 8: Employee Groups & Leave Policy Config -------------------
// Plan doc Section 12: a generic per-group policy resolution mechanism
// that reuses Phase 4's own resolver pattern rather than inventing a
// second one — most-specific-match-wins (a group's specificity is simply
// how many conditions it has), additive combination (independent
// resolution per `PolicyType`, combined by the caller), safe-deny default
// (an unmatched employee falls back to the tenant's explicitly-designated
// default policy for that type, never a guess). See
// 0012_employee_groups_leave_policy.sql's header comment for the full
// design writeup and Decision #8 in DECISIONS.md.

/** The fixed, validated set of employee attributes a group can condition
 * on — matches the CHECK constraint on employee_group_conditions.field.
 * Deliberately not "any employee field" (typo-ing a field name here would
 * otherwise silently produce a condition that can never match). */
export type EmployeeGroupConditionField = "department" | "location" | "designation" | "employmentType" | "employmentStatus";

export type EmployeeGroupCondition = {
  field: EmployeeGroupConditionField;
  equals: string;
};

export type EmployeeGroupView = {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  /** ANDed together — a group matches an employee only when EVERY
   * condition matches. Its length is also this group's specificity for
   * most-specific-match-wins resolution. */
  conditions: EmployeeGroupCondition[];
  createdAt: string;
  updatedAt: string;
};

export type CreateEmployeeGroupRequest = {
  name: string;
  description?: string;
  /** At least one condition is required — a group with zero conditions
   * would match every employee, which is what the tenant-level default
   * policy already exists to express explicitly (see LeavePolicyView.isDefault). */
  conditions: EmployeeGroupCondition[];
};

export type UpdateEmployeeGroupRequest = Partial<CreateEmployeeGroupRequest>;

/** Only "leave" exists yet (Phase 8 builds exactly one concrete policy
 * type to prove the mechanism) — more can be added later without any
 * schema change to employee_groups/employee_group_conditions themselves. */
export type PolicyType = "leave";

export type LeavePolicyView = {
  id: string;
  companyId: string;
  name: string;
  annualLeaveDays: number;
  casualLeaveDays: number;
  sickLeaveDays: number;
  /** At most one leave policy per tenant may have this set — the
   * safe-deny fallback target when no employee group matches. */
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CreateLeavePolicyRequest = {
  name: string;
  annualLeaveDays?: number;
  casualLeaveDays?: number;
  sickLeaveDays?: number;
  isDefault?: boolean;
};

export type UpdateLeavePolicyRequest = Partial<CreateLeavePolicyRequest>;

export type EmployeeGroupPolicyAssignmentView = {
  id: string;
  groupId: string;
  policyType: PolicyType;
  policyId: string;
  createdAt: string;
};

export type AssignGroupPolicyRequest = {
  policyType: PolicyType;
  policyId: string;
};

/** The resolver's own return shape — `groupId: null` and `isDefault: true`
 * together mean "no group matched, the tenant's default policy applied";
 * `policyId: null` means genuinely unconfigured (no group matched AND no
 * default exists for this policyType) — safe-deny, not a guess. */
export type ResolvedPolicyView = {
  policyType: PolicyType;
  policyId: string | null;
  groupId: string | null;
  isDefault: boolean;
};

// --- Phase 9: Leave & Attendance ---------------------------------------
// Plan doc Section 7's own words: "the real go/no-go checkpoint." See
// 0015_leave_attendance.sql for the schema and Decision #9 for the
// design writeup (balance seeding from Phase 8's resolver, overlap
// notices, On-Behalf, manager_of_submitter routing, employee_number-keyed
// clock-in).

export type LeaveType = "annual" | "casual" | "sick";

export type LeaveBalanceView = {
  id: string;
  employeeId: string;
  leaveType: LeaveType;
  year: number;
  entitledDays: number;
  usedDays: number;
  remainingDays: number;
};

export type LeaveRequestStatus = "pending" | "approved" | "rejected" | "cancelled";

export type OverlapWarning = {
  employeeId: string;
  employeeFullName: string;
  leaveRequestId: string;
  startDate: string;
  endDate: string;
};

export type LeaveRequestView = {
  id: string;
  companyId: string;
  employeeId: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  daysRequested: number;
  reason: string | null;
  status: LeaveRequestStatus;
  submittedByUserAccountId: string;
  /** True when `submittedByUserAccountId` differs from the employee's own
   * `userAccountId` — an On-Behalf submission (HR/a manager submitting
   * for someone who can't use the app themselves), derived rather than
   * separately stored. */
  isOnBehalf: boolean;
  workflowInstanceId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SubmitLeaveRequestRequest = {
  employeeId: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  reason?: string;
};

export type SubmitLeaveRequestResponse = {
  request: LeaveRequestView;
  /** Non-blocking — plan doc Section 7 calls these "overlap notices," not
   * overlap rejections. Empty when nothing on the same team overlaps. */
  overlapWarnings: OverlapWarning[];
};

export type DecideLeaveRequestRequest = {
  decision: "approved" | "rejected";
  comment?: string;
};

export type AttendanceSource = "biometric" | "gps" | "manual";

export type AttendanceRecordView = {
  id: string;
  employeeId: string;
  employeeNumber: string;
  source: AttendanceSource;
  clockInAt: string;
  clockOutAt: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
};

export type ClockInRequest = {
  employeeNumber: string;
  source: AttendanceSource;
  gpsLat?: number;
  gpsLng?: number;
};

export type ClockOutRequest = {
  employeeNumber: string;
};

// --- Phase 10: Recruitment & Onboarding --------------------------------
// Plan doc Section 7: "Requisition to hire, Kanban pipeline... Employee
// number gets assigned here, at offer acceptance." See
// 0017_recruitment.sql for the schema and Decision #10 for the design
// writeup (requisition approval reusing the Phase 6 workflow engine
// as-is, candidates deliberately having no login/session of their own,
// and offer acceptance as the second real caller of Employee Number
// assignment).

export type RequisitionStatus = "draft" | "pending_approval" | "approved" | "rejected" | "closed";

export type JobRequisitionView = {
  id: string;
  companyId: string;
  title: string;
  department: string | null;
  headcount: number;
  salaryBand: string | null;
  justification: string | null;
  hiringManagerId: string | null;
  status: RequisitionStatus;
  workflowInstanceId: string | null;
  createdByUserAccountId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateJobRequisitionRequest = {
  title: string;
  department?: string;
  /** Defaults to 1 when omitted. */
  headcount?: number;
  salaryBand?: string;
  justification?: string;
  hiringManagerId?: string;
};

export type CandidateView = {
  id: string;
  companyId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  createdAt: string;
};

export type CreateCandidateRequest = {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
};

/** The Kanban board's own column set. Forward-only in this phase — see
 * KNOWN_ISSUES.md — `rejected` is reachable from any non-terminal stage,
 * but there is no "move a candidate backward" path yet. */
export type ApplicationStage = "applied" | "screening" | "interview" | "offer" | "hired" | "rejected";

export type ApplicationView = {
  id: string;
  companyId: string;
  requisitionId: string;
  candidateId: string;
  stage: ApplicationStage;
  createdAt: string;
  updatedAt: string;
};

export type CreateApplicationRequest = {
  requisitionId: string;
  candidateId: string;
};

export type MoveApplicationStageRequest = {
  stage: ApplicationStage;
};

export type OfferStatus = "pending" | "accepted" | "declined" | "rescinded";

export type OfferView = {
  id: string;
  companyId: string;
  applicationId: string;
  salary: number;
  startDate: string;
  status: OfferStatus;
  extendedByUserAccountId: string;
  /** Set once `decideOffer()` records the candidate's decision — an
   * `accepted` offer's `hiredEmployeeId` then points at the real
   * Employee record it created. */
  hiredEmployeeId: string | null;
  decidedAt: string | null;
  createdAt: string;
};

export type ExtendOfferRequest = {
  applicationId: string;
  salary: number;
  startDate: string;
};

export type DecideOfferRequest = {
  decision: "accepted" | "declined";
};

export type DecideOfferResponse = {
  offer: OfferView;
  /** Present only when `decision: "accepted"` — the real Employee
   * record `decideOffer()` created via `EmployeesService.create()`,
   * complete with a freshly assigned Employee Number. */
  employee: EmployeeView | null;
};

// --- Phase 11: Performance & Goals --------------------------------------
// Plan doc Section 7: "Review cycles, calibration." See 0019_performance.sql
// for the schema and Decision #11 for the design writeup (why this phase
// deliberately does NOT route anything through the Phase 6 workflow
// engine, and how the self/manager/calibration visibility rule reuses
// the Phase 4 field-permission engine's conditional-rule mechanism).

export type ReviewCycleStatus = "draft" | "active" | "calibration" | "closed";

export type ReviewCycleView = {
  id: string;
  companyId: string;
  name: string;
  periodStart: string;
  periodEnd: string;
  participantGroupId: string | null;
  status: ReviewCycleStatus;
  createdByUserAccountId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateReviewCycleRequest = {
  name: string;
  periodStart: string;
  periodEnd: string;
  /** Omitted/null means "all active employees" — resolved at launch
   * time, not frozen into a list at creation time. */
  participantGroupId?: string;
};

/** Launching a cycle resolves its participant population (the group's
 * matching employees, or every active employee when none is set) and
 * creates one `performance_reviews` row per participant. */
export type LaunchReviewCycleResponse = {
  cycle: ReviewCycleView;
  participantCount: number;
};

export type GoalStatus = "active" | "completed";

export type GoalView = {
  id: string;
  companyId: string;
  reviewCycleId: string;
  employeeId: string;
  parentGoalId: string | null;
  title: string;
  description: string | null;
  weight: number | null;
  status: GoalStatus;
  createdByUserAccountId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateGoalRequest = {
  reviewCycleId: string;
  employeeId: string;
  parentGoalId?: string;
  title: string;
  description?: string;
  weight?: number;
};

export type UpdateGoalRequest = {
  title?: string;
  description?: string;
  weight?: number;
  status?: GoalStatus;
};

export type PerformanceReviewStatus = "pending" | "in_progress" | "completed" | "calibrated" | "released";

/**
 * The sensitive fields below are `null`/absent for a caller the
 * conditional field-permission rules in 0020_performance_seed.sql don't
 * yet grant visibility into — e.g. an employee_self_service caller sees
 * all five as absent from the raw API response (not merely null) until
 * `status` reaches `"released"`, the same "genuinely absent from
 * `Object.keys()`" contract Phase 4's field-permission engine has always
 * had.
 */
export type PerformanceReviewView = {
  id: string;
  companyId: string;
  reviewCycleId: string;
  employeeId: string;
  status: PerformanceReviewStatus;
  selfAssessment: string | null;
  selfAssessmentSubmittedAt: string | null;
  managerAssessment?: string | null;
  managerRating?: number | null;
  managerAssessmentSubmittedAt: string | null;
  calibrationRating?: number | null;
  calibrationComment?: string | null;
  calibratedAt: string | null;
  finalRating?: number | null;
  releasedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SubmitSelfAssessmentRequest = {
  selfAssessment: string;
};

export type SubmitManagerAssessmentRequest = {
  managerAssessment: string;
  managerRating: number;
};

export type CalibrateReviewRequest = {
  calibrationRating: number;
  calibrationComment?: string;
};

/** Ratings distribution for one cycle (optionally scoped to one
 * employee group) — what an HR Admin actually looks at during
 * calibration before adjusting any individual review. */
export type RatingDistributionView = {
  reviewCycleId: string;
  /** Keyed by manager_rating (1-5, as a string key) -> count of reviews
   * currently at that rating and still awaiting calibration/release. */
  distribution: Record<string, number>;
  totalReviews: number;
  pendingCalibration: number;
};
