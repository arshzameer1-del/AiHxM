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

// "locked"/"archived"/"draft" added for the Tenant Management module
// (TM-030 Tenant Lock, TM-037 Lifecycle). "churned" is kept for existing
// data; new code should prefer "archived".
export type CompanyStatus = "draft" | "trial" | "active" | "suspended" | "locked" | "archived" | "churned";

// --- Employee Number format (plan doc Section 5) -------------------------
export type EmployeeNumberFormat = {
  prefix: string;
  padding: number;
  startingSequence: number;
  preserveImportedNumbers: boolean;
};

// TM-015 — asset presence flags rather than raw storage paths (same
// "never leak the internal reference, only whether it's set" posture
// TenantIntegration.hasSecrets uses). The actual bytes are fetched
// through GET /platform/companies/:id/branding/:slot, an authenticated
// stream — see BrandingAssetSlot.
export type BrandingAssetSlot = "logo" | "favicon" | "login-background";

/** Where the logo sits within its own header strip — see `logoBackgroundColor` below. */
export type LogoAlignment = "left" | "center" | "right";

export type CompanyBranding = {
  primaryColor?: string;
  secondaryColor?: string;
  hasLogo: boolean;
  hasFavicon: boolean;
  hasLoginBackground: boolean;
  /** Defaults to "left" (the layout every company had before this existed). */
  logoAlignment?: LogoAlignment;
  /** Logo's rendered height in px, both here and on the public login page. Defaults to 32 (the previous hardcoded size). */
  logoHeightPx?: number;
  /** Background color of the strip the logo sits in (distinct from `primaryColor`, which colors buttons/links) — undefined/omitted means "match the card" (white), the previous look. */
  logoBackgroundColor?: string;
};

/**
 * What a tenant's OWN login page (leadhcm.aihxm.com/login, not the shared
 * /login every company used to hit) shows before anyone has a session —
 * the public, no-auth counterpart to CompanyBranding above. Deliberately a
 * narrower shape than CompanyBranding: no `hasFavicon` (not consumed by
 * the login page yet) and it carries `companyName`/`slug` since a public
 * visitor has no other way to know which tenant they're looking at.
 */
export type PublicTenantBranding = {
  slug: string;
  companyName: string;
  primaryColor?: string;
  secondaryColor?: string;
  hasLogo: boolean;
  hasLoginBackground: boolean;
  logoAlignment?: LogoAlignment;
  logoHeightPx?: number;
  logoBackgroundColor?: string;
};

/**
 * The platform's OWN logo (migration 0046) — what Layout.tsx's sidebar and
 * the default (non-tenant) login page show instead of a hardcoded mark,
 * and what the small "Powered by AIHXM" credit on a tenant's own
 * subdomain login page renders when present. One row, ever — there is
 * exactly one platform. `GET /public/platform-branding` (no auth) returns
 * this same shape for the public, pre-auth read.
 */
export type PlatformBranding = {
  hasLogo: boolean;
  updatedAt: string;
};

export type Company = {
  id: string;
  name: string;
  slug: string;
  status: CompanyStatus;
  packageTier: PackageTier;
  createdAt: string;
  updatedAt: string;
  // Tenant Management additions (migration 0042) — all nullable/defaulted
  // so every pre-existing company row reads back cleanly.
  legalName: string | null;
  companyCode: string | null;
  registrationNumber: string | null;
  industry: string | null;
  country: string;
  timezone: string;
  currency: string;
  fiscalYearStartMonth: number;
  customDomain: string | null;
  seatsPurchased: number;
  storageQuotaMb: number;
  statusReason: string | null;
  statusChangedAt: string | null;
  deletionRequestedAt: string | null;
  deletionReason: string | null;
  deletionPurgeAt: string | null;
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
  /** Null until a login exists (hasLogin). Used to target Force Logout (TM-017). */
  userAccountId: string | null;
  /**
   * Platform Admin-chosen identifier (e.g. "LHM_Admin1"), set once when
   * this admin's login is created — see CreateLoginRequest.loginId. Null
   * for admins with no login yet, and for admins whose login predates
   * this field (they still sign in via email on the shared /login page).
   * The SAME value is what that admin types into the identifier field on
   * their company's own /:companySlug/login (AuthService matches it
   * alongside employees.employee_number there).
   */
  loginId: string | null;
};

/** TM-002/TM-003 — Tenant Directory search + filters (GET /platform/companies). */
export type CompanyListFilters = {
  search?: string;
  status?: CompanyStatus[];
  packageTier?: PackageTier[];
  country?: string[];
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
  // TM-006/007/008 — the Create Tenant wizard's Company/Business/Domain
  // steps. All optional so `CreateCompanyRequest` stays backward
  // compatible with every existing caller (SignupService's own request
  // shape, tests) that only ever set name/slug/packageTier.
  legalName?: string;
  companyCode?: string;
  registrationNumber?: string;
  industry?: string;
  country?: string;
  timezone?: string;
  currency?: string;
  fiscalYearStartMonth?: number;
  customDomain?: string;
  seatsPurchased?: number;
};

// TM-008 — Domain step's "Check Availability" action.
export type DomainAvailabilityResult = {
  slug: string;
  slugAvailable: boolean;
  customDomain: string | null;
  customDomainAvailable: boolean | null;
};

// TM-010 — Plan selection step. No fabricated pricing: this platform has
// no billing/pricing table yet (see CompanyDashboardRow's mockMrrFor
// comment for the one place a placeholder number is used, and why), so
// this reflects only what's real — the tier's name/description and the
// modules it actually includes by default.
export type PackageTierSummary = {
  key: PackageTier;
  name: string;
  description: string | null;
  includedModuleKeys: ModuleKey[];
};

// TM-009 — "Send Test Invitation": a real email through MailerService
// with no persisted tenant/admin record (there is no tenant yet at this
// point in the wizard). `sent: false` with a reason mirrors
// NotificationsService's own honest "logged, not delivered" behavior
// when SMTP isn't configured, rather than pretending success.
export type TestInvitationResult = {
  sent: boolean;
  reason?: string;
};

/**
 * The public, unauthenticated counterpart of `CreateCompanyRequest` —
 * a prospective customer creating their OWN company and first login,
 * with no Platform Admin in the loop at all. See
 * `apps/api/src/signup/signup.service.ts` for what this actually
 * provisions in one transaction (company, config, entitlements, the
 * admin's login, AND their `hr_admin` role — unlike the Platform-Admin
 * flow, there's no separate human to grant that role afterward).
 */
export type SignupRequest = {
  companyName: string;
  slug?: string;
  packageTier?: PackageTier;
  adminFullName: string;
  adminEmail: string;
  adminPassword: string;
};

export type SignupResponse = {
  companyId: string;
  slug: string;
  packageTier: PackageTier;
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

// --- Tenant Management: Sessions (TM-017/029) ----------------------------
// A row in `user_sessions` — see auth/session-security.service.ts for how
// this is actually enforced (jti-based revocation checked in
// PlatformAdminGuard/SessionGuard), not merely stored.
export type UserSessionView = {
  id: string;
  userAccountId: string;
  companyId: string | null;
  isPlatformAdmin: boolean;
  email: string | null;
  displayName: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

// --- Tenant Management: Saved Views (TM-003) ------------------------------
// A named, reusable Tenant Directory filter combination. Platform-wide
// (not per-admin) — `createdBy` is attribution only, matching the spec's
// "Save as reusable view" note with no per-user scoping requirement.
export type PlatformSavedView = {
  id: string;
  name: string;
  filters: CompanyListFilters;
  createdBy: string;
  createdAt: string;
};

// --- Tenant Management: Configuration (TM-018/019/020) --------------------
// A generic Platform-Admin-facing settings store with real inheritance —
// distinct from configuration-center's `ConfigurationDomainSummary`, which
// is a tenant-facing INDEX of existing per-module screens (leave policy,
// shifts, ...). This is a new key/value override system: `defaultValue`
// is the product default; `overrideValue` is this tenant's row in
// `tenant_configuration` if one exists; `effectiveValue` is what actually
// applies (override, falling back to default) — the "effective value"
// column the spec calls for.
export type TenantConfigurationCategory =
  | "general"
  | "organization"
  | "attendance"
  | "leave"
  | "payroll"
  | "security";

export type TenantConfigurationValueType = "boolean" | "integer" | "text";

export type TenantConfigurationSetting = {
  category: TenantConfigurationCategory;
  settingKey: string;
  label: string;
  description: string | null;
  valueType: TenantConfigurationValueType;
  defaultValue: unknown;
  overrideValue: unknown | null;
  effectiveValue: unknown;
  isOverridden: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type TenantConfigurationVersion = {
  id: string;
  companyId: string;
  category: string;
  settingKey: string;
  oldValue: unknown;
  newValue: unknown;
  changedBy: string;
  changedAt: string;
};

// --- Tenant Management: Modules & Feature Entitlements (TM-021–024) -------
export type ModuleCatalogEntry = {
  key: string;
  label: string;
  category: string | null;
  dependsOn: string | null;
  enabled: boolean;
};

export type TenantFeatureEntitlement = {
  featureKey: string;
  moduleKey: string;
  name: string;
  description: string | null;
  defaultLimit: number | null;
  enabled: boolean;
  usageLimit: number | null;
  effectiveLimit: number | null;
};

// --- Tenant Management: Subscription (TM-025/026) --------------------------
export type SubscriptionHistoryEntry = {
  id: string;
  fromTier: string | null;
  toTier: string;
  seatsPurchased: number | null;
  changedBy: string;
  changedAt: string;
};

export type SubscriptionSummary = {
  companyId: string;
  packageTier: PackageTier;
  seatsPurchased: number;
  seatsUsed: number;
  seatsAvailable: number;
  history: SubscriptionHistoryEntry[];
};

// --- Tenant Management: Usage & Storage (TM-027/028) -----------------------
export type TenantDailyUsagePoint = {
  date: string;
  apiRequestCount: number;
  emailSentCount: number;
};

export type TenantUsageSummary = {
  companyId: string;
  employeeCount: number;
  userCount: number;
  storageUsedMb: number;
  storageQuotaMb: number;
  apiRequestsLast30Days: number;
  emailsSentLast30Days: number;
  dailyUsage: TenantDailyUsagePoint[];
};

// --- Tenant Management: Integrations (TM-031) ------------------------------
export type IntegrationProviderKey = "smtp" | "sso" | "biometric_device" | "webhook";

export type TenantIntegration = {
  companyId: string;
  providerKey: IntegrationProviderKey;
  enabled: boolean;
  // Secrets in `config` are never returned by GET — see tenant-integrations
  // service. Reflects only non-secret fields plus a `hasSecrets` flag.
  config: Record<string, unknown>;
  hasSecrets: boolean;
  updatedAt: string;
  updatedBy: string;
};

// --- Tenant Management: Health (TM-032) ------------------------------------
export type HealthCheckStatus = "ok" | "degraded" | "down";

export type HealthCheckResult = {
  checkKey: string;
  status: HealthCheckStatus;
  detail: string | null;
  checkedAt: string;
};

// --- Tenant Management: Support Tickets (TM-033) ---------------------------
export type SupportTicketPriority = "low" | "normal" | "high" | "urgent";
export type SupportTicketStatus = "open" | "in_progress" | "resolved" | "closed";

export type SupportTicket = {
  id: string;
  companyId: string;
  subject: string;
  description: string;
  priority: SupportTicketPriority;
  status: SupportTicketStatus;
  createdBy: string;
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
};

// --- Tenant Management: Backups (TM-035) -----------------------------------
export type TenantBackup = {
  id: string;
  companyId: string;
  status: "queued" | "running" | "completed" | "failed";
  sizeBytes: number | null;
  fileKey: string | null;
  requestedBy: string;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
};

// --- Tenant Management: Data Export (TM-036) --------------------------------
export type DataExportScope = "full" | "employees" | "payroll" | "attendance";
export type DataExportFormat = "json" | "csv";

export type TenantDataExport = {
  id: string;
  companyId: string;
  scope: DataExportScope;
  format: DataExportFormat;
  status: "queued" | "running" | "completed" | "failed";
  sizeBytes: number | null;
  fileKey: string | null;
  requestedBy: string;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  error: string | null;
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
 * A tenant's own login page (aihxm.com/<slug>/login) authenticates by a
 * typed identifier, not email — the company is already known from the
 * path, and both identifier namespaces below are only unique WITHIN a
 * company (`employees.employee_number`: migration 0010's `UNIQUE
 * (company_id, employee_number)`; `company_admins.login_id`: migration
 * 0048's case-insensitive unique index), which is exactly why
 * `companySlug` has to travel alongside it here. `employeeNumber` is kept
 * as the field name for API/DTO stability, but the backend
 * (AuthService.findAccountByEmployeeNumber) matches it against EITHER an
 * Employee Core row's employee_number OR a Company (Super) Admin's own
 * login_id — the same field on the login page works for both, since a
 * Company Admin has no Employee Core record to have an employee number
 * in the first place. Password reset still goes through email regardless
 * of how someone logs in — see PasswordResetRequestBody — this only
 * changes the login identifier.
 */
export type LoginWithEmployeeNumberRequest = {
  companySlug: string;
  employeeNumber: string;
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

/**
 * `GET /auth/me` — Decision #13. What a logged-in session actually is, for
 * the frontend's own purposes: which portal shell to render (Platform
 * Admin vs. a tenant's HR Admin/Manager/Employee screens) and which nav
 * sections to show. This is describing the session, not a new
 * authorization mechanism — every real read/write still goes through
 * EntitlementsService/RbacService server-side exactly as before; a client
 * that lies about what it does with this response gets 403s and 404s same
 * as always. `roleKeys` is independent of which of AuthService's three
 * login tiers actually resolved the session (see its SessionIdentity doc
 * comment) — it's always a direct read of this user's own
 * `user_role_assignments` rows in this company, which is why a Company
 * (Super) Admin who hasn't yet been granted a tenant role via
 * `POST /platform/role-assignments` correctly gets `roleKeys: []` here
 * (Decision #12's "what this unblocks").
 */
export type MeResponse = {
  isPlatformAdmin: boolean;
  companyId: string | null;
  companyName: string | null;
  /** The company's slug (companies.slug) — null for Platform Admin. Lets the
   * authenticated portal shell fetch this tenant's own uploaded branding
   * (logo/colors) from the same public, no-auth /public/tenants/:slug/branding
   * endpoint the tenant login page already uses, instead of hardcoding the
   * plain "AI HXM" wordmark once a session exists. */
  companySlug: string | null;
  email: string;
  fullName: string;
  roleKeys: TenantRoleKey[];
  /** The `employees` row linked to this login, if any — null for Platform Admin and for a Company Admin with no Employee record. */
  employeeId: string | null;
  enabledModules: ModuleKey[];
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
  /**
   * Only meaningful for a Company (Super) Admin's login
   * (CompaniesService.createAdminLogin) — a Company Admin has no Employee
   * Core record, so without this they have no identifier for their own
   * company's own /:companySlug/login page at all. Optional: omit it and
   * the admin can still sign in via email on the shared /login page, just
   * not through their company's own tenant-path login.
   */
  loginId?: string;
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

/**
 * The four real tenant RBAC roles (0011_employee_seed.sql,
 * 0024_system_admin.sql) — deliberately excludes the `rbac_demo_*`
 * proof-of-concept roles from Phase 4, which `EmployeesService.createLogin()`
 * refuses to grant (see Decision #12). `system_admin` (Decision #20) was
 * added additively alongside the original three, not in place of any of
 * them.
 */
export type TenantRoleKey = "hr_admin" | "line_manager" | "employee_self_service" | "system_admin";

/**
 * Decision #12: before this, there was no way for an Employee record to
 * get an actual login — `AuthService`'s real `/auth/login` flow only ever
 * recognized Platform Admin and Company (Super) Admin identities, and a
 * Company Admin's own login carried no `user_role_assignments` row at
 * all, so it held zero permissions against any Phase 4+ module. This is
 * the tenant-scoped, HR-Admin-self-service counterpart to the
 * Platform-Admin-only `POST /platform/role-assignments` endpoint —
 * `EmployeesService.createLogin()` creates the `user_accounts` row AND
 * grants role(s) in one call, gated by `employee.manage.all` so an HR
 * Admin never needs a Platform Admin or a database console to onboard
 * their own tenant's users.
 */
export type CreateEmployeeLoginRequest = {
  initialPassword: string;
  roleKeys: TenantRoleKey[];
};

export type CreateEmployeeLoginResponse = {
  employee: EmployeeView;
  rolesGranted: TenantRoleKey[];
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
  /** This group's current policy assignments (Task #49's Admin Center UI
   * needs to show "what's assigned right now" without an extra call per
   * group per policyType) — populated the same way `conditions` is, a
   * second batch query alongside the group list, not N+1. */
  policyAssignments: EmployeeGroupPolicyAssignmentView[];
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

// annualLeaveDays/casualLeaveDays/sickLeaveDays live on this view for API
// stability, but as of 0033_effective_dating_leave_tax.sql they're sourced
// from this policy's CURRENT leave_policy_versions row, not a column on
// leave_policies itself (see LeavePolicyVersionView below) — the id/name/
// isDefault fields are this policy's stable identity and never version.
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
  /** The CURRENT version's effective_from — when today's entitlement figures took effect. */
  effectiveFrom: string;
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

/** One historical (or current) entitlement version of a leave policy —
 * `GET /leave-policies/:id/history`, ordered oldest first. */
export type LeavePolicyVersionView = {
  id: string;
  policyId: string;
  annualLeaveDays: number;
  casualLeaveDays: number;
  sickLeaveDays: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
};

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

/**
 * `unpaid` was added in Phase 12 (see Decision #14 and
 * 0021_leave_unpaid_type.sql) specifically so `PayrollService` has real
 * leave data to compute an unpaid-leave deduction against — it carries no
 * entitlement/balance of its own (`LeaveRequestsService` skips policy
 * resolution and balance checking entirely for it), unlike the other
 * three types.
 */
export type LeaveType = "annual" | "casual" | "sick" | "unpaid";

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

// Computed at read time by AttendanceService, joining the employee's
// shift assignment as of the punch's own date — never stored on
// attendance_records itself. "no_shift_assigned" is deliberately not an
// error: most SMB pilots won't configure Shift Management on day one, and
// attendance recording must keep working with no shift resolved at all.
// "rest_day"/"holiday" added 2026-09-18 by the Work Schedule Resolution
// Service (see below) — before that, a day the weekly pattern marked off
// (or a mandatory holiday) was evaluated against the shift's flat
// start/end time like any other day, which could mis-flag a scheduled
// day off as "late." Adding union members is additive/non-breaking for
// any existing caller matching on the other four values.
export type AttendanceStatus = "on_time" | "late" | "early_departure" | "no_shift_assigned" | "rest_day" | "holiday";

export type AttendanceRecordView = {
  id: string;
  employeeId: string;
  employeeNumber: string;
  source: AttendanceSource;
  clockInAt: string;
  clockOutAt: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  status: AttendanceStatus;
  shiftName: string | null;
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

// --- Shift Management (0026_shift_management.sql) ----------------------
// See claude/aihxm-master-audit-and-roadmap.md Part 3 for why this exists:
// Attendance previously had no concept of a "supposed to start at" time,
// so there was no way to tell on-time from late. Deliberately scoped to
// definitions + effective-dated assignments + late/early detection —
// rotations, swaps, and shift premiums are explicitly out of scope for
// this increment (see the migration's own header comment).

export type ShiftView = {
  id: string;
  name: string;
  startTime: string; // "HH:MM" or "HH:MM:SS", local wall-clock time-of-day
  endTime: string;
  crossesMidnight: boolean;
  graceMinutesLate: number;
  graceMinutesEarly: number;
  isDefault: boolean;
  // Added 2026-09-18 by the Work Schedule architecture — see the section
  // below. Default server-side to 'fixed'/'Asia/Karachi' so every
  // pre-existing caller (frontend form, tests) keeps working unchanged.
  scheduleType: ScheduleType;
  timezone: string;
};

export type CreateShiftRequest = {
  name: string;
  startTime: string;
  endTime: string;
  crossesMidnight?: boolean;
  graceMinutesLate?: number;
  graceMinutesEarly?: number;
  isDefault?: boolean;
  scheduleType?: ScheduleType;
  timezone?: string;
};

export type UpdateShiftRequest = Partial<CreateShiftRequest>;

export type ShiftAssignmentView = {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  shiftId: string;
  shiftName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type AssignShiftRequest = {
  employeeId: string;
  shiftId: string;
  effectiveFrom: string;
  effectiveTo?: string;
};

// --- Work Schedule & Employee Schedule Assignment Architecture ---------
// See claude/aihxm-work-schedule-architecture.md (mandatory standard,
// pasted 2026-09-18) and claude/aihxm-master-audit-and-roadmap.md Part 4's
// reconciliation entry. This EXTENDS Shift Management above rather than
// replacing it: `ShiftView` is now also the Work Schedule "definition"
// object (gains `scheduleType`/`timezone`); what's new is its weekly
// pattern + breaks (previously every day implicitly shared one start/end
// time), configurable assignment RULES (Rules-Engine-backed, so an
// employee can receive a schedule via "Department = X AND Group = Y"
// rather than only a direct per-employee assignment), and the resolution
// surface (`ResolvedWorkScheduleView`) Attendance/Leave now consume
// instead of each computing their own notion of "working day."

export type ScheduleType = "fixed" | "flexible" | "shift" | "rotating" | "individual";

export type WorkScheduleBreakView = {
  id: string;
  startTime: string;
  endTime: string;
  isPaid: boolean;
};

export type WorkScheduleDayView = {
  dayOfWeek: number; // 0 = Sunday .. 6 = Saturday (Postgres EXTRACT(DOW)/JS Date#getUTCDay() convention)
  isWorking: boolean;
  startTime: string | null;
  endTime: string | null;
  isFlexible: boolean;
  flexibleStartTime: string | null;
  flexibleEndTime: string | null;
  coreStartTime: string | null;
  coreEndTime: string | null;
  isHalfDay: boolean;
  breaks: WorkScheduleBreakView[];
};

export type SetWeeklyPatternRequest = {
  days: Array<{
    dayOfWeek: number;
    isWorking: boolean;
    startTime?: string;
    endTime?: string;
    isFlexible?: boolean;
    flexibleStartTime?: string;
    flexibleEndTime?: string;
    coreStartTime?: string;
    coreEndTime?: string;
    isHalfDay?: boolean;
    breaks?: Array<{ startTime: string; endTime: string; isPaid?: boolean }>;
  }>;
};

// A deliberately narrow mirror of the RulesEngine's own expression
// grammar (apps/api/src/rules-engine/rules-engine.engine.ts) for exactly
// this one consumer — the Rules Engine itself is explicitly not yet a
// rule-authoring system with a shared, cross-domain expression type (see
// its own doc comment: "no field registry" until a second consumer
// defines what shape it needs). This is that second consumer's own
// narrow shape, not a premature shared registry.
export type WorkScheduleRuleOperator =
  | "equals"
  | "notEquals"
  | "in"
  | "notIn"
  | "greaterThan"
  | "greaterThanOrEqual"
  | "lessThan"
  | "lessThanOrEqual"
  | "between"
  | "contains"
  | "isEmpty"
  | "isNotEmpty";

export type WorkScheduleRuleCondition = { field: string; operator: WorkScheduleRuleOperator; value?: unknown };

export type WorkScheduleRuleExpression =
  | { all: WorkScheduleRuleExpression[] }
  | { any: WorkScheduleRuleExpression[] }
  | { not: WorkScheduleRuleExpression }
  | WorkScheduleRuleCondition;

export type WorkScheduleAssignmentRuleView = {
  id: string;
  name: string;
  priority: number;
  conditionExpression: WorkScheduleRuleExpression;
  scheduleId: string;
  scheduleName: string;
  isActive: boolean;
};

export type CreateWorkScheduleAssignmentRuleRequest = {
  name: string;
  priority?: number;
  conditionExpression: WorkScheduleRuleExpression;
  scheduleId: string;
  isActive?: boolean;
};

export type UpdateWorkScheduleAssignmentRuleRequest = Partial<CreateWorkScheduleAssignmentRuleRequest>;

export type WorkScheduleAssignmentSource = "individual" | "temporary" | "rule" | "default";

/** The single resolved-schedule shape Attendance/Leave (and, per the
 * architecture doc's Section 36, a future `GET /employees/:id/work-schedule`
 * caller) all consume — see WorkScheduleResolutionService. */
export type ResolvedWorkScheduleView = {
  date: string;
  hasSchedule: boolean;
  scheduleId: string | null;
  scheduleName: string | null;
  scheduleType: ScheduleType | null;
  timezone: string | null;
  assignmentSource: WorkScheduleAssignmentSource | null;
  assignmentRuleName: string | null;
  isWorking: boolean;
  isHalfDay: boolean;
  startTime: string | null;
  endTime: string | null;
  crossesMidnight: boolean;
  isFlexible: boolean;
  flexibleStartTime: string | null;
  flexibleEndTime: string | null;
  coreStartTime: string | null;
  coreEndTime: string | null;
  breaks: WorkScheduleBreakView[];
  graceMinutesLate: number;
  graceMinutesEarly: number;
  isHoliday: boolean;
  isMandatoryHoliday: boolean;
  holidayName: string | null;
};

// --- Attendance Policies increment 1: correction requests --------------
// See 0028_attendance_corrections.sql — one decision (approve/reject),
// made by the requester's own manager or HR, not routed through the
// generic Workflow Engine.
export type AttendanceCorrectionStatus = "pending" | "approved" | "rejected";

export type AttendanceCorrectionRequestView = {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  attendanceRecordId: string | null;
  requestedDate: string;
  requestedClockIn: string | null;
  requestedClockOut: string | null;
  reason: string;
  status: AttendanceCorrectionStatus;
  isOnBehalf: boolean;
  decisionComment: string | null;
  decidedAt: string | null;
  createdAt: string;
};

export type SubmitAttendanceCorrectionRequest = {
  employeeId: string;
  requestedDate: string;
  requestedClockIn?: string;
  requestedClockOut?: string;
  reason: string;
  attendanceRecordId?: string;
};

export type DecideAttendanceCorrectionRequest = {
  decision: "approved" | "rejected";
  comment?: string;
};

// --- Holiday Management (0030_holiday_management.sql) -------------------
// The calendar foundation Attendance Corrections' own header comment
// deferred ("absence reporting needs a working-days/holiday calendar
// first"). This increment is the calendar itself only — it does not yet
// feed leave day-count calculation or attendance absence detection.
export type HolidayView = {
  id: string;
  name: string;
  holidayDate: string;
  isOptional: boolean;
};

export type CreateHolidayRequest = {
  name: string;
  holidayDate: string;
  isOptional?: boolean;
};

export type UpdateHolidayRequest = Partial<CreateHolidayRequest>;

// --- Configuration Center (0032_configuration_center.sql) --------------
// A read-only, permission-filtered index over the configuration domains
// that already have their own real admin screen (leave policies, employee
// groups, shifts, holidays, workflow templates, custom fields, tax slabs)
// -- this does not introduce a new place configuration lives, it makes
// the six-plus existing places discoverable from one screen. `count` is
// omitted (not zero) for a domain the caller has no view/manage access to
// -- ConfigurationCenterService filters those out server-side rather than
// returning a card the caller can't act on.
export type ConfigurationDomainSummary = {
  domainKey: string;
  label: string;
  description: string;
  adminRoute: string;
  supportsEffectiveDating: boolean;
  count: number;
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

// -----------------------------------------------------------------------
// Decision #20 (Task #52) — System Admin: the tenant-scoped counterpart to
// Platform Admin's `/platform/role-assignments`/`/platform/roles`
// (0004_rbac.sql, apps/api/src/rbac/). Reuses `UserRoleAssignment`/`Role`
// above for the underlying data shape; these types are specific to the
// system-admin module's own read model (an assignment joined with the
// employee it belongs to, for display) and request shape (keyed by
// employeeId rather than a bare userAccountId, since a System Admin picks
// "which employee" from a list, not a raw account id).
// -----------------------------------------------------------------------

/**
 * One row in the "who can I grant a login or a role to" picker
 * (`GET /system-admin/assignable-users`) — deliberately NOT `EmployeeView`:
 * a System Admin has no `employee.view.*` permission of their own (see
 * 0024_system_admin.sql's role description) and doesn't need one just to
 * see who exists and what access they already hold.
 */
export type AssignableUserView = {
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  email: string | null;
  userAccountId: string | null;
  hasLogin: boolean;
  roleKeys: TenantRoleKey[];
};

export type SystemAdminRoleAssignmentView = {
  id: string;
  userAccountId: string;
  employeeId: string | null;
  employeeName: string | null;
  email: string | null;
  roleKey: TenantRoleKey;
  roleName: string;
  createdAt: string;
};

export type AssignSystemAdminRoleRequest = {
  employeeId: string;
  roleKey: TenantRoleKey;
};

// -----------------------------------------------------------------------
// Phase 12 — Compensation & Payroll (Decision #14). Plan doc Section 10's
// guardrail applies to every type below exactly as it does to the schema
// and the service: passing this phase's own tests is not the same thing
// as being safe to run with real money — see Decision #14 and
// KNOWN_ISSUES.md for exactly which figures still need direct accountant/
// EOBI/PESSI/SESSI confirmation.
// -----------------------------------------------------------------------

export type CompensationView = {
  id: string;
  companyId: string;
  employeeId: string;
  monthlySalary: number;
  effectiveFrom: string;
  /** null = this is the employee's current rate. */
  effectiveTo: string | null;
  createdByUserAccountId: string;
  createdAt: string;
};

export type SetCompensationRequest = {
  employeeId: string;
  monthlySalary: number;
  effectiveFrom: string;
};

export type SocialSecurityScheme = "none" | "pessi" | "sessi";

/**
 * One row per tenant. Every rate/base here is tenant-editable DATA, not a
 * hardcoded constant — Decision #14's response to real, documented
 * uncertainty in the current EOBI wage base and PESSI/SESSI wage
 * ceilings (see `claude/statutory-payroll-rates-pakistan.md`). Lazily
 * seeded with researched-but-unconfirmed defaults the first time a
 * tenant has none, the same pattern Phase 9 used for leave balances.
 */
export type PayrollSettingsView = {
  companyId: string;
  eobiEmployeeRatePercent: number;
  eobiEmployerRatePercent: number;
  eobiWageBase: number;
  socialSecurityScheme: SocialSecurityScheme;
  socialSecurityEmployerRatePercent: number;
  socialSecurityWageCeiling: number | null;
  updatedAt: string;
};

export type UpdatePayrollSettingsRequest = {
  eobiEmployeeRatePercent?: number;
  eobiEmployerRatePercent?: number;
  eobiWageBase?: number;
  socialSecurityScheme?: SocialSecurityScheme;
  socialSecurityEmployerRatePercent?: number;
  socialSecurityWageCeiling?: number | null;
};

// effectiveFrom/effectiveTo (0033_effective_dating_leave_tax.sql): every
// bracket row is part of exactly one dated SET — listTaxSlabs()/
// setTaxSlabs() only ever return/replace the CURRENT set
// (effectiveTo: null); a closed set only appears via the history endpoint.
export type TaxSlabView = {
  id: string;
  companyId: string;
  minAnnualIncome: number;
  /** null = the top, uncapped bracket. */
  maxAnnualIncome: number | null;
  baseTax: number;
  ratePercent: number;
  effectiveFrom: string;
  effectiveTo: string | null;
};

/** One historical (or current) tax slab SET — `GET /payroll/tax-slabs/history`,
 * ordered oldest first. All slabs in one entry share the same effectiveFrom/effectiveTo. */
export type TaxSlabSetView = {
  effectiveFrom: string;
  effectiveTo: string | null;
  slabs: TaxSlabView[];
};

/** Replaces the tenant's entire tax slab table in one call — a partial
 * edit to a progressive bracket table (e.g. deleting one row) can leave
 * income gaps or overlaps that are much harder to validate piecemeal. */
export type SetTaxSlabsRequest = {
  slabs: Array<{
    minAnnualIncome: number;
    maxAnnualIncome: number | null;
    baseTax: number;
    ratePercent: number;
  }>;
};

export type PayrollRunStatus = "draft" | "calculated" | "finalized";

export type PayrollRunView = {
  id: string;
  companyId: string;
  periodStart: string;
  periodEnd: string;
  status: PayrollRunStatus;
  createdByUserAccountId: string;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreatePayrollRunRequest = {
  periodStart: string;
  periodEnd: string;
};

/** One ordered entry in a payslip's `calculationBreakdown` — the direct
 * answer to this phase's own exit criterion's "every intermediate figure
 * inspectable" requirement. */
export type PayrollCalculationStep = {
  label: string;
  value: number | string;
};

export type PayslipView = {
  id: string;
  companyId: string;
  payrollRunId: string;
  employeeId: string;
  /** Denormalized snapshot at calculation time — see 0022_payroll.sql's
   * header comment for why these don't just join to `employees` live. */
  employeeNumber: string;
  bankAccountNumber: string | null;
  daysInPeriod: number;
  paidDays: number;
  unpaidLeaveDays: number;
  grossPay: number;
  taxableAnnualIncome: number;
  incomeTaxMonthly: number;
  eobiEmployeeContribution: number;
  eobiEmployerContribution: number;
  socialSecurityEmployerContribution: number;
  netPay: number;
  calculationBreakdown: PayrollCalculationStep[];
  createdAt: string;
  updatedAt: string;
};

/** One per-employee failure from `calculateRun()` — collected rather
 * than thrown on the first bad row, the same "real error report, never
 * silent partial failure" discipline `ImportExportService.parseAndValidate()`
 * established for Conversions. */
export type PayrollCalculationError = {
  employeeId: string;
  message: string;
};

export type CalculatePayrollRunResponse = {
  run: PayrollRunView;
  payslipCount: number;
  errors: PayrollCalculationError[];
};

// --- Onboarding & Offboarding (0035_onboarding_offboarding.sql) --------
// Part 2's gap matrix row #21 ("Onboarding & Offboarding") flagged High —
// "real customer-facing gap". Onboarding is gated on the existing
// `recruitment` module_catalog entry (its own seeded name is literally
// "Recruitment & Onboarding" — see 0006_module_entitlement.sql), and
// Offboarding is gated on the existing `exit` module_catalog entry
// ("Exit & Offboarding") — both were pure placeholder rows with zero
// backend behind them since Phase 5; this increment is their first real
// implementation, not a new sellable module.
//
// Both sides share one checklist shape: a company configures a list of
// item TEMPLATES (title/category/who's responsible), and each real
// onboarding/offboarding instance clones the currently-active templates
// into its own item rows at creation time — so editing the template list
// later never rewrites history for an in-flight checklist. `responsibleRole`
// reuses the exact self/team/all RBAC scope vocabulary every other module
// in this codebase already uses, rather than inventing a parallel one:
// "self" = the employee completes it themselves, "team" = their manager,
// "all" = HR. Deliberately NOT routed through the Workflow Engine for a
// multi-step approval chain (unlike Leave/Recruitment) — same reasoning
// Attendance Corrections used for its own single-decider action: a
// checklist item has exactly one responsible party, not a chain of
// approvers. A real Workflow-Engine-routed clearance chain (e.g. IT then
// Finance then HR sign-off before an offboarding can finalize) is a
// deliberate, named follow-on for if/when real demand asks for it.

export type ChecklistCategory = "it" | "hr" | "finance" | "facilities" | "general";
export type ChecklistResponsibleRole = "self" | "team" | "all";
export type ChecklistItemStatus = "pending" | "completed" | "skipped";

export type OnboardingItemTemplateView = {
  id: string;
  title: string;
  category: ChecklistCategory;
  responsibleRole: ChecklistResponsibleRole;
  sortOrder: number;
  isActive: boolean;
};

export type CreateOnboardingItemTemplateRequest = {
  title: string;
  category: ChecklistCategory;
  responsibleRole: ChecklistResponsibleRole;
  sortOrder?: number;
};

export type UpdateOnboardingItemTemplateRequest = Partial<CreateOnboardingItemTemplateRequest> & {
  isActive?: boolean;
};

export type OnboardingChecklistItemView = {
  id: string;
  templateItemId: string | null;
  title: string;
  category: ChecklistCategory;
  responsibleRole: ChecklistResponsibleRole;
  sortOrder: number;
  status: ChecklistItemStatus;
  notes: string | null;
  completedAt: string | null;
};

export type EmployeeOnboardingView = {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  status: "in_progress" | "completed";
  startedAt: string;
  completedAt: string | null;
  items: OnboardingChecklistItemView[];
};

export type UpdateChecklistItemRequest = {
  status: ChecklistItemStatus;
  notes?: string;
};

export type OffboardingReason = "resignation" | "termination" | "retirement" | "end_of_contract" | "other";

export type OffboardingItemTemplateView = {
  id: string;
  title: string;
  category: ChecklistCategory;
  responsibleRole: ChecklistResponsibleRole;
  sortOrder: number;
  isActive: boolean;
};

export type CreateOffboardingItemTemplateRequest = {
  title: string;
  category: ChecklistCategory;
  responsibleRole: ChecklistResponsibleRole;
  sortOrder?: number;
};

export type UpdateOffboardingItemTemplateRequest = Partial<CreateOffboardingItemTemplateRequest> & {
  isActive?: boolean;
};

export type OffboardingChecklistItemView = {
  id: string;
  templateItemId: string | null;
  title: string;
  category: ChecklistCategory;
  responsibleRole: ChecklistResponsibleRole;
  sortOrder: number;
  status: ChecklistItemStatus;
  notes: string | null;
  completedAt: string | null;
};

export type EmployeeOffboardingView = {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  reason: OffboardingReason;
  lastWorkingDay: string;
  notes: string | null;
  status: "in_progress" | "completed";
  startedAt: string;
  completedAt: string | null;
  items: OffboardingChecklistItemView[];
};

export type InitiateOffboardingRequest = {
  reason: OffboardingReason;
  lastWorkingDay: string;
  notes?: string;
};

// --- Overtime & On-Duty, first increment (2026-09-18) -------------------
// See 0038_overtime.sql. A per-company OvertimePolicyView is effective-
// dated via the shared EffectiveDatingEngine (single open row, same shape
// as TaxSlabView); an OvertimeRecordView snapshots its scheduled/actual/
// overtime minutes and the rate that applied at submission time, so a
// later policy or schedule change never rewrites an already-decided
// claim's meaning. Decided via the same plain RBAC self/team/all shape
// AttendanceCorrectionRequestView already uses, not the Workflow Engine.

export type OvertimeDayType = "weekday" | "rest_day" | "holiday";

export type OvertimeClaimStatus = "pending" | "approved" | "rejected";

export type OvertimePolicyView = {
  id: string;
  companyId: string;
  dailyThresholdMinutes: number;
  roundingMinutes: number;
  weekdayRateMultiplier: number;
  restDayRateMultiplier: number;
  holidayRateMultiplier: number;
  effectiveFrom: string;
};

export type SetOvertimePolicyRequest = {
  dailyThresholdMinutes?: number;
  roundingMinutes?: number;
  weekdayRateMultiplier?: number;
  restDayRateMultiplier?: number;
  holidayRateMultiplier?: number;
};

export type OvertimeRecordView = {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  attendanceRecordId: string | null;
  workDate: string;
  scheduledMinutes: number;
  actualMinutes: number;
  overtimeMinutes: number;
  dayType: OvertimeDayType;
  rateMultiplier: number;
  reason: string | null;
  status: OvertimeClaimStatus;
  isOnBehalf: boolean;
  decisionComment: string | null;
  decidedAt: string | null;
  createdAt: string;
};

export type SubmitOvertimeClaimRequest = {
  employeeId: string;
  workDate: string;
  reason?: string;
};

export type DecideOvertimeClaimRequest = {
  decision: "approved" | "rejected";
  comment?: string;
};

// --- On-Duty, first increment (2026-09-18) -------------------------------
// See 0040_on_duty.sql. Distinct from Overtime (claiming extra hours after
// the fact): an On-Duty request authorizes, ahead of time, being away from
// the ordinary schedule/location for official work (a field visit, client
// site, training, business travel) over a date RANGE, not a single day's
// clock-in/out comparison. Decided via the same plain RBAC self/team/all
// shape AttendanceCorrectionRequestView/OvertimeRecordView already use.

export type OnDutyRequestStatus = "pending" | "approved" | "rejected";

export type OnDutyRequestView = {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  startDate: string;
  endDate: string;
  location: string | null;
  reason: string | null;
  status: OnDutyRequestStatus;
  isOnBehalf: boolean;
  decisionComment: string | null;
  decidedAt: string | null;
  createdAt: string;
};

export type SubmitOnDutyRequestRequest = {
  employeeId: string;
  startDate: string;
  endDate: string;
  location?: string;
  reason?: string;
};

export type DecideOnDutyRequestRequest = {
  decision: "approved" | "rejected";
  comment?: string;
};
