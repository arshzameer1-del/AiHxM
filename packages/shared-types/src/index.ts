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
// apps/api/src/workflow/workflow.service.ts. "manager_of_submitter" is
// deliberately not a supported ApproverType yet — it needs the
// employee/manager hierarchy Phase 7 (Employee Core) introduces; see
// KNOWN_ISSUES.md.

export type ApproverType = "role" | "specific_user";

export type WorkflowApproverConfig = {
  approverType: ApproverType;
  roleId?: string;
  userAccountId?: string;
  escalationApproverType?: ApproverType;
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
