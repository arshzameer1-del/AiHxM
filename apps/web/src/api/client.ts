import type {
  ApplicationStage,
  ApplicationView,
  AssignableUserView,
  AssignGroupPolicyRequest,
  AssignShiftRequest,
  AssignSystemAdminRoleRequest,
  AttendanceCorrectionRequestView,
  AttendanceRecordView,
  AuditLogEntry,
  AuditLogFilters,
  BrandingAssetSlot,
  CalculatePayrollRunResponse,
  CalibrateReviewRequest,
  CandidateView,
  ClockInRequest,
  ClockOutRequest,
  Company,
  CompanyAdmin,
  CompanyConfig,
  CompanyDashboardRow,
  CompanyDetail,
  CompanyListFilters,
  CompensationView,
  CreateApplicationRequest,
  CreateCandidateRequest,
  CreateCompanyRequest,
  CreateEmployeeGroupRequest,
  CreateEmployeeLoginRequest,
  CreateEmployeeLoginResponse,
  DeletionImpactPreview,
  CreateEmployeeRequest,
  CreateGoalRequest,
  CreateHolidayRequest,
  CreateJobRequisitionRequest,
  CreateLeavePolicyRequest,
  CreateOffboardingItemTemplateRequest,
  CreateOnboardingItemTemplateRequest,
  CreatePayrollRunRequest,
  CreatePlatformAdminRequest,
  CreateReviewCycleRequest,
  CreateShiftRequest,
  CreateWorkflowTemplateRequest,
  DecideAttendanceCorrectionRequest,
  DecideLeaveRequestRequest,
  DecideOfferResponse,
  EmployeeGroupPolicyAssignmentView,
  EmployeeGroupView,
  EmployeeNumberFormat,
  EmployeeOffboardingView,
  EmployeeOnboardingView,
  EmployeeView,
  ExtendOfferRequest,
  GoalView,
  HealthCheckResult,
  PlatformHealthSummary,
  HolidayView,
  HorizontalPosition,
  ConfigurationDomainSummary,
  ImpersonateResponse,
  InitiateOffboardingRequest,
  IntegrationProviderKey,
  JobHistoryEntryView,
  JobRequisitionView,
  LeaveBalanceView,
  LeavePolicyVersionView,
  LeavePolicyView,
  LeaveRequestView,
  LoginResult,
  LogoAlignment,
  MeResponse,
  ModuleCatalogEntry,
  ModuleKey,
  MoveApplicationStageRequest,
  MoveOrgUnitRequest,
  CreateOrgUnitRequest,
  UpdateOrgUnitRequest,
  SetOrgUnitHeadPositionRequest,
  OrgUnitTreeNode,
  OrgUnitVersionView,
  OrgUnitView,
  CreateJobRequest,
  UpdateJobRequest,
  JobVersionView,
  JobView,
  CreatePositionRequest,
  UpdatePositionRequest,
  AssignPositionRequest,
  PositionStatus,
  PositionVersionView,
  PositionView,
  AssignmentStatus,
  AssignmentType,
  CreateEmployeeOrgAssignmentRequest,
  UpdateEmployeeOrgAssignmentRequest,
  EmployeeOrgAssignmentVersionView,
  EmployeeOrgAssignmentView,
  OrgRelationshipStatus,
  OrgRelationshipType,
  CreateOrgRelationshipRequest,
  UpdateOrgRelationshipRequest,
  OrgRelationshipVersionView,
  OrgRelationshipView,
  CreateLocationRequest,
  UpdateLocationRequest,
  MoveLocationRequest,
  LocationTreeNode,
  LocationVersionView,
  LocationView,
  CreateCostCenterRequest,
  UpdateCostCenterRequest,
  CostCenterVersionView,
  CostCenterView,
  CreateProfitCenterRequest,
  UpdateProfitCenterRequest,
  ProfitCenterVersionView,
  ProfitCenterView,
  CreateOrgChangeRequest,
  OrgChangeImpactSummary,
  OrgChangeValidationResult,
  OrgChangeView,
  OrganizationCommandCenterSummary,
  LegacyReconciliationReport,
  OffboardingChecklistItemView,
  OffboardingItemTemplateView,
  OfferView,
  OnboardingChecklistItemView,
  OnboardingItemTemplateView,
  PackageTier,
  PasswordResetRequestResult,
  PayrollRunView,
  PayrollSettingsView,
  PayslipView,
  PerformanceReviewView,
  PlatformAdmin,
  PlatformBranding,
  PlatformSavedView,
  PlatformSavedViewType,
  PolicyType,
  PublicSsoStatus,
  PublicTenantBranding,
  RatingDistributionView,
  ResolvedPolicyView,
  ResolvedWorkScheduleView,
  ReviewCycleView,
  Role,
  SessionResult,
  SetCompensationRequest,
  SetTaxSlabsRequest,
  SetWeeklyPatternRequest,
  ShiftAssignmentView,
  ShiftView,
  SignupRequest,
  SignupResponse,
  SubmitAttendanceCorrectionRequest,
  SubmitLeaveRequestRequest,
  SubmitLeaveRequestResponse,
  SubmitManagerAssessmentRequest,
  SubmitSelfAssessmentRequest,
  SubscriptionSummary,
  SupportTicket,
  SupportTicketPriority,
  SupportTicketStatus,
  RequestDataExportRequest,
  DomainAvailabilityResult,
  PackageTierSummary,
  TestInvitationResult,
  TenantBackup,
  TenantDataExport,
  TenantExportKeyStatus,
  DataResidencyStatus,
  RecordDrTestRequest,
  TenantDrTestLogEntry,
  SystemAdminRoleAssignmentView,
  TaxSlabSetView,
  TaxSlabView,
  TenantConfigurationSetting,
  TenantConfigurationVersion,
  TenantFeatureEntitlement,
  TenantIntegration,
  RotateIntegrationSecretResponse,
  SecurityPostureScore,
  WebhookEvent,
  ScimProvisioningStatus,
  GenerateScimTokenResponse,
  SetPlatformAdminAccessRequest,
  StepUpVerifyRequest,
  StepUpVerifyResponse,
  TenantUsageSummary,
  UpdateChecklistItemRequest,
  UpdateEmployeeGroupRequest,
  UpdateEmployeeRequest,
  UpdateGoalRequest,
  UpdateHolidayRequest,
  UpdateLeavePolicyRequest,
  UpdateOffboardingItemTemplateRequest,
  UpdateOnboardingItemTemplateRequest,
  UpdatePayrollSettingsRequest,
  UpdateShiftRequest,
  UpdateWorkScheduleAssignmentRuleRequest,
  UserSessionView,
  VerticalPosition,
  WorkflowTemplate,
  WorkScheduleAssignmentRuleView,
  WorkScheduleDayView,
  CreateWorkScheduleAssignmentRuleRequest,
} from "@aihxm/shared-types";

const TOKEN_KEY = "aihxm.platformAdminToken";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// Which tenant's own /:companySlug/login this session's identity last
// resolved to (MeResponse.companySlug), null for a Platform Admin session.
// AuthContext writes this every time GET /auth/me succeeds and reads it
// back on logout, so "Log out" (and a 401-driven auto-logout) can send a
// tenant's admin/employee back to THEIR OWN login page instead of the
// shared /login the Platform Admin uses — before this, every logout landed
// on /login regardless of which URL the session actually signed in from.
// Kept in localStorage (not the React state that's about to be cleared)
// specifically so it also survives the case where the token is already
// expired before this tab ever re-fetched identity (e.g. a stale tab
// resumed after the JWT's 12-hour window lapsed).
const LAST_TENANT_SLUG_KEY = "aihxm.lastTenantSlug";

export function getLastTenantSlug(): string | null {
  return localStorage.getItem(LAST_TENANT_SLUG_KEY);
}

export function setLastTenantSlug(slug: string | null): void {
  if (slug) {
    localStorage.setItem(LAST_TENANT_SLUG_KEY, slug);
  } else {
    localStorage.removeItem(LAST_TENANT_SLUG_KEY);
  }
}

// Tenant Management gap-fill Phase 1 item #4 — "Login As" now swaps the
// active token for a real tenant session (see AuthContext.setSessionToken),
// so the Platform Admin's own token has to be stashed somewhere to come
// back to: on "End session" (a deliberate click) and on the impersonation
// token's own natural 30-minute expiry (AuthContext's SESSION_EXPIRED_EVENT
// handler). localStorage (not React state) for the same reason
// LAST_TENANT_SLUG_KEY above is: it has to survive a page refresh taken
// while impersonating. `sessionId` is the impersonation token's own `jti`,
// used to force-end it server-side via the existing revoke-session
// endpoint — that call has to be made with the STASHED Platform Admin
// token, since PlatformAdminGuard (unlike SessionGuard) is what
// /platform/sessions/:id/revoke requires, and the impersonation token
// itself never carries is_platform_admin.
export type ImpersonationStash = {
  adminToken: string;
  sessionId: string;
  companyId: string;
  companyName: string;
  impersonatedAdminEmail: string;
};

const IMPERSONATION_KEY = "aihxm.impersonation";

export function getImpersonationStash(): ImpersonationStash | null {
  const raw = localStorage.getItem(IMPERSONATION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ImpersonationStash;
  } catch {
    return null;
  }
}

export function setImpersonationStash(stash: ImpersonationStash): void {
  localStorage.setItem(IMPERSONATION_KEY, JSON.stringify(stash));
}

export function clearImpersonationStash(): void {
  localStorage.removeItem(IMPERSONATION_KEY);
}

// Real bug found from a production screenshot: a 401 from ANY call, not
// just AuthContext's own getMe(), already cleared the stored token below —
// but nothing told the rest of the app that had happened. AuthContext's
// `isAuthenticated` stayed stuck at `true` (nothing re-derives it outside
// its own fetchIdentity() call path), so the route guard never redirected
// to /login, and the user was left on the same page clicking "Save" into a
// wall of raw, confusing backend error text ("Missing bearer token" —
// exactly what a request with no Authorization header at all looks like
// once the token is gone). This event is how a plain function (this file
// has no React context of its own) tells AuthContext "the session just
// died," so it can flip isAuthenticated and let the existing route guard
// do its job. SESSION_EXPIRED_KEY is the accompanying one-shot flag
// LoginPage reads once to show a human explanation instead of a silent
// bounce — sessionStorage (not localStorage) so it can't linger across an
// unrelated future visit if it's ever read out of order.
export const SESSION_EXPIRED_EVENT = "aihxm:session-expired";
const SESSION_EXPIRED_KEY = "aihxm.sessionExpiredNotice";

export function consumeSessionExpiredNotice(): boolean {
  try {
    if (sessionStorage.getItem(SESSION_EXPIRED_KEY) !== "1") return false;
    sessionStorage.removeItem(SESSION_EXPIRED_KEY);
    return true;
  } catch {
    return false;
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /**
     * Phase 2 gap-fill item #2 — step-up re-authentication. Only ever
     * present for StepUpGuard's own 403 shape
     * (`{ code: "step_up_required", ... }`, see step-up.guard.ts) — every
     * other error response in this app has no `code` field, so this is
     * `undefined` for them. Lets a caller distinguish "needs step-up" from
     * an ordinary 403 without string-matching the message.
     */
    public code?: string
  ) {
    super(message);
  }
}

/**
 * Not a `request()` call — this is consumed as an `<img src>`, which needs
 * a plain URL string the browser fetches itself, not a JSON response this
 * client parses. Same `/api` same-origin prefix as everything else here
 * (netlify.toml proxies it to the real backend regardless of which
 * tenant subdomain served the page), and no auth token: public-branding
 * assets are the whole point of public/public-branding.controller.ts.
 */
export function publicTenantBrandingAssetUrl(
  companySlug: string,
  slot: "logo" | "login-background"
): string {
  return `/api/public/tenants/${companySlug}/branding/${slot}/asset`;
}

/**
 * Same "plain URL for an <img src>" shape as publicTenantBrandingAssetUrl
 * above, for the platform's OWN logo (migration 0046_platform_branding.sql)
 * instead of a tenant's — public/platform-branding.controller.ts, no auth.
 * A cache-busting query param matters here in a way it doesn't for the
 * per-tenant asset: AihxmLogo mounts on every portal page (sidebar, login),
 * so without one, a just-changed platform logo would keep showing the
 * browser's cached previous image until a hard refresh. `updatedAt` is
 * exactly the signal that changed, so it's the natural cache key.
 */
export function platformBrandingAssetUrl(updatedAt?: string): string {
  const version = updatedAt ? encodeURIComponent(updatedAt) : "";
  return `/api/public/platform-branding/logo/asset${version ? `?v=${version}` : ""}`;
}

/**
 * Same "plain URL, not a `request()` call" shape as the two asset-URL
 * builders above, for the same reason: this is consumed as a real browser
 * navigation (an `<a href>`), not a `fetch()` — `SsoController.login`
 * 302s straight to the tenant's IdP, so there's no JSON response for this
 * client to parse.
 */
export function ssoLoginUrl(companySlug: string): string {
  return `/api/auth/sso/${companySlug}/login`;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`/api${path}`, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    try {
      sessionStorage.setItem(SESSION_EXPIRED_KEY, "1");
    } catch {
      // Best-effort — a missed "your session expired" banner on the next
      // login screen isn't worth failing this request over.
    }
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let code: string | undefined;
    try {
      const body = await res.json();
      message = body.message ?? message;
      code = typeof body.code === "string" ? body.code : undefined;
    } catch {
      // response body wasn't JSON — keep the generic message
    }
    throw new ApiError(res.status, Array.isArray(message) ? message.join(", ") : message, code);
  }

  // A void-returning Nest handler (every DELETE/unassign this project has —
  // Task #49's deleteEmployeeGroup/unassignGroupPolicy/deleteLeavePolicy
  // are the first callers) defaults to a 200 with an EMPTY body, not a
  // 204, unless the controller opts into @HttpCode(204) explicitly. The
  // old `res.status === 204` check missed that real case entirely:
  // res.json() on an empty body throws "Unexpected end of JSON input", a
  // plain SyntaxError, not an ApiError — so a caller's `catch (err) { err
  // instanceof ApiError ? ... }` fell through to a generic failure message
  // even though the mutation had already succeeded server-side, and
  // (because the exception was thrown before the caller's own success
  // callback ran) the UI never refreshed to show the real, successfully
  // updated state either. Found via an actual Playwright pass driving the
  // real running app — the exact "verify, don't just claim" gap this
  // project's discipline exists to catch. Reading the body as text FIRST
  // and only parsing it as JSON when it's non-empty is correct for every
  // status code, not just 204, so this protects any future void endpoint
  // too, not only today's three.
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export const api = {
  // --- Auth (Phase 3 — password + mandatory MFA) --------------------------
  // Each of these three deliberately does NOT send the stored bearer token
  // — they're the pre-authentication flow itself, carrying state via the
  // short-lived mfaTicket/reset token instead. See AuthContext for how the
  // multi-step result (mfa_setup_required / mfa_required / ok) drives the
  // login UI.
  login: (email: string, password: string) =>
    request<LoginResult>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),

  // A tenant's own login page (leadhcm.aihxm.com/login) — see
  // AuthService.loginWithEmployeeNumber's doc comment.
  loginWithEmployeeNumber: (companySlug: string, employeeNumber: string, password: string) =>
    request<LoginResult>("/auth/login/employee", {
      method: "POST",
      body: JSON.stringify({ companySlug, employeeNumber, password }),
    }),

  // No auth token needed (and none may exist yet — this loads before
  // anyone has signed in) — public/public-branding.controller.ts. A 404
  // just means this slug has no custom branding (or isn't a real tenant),
  // which the login page treats as "use the default AIHXM look," not an
  // error to surface.
  getPublicTenantBranding: (companySlug: string) =>
    request<PublicTenantBranding>(`/public/tenants/${companySlug}/branding`),

  // Phase 3 item #1 (OIDC slice) — whether to show a "Sign in with SSO"
  // link on this tenant's own login page at all. Same no-auth, 404-means-
  // "no custom config" posture as getPublicTenantBranding above.
  getPublicSsoStatus: (companySlug: string) =>
    request<PublicSsoStatus>(`/public/tenants/${companySlug}/sso`),

  confirmMfaEnrollment: (mfaTicket: string, code: string) =>
    request<SessionResult>("/auth/mfa/enroll/confirm", {
      method: "POST",
      body: JSON.stringify({ mfaTicket, code }),
    }),

  verifyMfa: (mfaTicket: string, code: string) =>
    request<SessionResult>("/auth/mfa/verify", {
      method: "POST",
      body: JSON.stringify({ mfaTicket, code }),
    }),

  // The "I lost my authenticator device" fallback — one of the ten
  // single-use codes shown once at enrollment (confirmMfaEnrollment's
  // result.recoveryCodes) in place of a TOTP code.
  verifyMfaRecoveryCode: (mfaTicket: string, code: string) =>
    request<SessionResult>("/auth/mfa/recovery-code/verify", {
      method: "POST",
      body: JSON.stringify({ mfaTicket, code }),
    }),

  requestPasswordReset: (email: string) =>
    request<PasswordResetRequestResult>("/auth/password-reset/request", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),

  confirmPasswordReset: (token: string, newPassword: string) =>
    request<{ message: string }>("/auth/password-reset/confirm", {
      method: "POST",
      body: JSON.stringify({ token, newPassword }),
    }),

  // Self-service company signup (signup.controller.ts) — the other
  // deliberately unauthenticated write endpoint, alongside /auth/*.
  // Doesn't return a session: the new admin still goes through the
  // same mandatory-MFA-enrollment login flow as anyone else, on
  // /login, right after this succeeds.
  signup: (input: SignupRequest) =>
    request<SignupResponse>("/signup", { method: "POST", body: JSON.stringify(input) }),

  // Decision #13 — what the shared portal shell (Layout/AuthContext) uses
  // to decide which portal to render and which nav sections to show. This
  // DOES send the stored bearer token (unlike the pre-auth calls above) —
  // it's read back after a session already exists.
  getMe: () => request<MeResponse>("/auth/me"),

  // Phase 2 gap-fill item #2 — step-up re-authentication. Re-proves this
  // session's own second factor immediately before a particularly
  // sensitive action; see StepUpGuard/StepUpService and useStepUp.tsx,
  // which is what actually drives this in response to an ApiError whose
  // `code` is "step_up_required".
  verifyStepUp: (input: StepUpVerifyRequest) =>
    request<StepUpVerifyResponse>("/auth/step-up", { method: "POST", body: JSON.stringify(input) }),

  // --- Platform Admins ------------------------------------------------------
  listPlatformAdmins: () => request<PlatformAdmin[]>("/platform/admins"),

  createPlatformAdmin: (input: CreatePlatformAdminRequest) =>
    request<PlatformAdmin>("/platform/admins", { method: "POST", body: JSON.stringify(input) }),

  setPlatformAdminStatus: (id: string, status: PlatformAdmin["status"]) =>
    request<PlatformAdmin>(`/platform/admins/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),

  // Phase 2 gap-fill item #7 — Platform Admin delegation.
  setPlatformAdminAccess: (id: string, input: SetPlatformAdminAccessRequest) =>
    request<PlatformAdmin>(`/platform/admins/${id}/access`, { method: "PATCH", body: JSON.stringify(input) }),

  // --- Platform Branding (the platform's own logo, migration 0046) --------
  // No auth needed for the read — same public/no-guard posture as
  // getPublicTenantBranding above, since the default /login page and every
  // tenant subdomain's "Powered by AIHXM" credit need this before (or
  // without) any session existing.
  getPlatformBranding: () => request<PlatformBranding>("/public/platform-branding"),

  async uploadPlatformLogo(file: File): Promise<PlatformBranding> {
    const token = getToken();
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/platform/branding/logo", {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        const body = await res.json();
        message = body.message ?? message;
      } catch {
        // not JSON — keep the generic message
      }
      throw new ApiError(res.status, message);
    }
    return res.json();
  },

  removePlatformLogo: () => request<PlatformBranding>("/platform/branding/logo", { method: "DELETE" }),

  // TM-002/TM-003 — Tenant Directory search + filters.
  listCompanies: (filters?: CompanyListFilters) => {
    const params = new URLSearchParams();
    if (filters?.search) params.set("search", filters.search);
    if (filters?.status?.length) params.set("status", filters.status.join(","));
    if (filters?.packageTier?.length) params.set("packageTier", filters.packageTier.join(","));
    if (filters?.country?.length) params.set("country", filters.country.join(","));
    const qs = params.toString();
    return request<CompanyDashboardRow[]>(`/platform/companies${qs ? `?${qs}` : ""}`);
  },

  createCompany: (input: CreateCompanyRequest) =>
    request<CompanyDetail>("/platform/companies", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  getCompany: (id: string) => request<CompanyDetail>(`/platform/companies/${id}`),

  // `reason` is required by the backend for suspend/lock (TM-005/TM-030) —
  // enforced server-side, not just here.
  updateCompanyStatus: (id: string, status: Company["status"], reason?: string) =>
    request<Company>(`/platform/companies/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status, reason }),
    }),

  // TM-037/TM-038 — Lifecycle: Danger Zone deletion workflow.
  // Phase 1 item #5 — impact preview (read-only) + second-approver rule.
  getCompanyDeletionImpact: (id: string) =>
    request<DeletionImpactPreview>(`/platform/companies/${id}/deletion-impact`),

  requestCompanyDeletion: (id: string, input: { reason: string; graceDays?: number }) =>
    request<Company>(`/platform/companies/${id}/deletion-request`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  cancelCompanyDeletion: (id: string) =>
    request<Company>(`/platform/companies/${id}/deletion-request`, { method: "DELETE" }),

  approveCompanyDeletion: (id: string) =>
    request<Company>(`/platform/companies/${id}/deletion-request/approve`, { method: "POST" }),

  // TM-003 — saved, reusable filter combinations. Extended by Tenant
  // Management gap-fill Phase 1 item #6 to also cover Audit Log searches
  // (`viewType`); every call site names its own type explicitly so a
  // Tenant Directory view and an Audit Log search never show up mixed
  // together in the wrong list.
  listSavedViews: (viewType: PlatformSavedViewType) =>
    request<PlatformSavedView[]>(`/platform/saved-views?viewType=${viewType}`),

  createSavedView: (name: string, viewType: PlatformSavedViewType, filters: CompanyListFilters | AuditLogFilters) =>
    request<PlatformSavedView>("/platform/saved-views", {
      method: "POST",
      body: JSON.stringify({ name, viewType, filters }),
    }),

  deleteSavedView: (id: string) =>
    request<{ message: string }>(`/platform/saved-views/${id}`, { method: "DELETE" }),

  // TM-017/TM-029 — Sessions + Force Logout.
  listSessions: (companyId?: string) =>
    request<UserSessionView[]>(`/platform/sessions${companyId ? `?companyId=${companyId}` : ""}`),

  revokeSession: (id: string) =>
    request<{ message: string }>(`/platform/sessions/${id}/revoke`, { method: "POST" }),

  forceLogoutUser: (userAccountId: string) =>
    request<{ message: string; revokedCount: number }>(`/platform/users/${userAccountId}/sessions/revoke`, {
      method: "POST",
    }),

  // TM-018/019/020 — Tenant Configuration (override/inheritance/history/rollback).
  getTenantConfiguration: (companyId: string) =>
    request<TenantConfigurationSetting[]>(`/platform/companies/${companyId}/configuration`),

  setConfigurationOverride: (companyId: string, category: string, settingKey: string, value: unknown) =>
    request<TenantConfigurationSetting>(`/platform/companies/${companyId}/configuration/${category}/${settingKey}`, {
      method: "POST",
      body: JSON.stringify({ value }),
    }),

  resetConfigurationToDefault: (companyId: string, category: string, settingKey: string) =>
    request<{ message: string }>(`/platform/companies/${companyId}/configuration/${category}/${settingKey}/reset`, {
      method: "POST",
    }),

  getConfigurationHistory: (companyId: string, category: string, settingKey: string) =>
    request<TenantConfigurationVersion[]>(
      `/platform/companies/${companyId}/configuration/${category}/${settingKey}/history`
    ),

  rollbackConfiguration: (companyId: string, versionId: string) =>
    request<TenantConfigurationSetting>(`/platform/companies/${companyId}/configuration/rollback`, {
      method: "POST",
      body: JSON.stringify({ versionId }),
    }),

  // TM-021/022 — Module catalog with dependency.
  listModuleCatalog: (companyId: string) =>
    request<ModuleCatalogEntry[]>(`/platform/companies/${companyId}/modules`),

  // TM-023/024 — Feature entitlements.
  listFeatureEntitlements: (companyId: string) =>
    request<TenantFeatureEntitlement[]>(`/platform/companies/${companyId}/features`),

  setFeatureEntitlement: (companyId: string, featureKey: string, patch: { enabled?: boolean; usageLimit?: number | null }) =>
    request<TenantFeatureEntitlement>(`/platform/companies/${companyId}/features/${featureKey}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  // TM-025/026 — Subscription: plan summary, Change Plan, seat management.
  getSubscription: (companyId: string) => request<SubscriptionSummary>(`/platform/companies/${companyId}/subscription`),

  changeSubscriptionPlan: (companyId: string, toTier: PackageTier) =>
    request<SubscriptionSummary>(`/platform/companies/${companyId}/subscription/change-plan`, {
      method: "POST",
      body: JSON.stringify({ toTier }),
    }),

  setSubscriptionSeats: (companyId: string, seatsPurchased: number) =>
    request<SubscriptionSummary>(`/platform/companies/${companyId}/subscription/seats`, {
      method: "POST",
      body: JSON.stringify({ seatsPurchased }),
    }),

  // TM-027/028 — Usage dashboard + Storage quota.
  getUsage: (companyId: string) => request<TenantUsageSummary>(`/platform/companies/${companyId}/usage`),

  setStorageQuota: (companyId: string, storageQuotaMb: number) =>
    request<TenantUsageSummary>(`/platform/companies/${companyId}/storage/quota`, {
      method: "PATCH",
      body: JSON.stringify({ storageQuotaMb }),
    }),

  // TM-031 — Integration catalog (SMTP/SSO/biometric device/webhook).
  listIntegrations: (companyId: string) =>
    request<TenantIntegration[]>(`/platform/companies/${companyId}/integrations`),

  configureIntegration: (
    companyId: string,
    providerKey: IntegrationProviderKey,
    patch: { enabled?: boolean; config?: Record<string, unknown> }
  ) =>
    request<TenantIntegration>(`/platform/companies/${companyId}/integrations/${providerKey}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  // Tenant Management gap-fill Phase 1 item #12 — rotate an AIHXM-issued
  // integration secret (biometric_device apiKey / webhook signingSecret).
  rotateIntegrationSecret: (companyId: string, providerKey: IntegrationProviderKey) =>
    request<RotateIntegrationSecretResponse>(`/platform/companies/${companyId}/integrations/${providerKey}/rotate`, {
      method: "POST",
    }),

  // Phase 3 item #4 — Webhooks & Eventing. Real delivery for the
  // `webhook` integration's own config above — see WebhookDispatchService.
  listWebhookEvents: (companyId: string) =>
    request<WebhookEvent[]>(`/platform/companies/${companyId}/webhook-events`),

  replayWebhookEvent: (companyId: string, eventId: string) =>
    request<WebhookEvent>(`/platform/companies/${companyId}/webhook-events/${eventId}/replay`, { method: "POST" }),

  sendTestWebhookEvent: (companyId: string) =>
    request<WebhookEvent>(`/platform/companies/${companyId}/webhook-events/test`, { method: "POST" }),

  // Phase 3 item #1, slice 3 — SCIM 2.0 inbound provisioning. A separate
  // small surface from the `sso` integration's own config/rotate routes
  // above: this token isn't a `tenant_integrations.config` jsonb field,
  // it's a dedicated, hashed, one-time-reveal credential (see
  // ScimAdminController's own doc comment).
  getScimStatus: (companyId: string) => request<ScimProvisioningStatus>(`/platform/companies/${companyId}/scim/status`),

  generateScimToken: (companyId: string) =>
    request<GenerateScimTokenResponse>(`/platform/companies/${companyId}/scim/token`, { method: "POST" }),

  disableScim: (companyId: string) =>
    request<{ enabled: boolean }>(`/platform/companies/${companyId}/scim/disable`, { method: "POST" }),

  // TM-032 — Health dashboard.
  getHealth: (companyId: string) => request<HealthCheckResult[]>(`/platform/companies/${companyId}/health`),

  runHealthCheck: (companyId: string) =>
    request<HealthCheckResult[]>(`/platform/companies/${companyId}/health/check`, { method: "POST" }),

  // Phase 3 item #9 — Monitoring. Cross-tenant summary for the Tenant
  // Directory's Platform Health panel.
  getPlatformHealthSummary: () => request<PlatformHealthSummary>(`/platform/health/summary`),

  // TM-033 — Support tickets.
  listSupportTickets: (companyId: string, status?: SupportTicketStatus) =>
    request<SupportTicket[]>(
      `/platform/companies/${companyId}/support-tickets${status ? `?status=${status}` : ""}`
    ),

  createSupportTicket: (
    companyId: string,
    dto: { subject: string; description: string; priority?: SupportTicketPriority }
  ) =>
    request<SupportTicket>(`/platform/companies/${companyId}/support-tickets`, {
      method: "POST",
      body: JSON.stringify(dto),
    }),

  updateSupportTicket: (
    companyId: string,
    ticketId: string,
    patch: { status?: SupportTicketStatus; priority?: SupportTicketPriority; assignee?: string | null }
  ) =>
    request<SupportTicket>(`/platform/companies/${companyId}/support-tickets/${ticketId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  // TM-035 — Backups.
  listBackups: (companyId: string) => request<TenantBackup[]>(`/platform/companies/${companyId}/backups`),

  createBackup: (companyId: string) =>
    request<TenantBackup>(`/platform/companies/${companyId}/backups`, { method: "POST" }),

  // Streams the backup's JSON file — same pattern as downloadDisbursementFile below.
  async downloadBackup(companyId: string, backupId: string): Promise<void> {
    const token = getToken();
    const res = await fetch(`/api/platform/companies/${companyId}/backups/${backupId}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        const body = await res.json();
        message = body.message ?? message;
      } catch {
        // not JSON — keep the generic message
      }
      throw new ApiError(res.status, message);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `backup-${backupId}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },

  // TM-036 — Data export & migration jobs.
  listDataExports: (companyId: string) => request<TenantDataExport[]>(`/platform/companies/${companyId}/exports`),

  requestDataExport: (companyId: string, dto: RequestDataExportRequest) =>
    request<TenantDataExport>(`/platform/companies/${companyId}/exports`, {
      method: "POST",
      body: JSON.stringify(dto),
    }),

  // `password` (Phase 2 gap-fill item #6) is appended as a query param,
  // not a request body — this stays a plain GET so the browser download
  // (blob + <a download>) flow below keeps working as one request. Never
  // logged or stored client-side beyond this one call.
  async downloadDataExport(companyId: string, exportId: string, fileName: string, password?: string): Promise<void> {
    const token = getToken();
    const query = password ? `?password=${encodeURIComponent(password)}` : "";
    const res = await fetch(`/api/platform/companies/${companyId}/exports/${exportId}/download${query}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        const body = await res.json();
        message = body.message ?? message;
      } catch {
        // not JSON — keep the generic message
      }
      throw new ApiError(res.status, message);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },

  // Phase 3 item #5 — tenant-dedicated export encryption key, with
  // independent rotation. Never returns key material of any kind — see
  // TenantExportKeyService's own doc comment.
  getExportKeyStatus: (companyId: string) =>
    request<TenantExportKeyStatus>(`/platform/companies/${companyId}/export-key`),

  enableExportKey: (companyId: string) =>
    request<TenantExportKeyStatus>(`/platform/companies/${companyId}/export-key/enable`, { method: "POST" }),

  rotateExportKey: (companyId: string) =>
    request<TenantExportKeyStatus>(`/platform/companies/${companyId}/export-key/rotate`, { method: "POST" }),

  disableExportKey: (companyId: string) =>
    request<TenantExportKeyStatus>(`/platform/companies/${companyId}/export-key/disable`, { method: "POST" }),

  // Phase 3 item #6 — Data Residency & Sovereignty: a declaration +
  // disclosure mechanism, not real multi-region data placement (this
  // platform runs on one Supabase region). See DataResidencyStatus's own
  // doc comment (shared-types) for the honest scope.
  getResidencyStatus: (companyId: string) =>
    request<DataResidencyStatus>(`/platform/companies/${companyId}/residency`),

  setResidencyRequiredRegion: (companyId: string, requiredRegion: string | null) =>
    request<DataResidencyStatus>(`/platform/companies/${companyId}/residency`, {
      method: "POST",
      body: JSON.stringify({ requiredRegion }),
    }),

  acknowledgeResidencyMismatch: (companyId: string) =>
    request<DataResidencyStatus>(`/platform/companies/${companyId}/residency/acknowledge`, { method: "POST" }),

  // Phase 3 item #8 — read-only, entirely computed from data already
  // collected elsewhere; see SecurityPostureService's own doc comment for
  // the point-weighting behind the number this returns.
  getSecurityPosture: (companyId: string) =>
    request<SecurityPostureScore>(`/platform/companies/${companyId}/security-posture`),

  // Phase 3 item #7 — manual DR test evidence log (no automated failover
  // harness exists in this platform; see BackupsService.recordDrTest's
  // own doc comment).
  listDrTests: (companyId: string) =>
    request<TenantDrTestLogEntry[]>(`/platform/companies/${companyId}/backups/dr-tests`),

  recordDrTest: (companyId: string, dto: RecordDrTestRequest) =>
    request<TenantDrTestLogEntry>(`/platform/companies/${companyId}/backups/dr-tests`, {
      method: "POST",
      body: JSON.stringify(dto),
    }),

  updateCompanyConfig: (
    id: string,
    patch: {
      branding?: {
        primaryColor?: string;
        secondaryColor?: string;
        logoAlignment?: LogoAlignment;
        logoHeightPx?: number;
        logoBackgroundColor?: string;
        loginBackgroundPositionX?: HorizontalPosition;
        loginBackgroundPositionY?: VerticalPosition;
        loginCardWidthPx?: number;
        loginCardPosition?: HorizontalPosition;
        loginCardBackgroundColor?: string;
        loginCardOpacity?: number;
      };
      enabledModules?: ModuleKey[];
      employeeNumberFormat?: Partial<EmployeeNumberFormat>;
    }
  ) =>
    request<CompanyConfig>(`/platform/companies/${id}/config`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  // TM-014 — Tenant Profile's "Company Information" section.
  updateCompanyProfile: (
    id: string,
    patch: {
      legalName?: string;
      companyCode?: string;
      registrationNumber?: string;
      industry?: string;
      country?: string;
      timezone?: string;
      currency?: string;
      fiscalYearStartMonth?: number;
      customDomain?: string;
    }
  ) =>
    request<Company>(`/platform/companies/${id}/profile`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  // TM-015 — real branding asset uploads (logo/favicon/login background).
  async uploadBrandingAsset(companyId: string, slot: BrandingAssetSlot, file: File): Promise<CompanyConfig> {
    const token = getToken();
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`/api/platform/companies/${companyId}/branding/${slot}`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        const body = await res.json();
        message = body.message ?? message;
      } catch {
        // not JSON — keep the generic message
      }
      throw new ApiError(res.status, message);
    }
    return res.json();
  },

  // Returns a blob: URL the caller can put directly in an <img src> —
  // there's no public unauthenticated URL for a branding asset (see
  // CompaniesController.downloadBranding), so every preview goes through
  // an authenticated fetch, same pattern as downloadBackup/downloadDataExport.
  async brandingAssetPreviewUrl(companyId: string, slot: BrandingAssetSlot): Promise<string | null> {
    const token = getToken();
    const res = await fetch(`/api/platform/companies/${companyId}/branding/${slot}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  },

  // TM-006–012 — Create Tenant wizard support endpoints.
  listPackageTiers: () => request<PackageTierSummary[]>("/platform/package-tiers"),

  // Catalog-only (no per-tenant `enabled` flag) — for the wizard's Module
  // Provisioning step, before any tenant/entitlement rows exist.
  listGlobalModuleCatalog: () =>
    request<Omit<ModuleCatalogEntry, "enabled">[]>("/platform/module-catalog"),

  checkTenantAvailability: (slug: string, customDomain?: string) =>
    request<DomainAvailabilityResult>("/platform/tenant-availability", {
      method: "POST",
      body: JSON.stringify({ slug, customDomain: customDomain || undefined }),
    }),

  sendTestInvitation: (input: { fullName: string; email: string; companyName?: string }) =>
    request<TestInvitationResult>("/platform/test-invitations", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  addAdmin: (id: string, input: { fullName: string; email: string }) =>
    request<CompanyAdmin>(`/platform/companies/${id}/admins`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  setAdminStatus: (id: string, adminId: string, status: CompanyAdmin["status"]) =>
    request<CompanyAdmin>(`/platform/companies/${id}/admins/${adminId}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),

  createAdminLogin: (id: string, adminId: string, initialPassword: string, loginId?: string) =>
    request<CompanyAdmin>(`/platform/companies/${id}/admins/${adminId}/account`, {
      method: "POST",
      body: JSON.stringify({ initialPassword, ...(loginId ? { loginId } : {}) }),
    }),

  resetAdminPassword: (id: string, adminId: string, newPassword: string) =>
    request<CompanyAdmin>(`/platform/companies/${id}/admins/${adminId}/account/reset-password`, {
      method: "POST",
      body: JSON.stringify({ newPassword }),
    }),

  // Tenant Management gap-fill batch 1, Phase 1 item #2 — forces a fresh
  // MFA enrollment on this admin's next login (clears the old secret,
  // deletes any outstanding recovery codes). No body: nothing to configure.
  resetAdminMfa: (id: string, adminId: string) =>
    request<CompanyAdmin>(`/platform/companies/${id}/admins/${adminId}/account/reset-mfa`, {
      method: "POST",
    }),

  // Tenant Management gap-fill batch 1, Phase 1 item #3 — clears the
  // automatic failed-login lockout without touching the password or MFA.
  unlockAdminAccount: (id: string, adminId: string) =>
    request<CompanyAdmin>(`/platform/companies/${id}/admins/${adminId}/account/unlock`, {
      method: "POST",
    }),

  // Tenant Management gap-fill Phase 1 item #7 — periodic access-review
  // attestation. No body: nothing to configure, just a timestamp + who.
  markAdminAccessReviewed: (id: string, adminId: string) =>
    request<CompanyAdmin>(`/platform/companies/${id}/admins/${adminId}/access-review`, {
      method: "POST",
    }),

  // Tenant Management gap-fill Phase 1 item #8 — revoke a login before
  // it's ever been used (see companies.service.ts's revokeAdminLogin doc
  // comment for why this is distinct from Lock).
  revokeAdminLogin: (id: string, adminId: string) =>
    request<CompanyAdmin>(`/platform/companies/${id}/admins/${adminId}/account/revoke`, {
      method: "POST",
    }),

  impersonate: (id: string, reason: string) =>
    request<ImpersonateResponse>(`/platform/companies/${id}/impersonate`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  // Tenant Management gap-fill Phase 1 item #6 — actor/action/date-range
  // filters added alongside the original companyId filter.
  listAuditLog: (filters?: AuditLogFilters) => {
    const params = new URLSearchParams();
    if (filters?.companyId) params.set("companyId", filters.companyId);
    if (filters?.actor) params.set("actor", filters.actor);
    if (filters?.action) params.set("action", filters.action);
    if (filters?.from) params.set("from", filters.from);
    if (filters?.to) params.set("to", filters.to);
    const qs = params.toString();
    return request<AuditLogEntry[]>(`/platform/audit-log${qs ? `?${qs}` : ""}`);
  },

  // --- Employee Core (Task #48) --------------------------------------------
  // Every one of these hits the same RLS/RBAC-scoped endpoints Phase 7
  // already built and tested — GET /employees itself returns only the
  // rows (and only the fields on each row) the caller's real role
  // actually grants, so hr_admin/line_manager/employee_self_service all
  // call the identical listEmployees(), never a role-specific query.
  listEmployees: () => request<EmployeeView[]>("/employees"),

  getEmployee: (id: string) => request<EmployeeView>(`/employees/${id}`),

  createEmployee: (input: CreateEmployeeRequest) =>
    request<EmployeeView>("/employees", { method: "POST", body: JSON.stringify(input) }),

  updateEmployee: (id: string, patch: UpdateEmployeeRequest) =>
    request<EmployeeView>(`/employees/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  // Decision #12/#13's own first UI surface — an HR Admin granting a
  // tenant-scoped login + role(s) to an employee they already created.
  createEmployeeLogin: (id: string, input: CreateEmployeeLoginRequest) =>
    request<CreateEmployeeLoginResponse>(`/employees/${id}/account`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  listJobHistory: (id: string) => request<JobHistoryEntryView[]>(`/employees/${id}/job-history`),

  // --- Organization Management, Phase 1 (0065_organization_units.sql) ------
  // The canonical Org Unit hierarchy — the Hierarchy Explorer's own data
  // source. `getTree()` is the one call the page actually renders from;
  // the rest back its create/edit/move/archive actions.
  getOrgUnitTree: () => request<OrgUnitTreeNode[]>("/organization/units/tree"),

  listOrgUnits: () => request<OrgUnitView[]>("/organization/units"),

  // Organization Management Phase 9 — OrgUnitDetailPage's single-record
  // fetch; the backend route has existed since Phase 1, this client method
  // was simply never added until the unified workspace needed it.
  getOrgUnit: (id: string) => request<OrgUnitView>(`/organization/units/${id}`),

  createOrgUnit: (input: CreateOrgUnitRequest) =>
    request<OrgUnitView>("/organization/units", { method: "POST", body: JSON.stringify(input) }),

  updateOrgUnit: (id: string, patch: UpdateOrgUnitRequest) =>
    request<OrgUnitView>(`/organization/units/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  moveOrgUnit: (id: string, input: MoveOrgUnitRequest) =>
    request<OrgUnitView>(`/organization/units/${id}/move`, { method: "POST", body: JSON.stringify(input) }),

  archiveOrgUnit: (id: string) => request<OrgUnitView>(`/organization/units/${id}/archive`, { method: "POST" }),

  activateOrgUnit: (id: string) => request<OrgUnitView>(`/organization/units/${id}/activate`, { method: "POST" }),

  setOrgUnitHeadPosition: (id: string, input: SetOrgUnitHeadPositionRequest) =>
    request<OrgUnitView>(`/organization/units/${id}/head-position`, { method: "POST", body: JSON.stringify(input) }),

  getOrgUnitHistory: (id: string) => request<OrgUnitVersionView[]>(`/organization/units/${id}/history`),

  // --- Organization Management, Phase 2 (0068_job_position_architecture.sql) --
  // Job Catalog (JobsPage.tsx — a setup screen) and Position Workbench
  // (PositionWorkbenchPage.tsx — the occupancy/lifecycle screen), the same
  // "list is the page's data source, the rest back its actions" shape the
  // Org Unit calls above already established.
  listJobs: () => request<JobView[]>("/organization/jobs"),

  getJob: (id: string) => request<JobView>(`/organization/jobs/${id}`),

  createJob: (input: CreateJobRequest) =>
    request<JobView>("/organization/jobs", { method: "POST", body: JSON.stringify(input) }),

  updateJob: (id: string, patch: UpdateJobRequest) =>
    request<JobView>(`/organization/jobs/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  archiveJob: (id: string) => request<JobView>(`/organization/jobs/${id}/archive`, { method: "POST" }),

  activateJob: (id: string) => request<JobView>(`/organization/jobs/${id}/activate`, { method: "POST" }),

  getJobHistory: (id: string) => request<JobVersionView[]>(`/organization/jobs/${id}/history`),

  listPositions: (filters?: { status?: PositionStatus; orgUnitId?: string }) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.orgUnitId) params.set("orgUnitId", filters.orgUnitId);
    const qs = params.toString();
    return request<PositionView[]>(`/organization/positions${qs ? `?${qs}` : ""}`);
  },

  getPosition: (id: string) => request<PositionView>(`/organization/positions/${id}`),

  createPosition: (input: CreatePositionRequest) =>
    request<PositionView>("/organization/positions", { method: "POST", body: JSON.stringify(input) }),

  updatePosition: (id: string, patch: UpdatePositionRequest) =>
    request<PositionView>(`/organization/positions/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  assignPosition: (id: string, input: AssignPositionRequest) =>
    request<PositionView>(`/organization/positions/${id}/assign`, { method: "POST", body: JSON.stringify(input) }),

  unassignPosition: (id: string) => request<PositionView>(`/organization/positions/${id}/unassign`, { method: "POST" }),

  freezePosition: (id: string) => request<PositionView>(`/organization/positions/${id}/freeze`, { method: "POST" }),

  unfreezePosition: (id: string) => request<PositionView>(`/organization/positions/${id}/unfreeze`, { method: "POST" }),

  abolishPosition: (id: string) => request<PositionView>(`/organization/positions/${id}/abolish`, { method: "POST" }),

  reactivatePosition: (id: string) => request<PositionView>(`/organization/positions/${id}/reactivate`, { method: "POST" }),

  getPositionHistory: (id: string) => request<PositionVersionView[]>(`/organization/positions/${id}/history`),

  // --- Organization Management, Phase 3
  // (0071_employee_org_assignments_and_relationships.sql) ------------------
  // Assignment Workbench (an employee's org unit/position assignment slots)
  // and Relationship Explorer (typed reporting relationships) — same
  // "list is the page's data source, the rest back its actions" shape every
  // prior Organization Management phase's calls already established.
  listEmployeeOrgAssignments: (filters?: {
    employeeId?: string;
    orgUnitId?: string;
    // Organization Management Phase 9 — PositionDetailPage's "Assignment
    // History" tab.
    positionId?: string;
    assignmentType?: AssignmentType;
    status?: AssignmentStatus;
  }) => {
    const params = new URLSearchParams();
    if (filters?.employeeId) params.set("employeeId", filters.employeeId);
    if (filters?.orgUnitId) params.set("orgUnitId", filters.orgUnitId);
    if (filters?.positionId) params.set("positionId", filters.positionId);
    if (filters?.assignmentType) params.set("assignmentType", filters.assignmentType);
    if (filters?.status) params.set("status", filters.status);
    const qs = params.toString();
    return request<EmployeeOrgAssignmentView[]>(`/organization/employee-assignments${qs ? `?${qs}` : ""}`);
  },

  getEmployeeOrgAssignment: (id: string) => request<EmployeeOrgAssignmentView>(`/organization/employee-assignments/${id}`),

  createEmployeeOrgAssignment: (input: CreateEmployeeOrgAssignmentRequest) =>
    request<EmployeeOrgAssignmentView>("/organization/employee-assignments", { method: "POST", body: JSON.stringify(input) }),

  updateEmployeeOrgAssignment: (id: string, patch: UpdateEmployeeOrgAssignmentRequest) =>
    request<EmployeeOrgAssignmentView>(`/organization/employee-assignments/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  endEmployeeOrgAssignment: (id: string, effectiveFrom?: string) =>
    request<EmployeeOrgAssignmentView>(`/organization/employee-assignments/${id}/end`, {
      method: "POST",
      body: JSON.stringify({ effectiveFrom }),
    }),

  getEmployeeOrgAssignmentHistory: (id: string) =>
    request<EmployeeOrgAssignmentVersionView[]>(`/organization/employee-assignments/${id}/history`),

  listOrgRelationships: (filters?: {
    employeeId?: string;
    managerEmployeeId?: string;
    relationshipType?: OrgRelationshipType;
    status?: OrgRelationshipStatus;
  }) => {
    const params = new URLSearchParams();
    if (filters?.employeeId) params.set("employeeId", filters.employeeId);
    if (filters?.managerEmployeeId) params.set("managerEmployeeId", filters.managerEmployeeId);
    if (filters?.relationshipType) params.set("relationshipType", filters.relationshipType);
    if (filters?.status) params.set("status", filters.status);
    const qs = params.toString();
    return request<OrgRelationshipView[]>(`/organization/relationships${qs ? `?${qs}` : ""}`);
  },

  getOrgRelationship: (id: string) => request<OrgRelationshipView>(`/organization/relationships/${id}`),

  createOrgRelationship: (input: CreateOrgRelationshipRequest) =>
    request<OrgRelationshipView>("/organization/relationships", { method: "POST", body: JSON.stringify(input) }),

  updateOrgRelationship: (id: string, patch: UpdateOrgRelationshipRequest) =>
    request<OrgRelationshipView>(`/organization/relationships/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  endOrgRelationship: (id: string, effectiveFrom?: string) =>
    request<OrgRelationshipView>(`/organization/relationships/${id}/end`, {
      method: "POST",
      body: JSON.stringify({ effectiveFrom }),
    }),

  getOrgRelationshipHistory: (id: string) =>
    request<OrgRelationshipVersionView[]>(`/organization/relationships/${id}/history`),

  // --- Organization Management, Phase 4
  // (0073_locations_and_financial_centers.sql) -----------------------------
  // Location hierarchy (LocationsPage.tsx — a tree explorer, exactly
  // OrgHierarchyPage.tsx's own shape) and Cost/Profit Centers
  // (FinancialCentersPage.tsx — two flat catalogs, exactly JobsPage.tsx's
  // own shape), the same "list/tree is the page's data source, the rest
  // back its actions" convention every prior phase's calls established.
  getLocationTree: () => request<LocationTreeNode[]>("/organization/locations/tree"),

  listLocations: () => request<LocationView[]>("/organization/locations"),

  getLocation: (id: string) => request<LocationView>(`/organization/locations/${id}`),

  createLocation: (input: CreateLocationRequest) =>
    request<LocationView>("/organization/locations", { method: "POST", body: JSON.stringify(input) }),

  updateLocation: (id: string, patch: UpdateLocationRequest) =>
    request<LocationView>(`/organization/locations/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  moveLocation: (id: string, input: MoveLocationRequest) =>
    request<LocationView>(`/organization/locations/${id}/move`, { method: "POST", body: JSON.stringify(input) }),

  archiveLocation: (id: string) => request<LocationView>(`/organization/locations/${id}/archive`, { method: "POST" }),

  activateLocation: (id: string) => request<LocationView>(`/organization/locations/${id}/activate`, { method: "POST" }),

  getLocationHistory: (id: string) => request<LocationVersionView[]>(`/organization/locations/${id}/history`),

  listCostCenters: () => request<CostCenterView[]>("/organization/cost-centers"),

  getCostCenter: (id: string) => request<CostCenterView>(`/organization/cost-centers/${id}`),

  createCostCenter: (input: CreateCostCenterRequest) =>
    request<CostCenterView>("/organization/cost-centers", { method: "POST", body: JSON.stringify(input) }),

  updateCostCenter: (id: string, patch: UpdateCostCenterRequest) =>
    request<CostCenterView>(`/organization/cost-centers/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  archiveCostCenter: (id: string) => request<CostCenterView>(`/organization/cost-centers/${id}/archive`, { method: "POST" }),

  activateCostCenter: (id: string) => request<CostCenterView>(`/organization/cost-centers/${id}/activate`, { method: "POST" }),

  getCostCenterHistory: (id: string) => request<CostCenterVersionView[]>(`/organization/cost-centers/${id}/history`),

  listProfitCenters: () => request<ProfitCenterView[]>("/organization/profit-centers"),

  getProfitCenter: (id: string) => request<ProfitCenterView>(`/organization/profit-centers/${id}`),

  createProfitCenter: (input: CreateProfitCenterRequest) =>
    request<ProfitCenterView>("/organization/profit-centers", { method: "POST", body: JSON.stringify(input) }),

  updateProfitCenter: (id: string, patch: UpdateProfitCenterRequest) =>
    request<ProfitCenterView>(`/organization/profit-centers/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  archiveProfitCenter: (id: string) =>
    request<ProfitCenterView>(`/organization/profit-centers/${id}/archive`, { method: "POST" }),

  activateProfitCenter: (id: string) =>
    request<ProfitCenterView>(`/organization/profit-centers/${id}/activate`, { method: "POST" }),

  getProfitCenterHistory: (id: string) => request<ProfitCenterVersionView[]>(`/organization/profit-centers/${id}/history`),

  // --- Organization Management Phase 5: Reorganization workflow -------------
  listOrgChanges: () => request<OrgChangeView[]>("/organization/reorganizations"),

  getOrgChange: (id: string) => request<OrgChangeView>(`/organization/reorganizations/${id}`),

  createOrgChange: (input: CreateOrgChangeRequest) =>
    request<OrgChangeView>("/organization/reorganizations", { method: "POST", body: JSON.stringify(input) }),

  validateOrgChange: (id: string) =>
    request<OrgChangeValidationResult>(`/organization/reorganizations/${id}/validate`, { method: "POST" }),

  analyzeOrgChangeImpact: (id: string) =>
    request<OrgChangeImpactSummary>(`/organization/reorganizations/${id}/impact`, { method: "POST" }),

  submitOrgChangeForApproval: (id: string) =>
    request<OrgChangeView>(`/organization/reorganizations/${id}/submit`, { method: "POST" }),

  decideOrgChange: (id: string, dto: { decision: "approved" | "rejected"; comment?: string }) =>
    request<OrgChangeView>(`/organization/reorganizations/${id}/decide`, { method: "POST", body: JSON.stringify(dto) }),

  executeOrgChange: (id: string) => request<OrgChangeView>(`/organization/reorganizations/${id}/execute`, { method: "POST" }),

  // --- Organization Management Phase 6: Command Center panel ----------------
  getOrganizationCommandCenterSummary: () =>
    request<OrganizationCommandCenterSummary>("/organization/command-center"),

  // --- Organization Management Phase 12: Legacy Data Reconciliation ---------
  getLegacyReconciliationReport: () =>
    request<LegacyReconciliationReport>("/organization/legacy-reconciliation"),

  linkLegacyOrgUnit: (employeeId: string, orgUnitId: string) =>
    request<EmployeeView>(`/organization/legacy-reconciliation/${employeeId}/link-org-unit`, {
      method: "POST",
      body: JSON.stringify({ orgUnitId }),
    }),

  linkLegacyLocation: (employeeId: string, locationId: string) =>
    request<EmployeeView>(`/organization/legacy-reconciliation/${employeeId}/link-location`, {
      method: "POST",
      body: JSON.stringify({ locationId }),
    }),

  linkLegacyManagerRelationship: (employeeId: string) =>
    request<void>(`/organization/legacy-reconciliation/${employeeId}/link-manager-relationship`, { method: "POST" }),

  // --- Employee Groups & Leave Policies (Task #49) --------------------------
  // Admin Center's own screen for the Phase 8 resolver: the API already
  // decides who matches which group and which policy wins (most-specific
  // match, safe-deny default) — this is purely CRUD + assignment against
  // employee_group.manage/leave_policy.manage, exactly as those two gates
  // are split server-side in EmployeeGroupsService.
  listEmployeeGroups: () => request<EmployeeGroupView[]>("/employee-groups"),

  createEmployeeGroup: (input: CreateEmployeeGroupRequest) =>
    request<EmployeeGroupView>("/employee-groups", { method: "POST", body: JSON.stringify(input) }),

  updateEmployeeGroup: (id: string, patch: UpdateEmployeeGroupRequest) =>
    request<EmployeeGroupView>(`/employee-groups/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  deleteEmployeeGroup: (id: string) => request<void>(`/employee-groups/${id}`, { method: "DELETE" }),

  assignGroupPolicy: (groupId: string, input: AssignGroupPolicyRequest) =>
    request<EmployeeGroupPolicyAssignmentView>(`/employee-groups/${groupId}/policy-assignments`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  unassignGroupPolicy: (groupId: string, policyType: PolicyType) =>
    request<void>(`/employee-groups/${groupId}/policy-assignments/${policyType}`, { method: "DELETE" }),

  listLeavePolicies: () => request<LeavePolicyView[]>("/leave-policies"),

  createLeavePolicy: (input: CreateLeavePolicyRequest) =>
    request<LeavePolicyView>("/leave-policies", { method: "POST", body: JSON.stringify(input) }),

  updateLeavePolicy: (id: string, patch: UpdateLeavePolicyRequest) =>
    request<LeavePolicyView>(`/leave-policies/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  deleteLeavePolicy: (id: string) => request<void>(`/leave-policies/${id}`, { method: "DELETE" }),

  getLeavePolicyHistory: (id: string) => request<LeavePolicyVersionView[]>(`/leave-policies/${id}/history`),

  resolvedPolicy: (employeeId: string, policyType: PolicyType = "leave") =>
    request<ResolvedPolicyView>(`/employees/${employeeId}/resolved-policy?policyType=${policyType}`),

  // --- Shift Management (0026_shift_management.sql) ---------------------
  listShifts: () => request<ShiftView[]>("/shifts"),

  createShift: (input: CreateShiftRequest) =>
    request<ShiftView>("/shifts", { method: "POST", body: JSON.stringify(input) }),

  updateShift: (id: string, patch: UpdateShiftRequest) =>
    request<ShiftView>(`/shifts/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  assignShift: (input: AssignShiftRequest) =>
    request<ShiftAssignmentView>("/shift-assignments", { method: "POST", body: JSON.stringify(input) }),

  getEmployeeShift: (employeeId: string) =>
    request<ShiftAssignmentView | null>(`/employees/${employeeId}/shift`),

  getEmployeeShiftHistory: (employeeId: string) =>
    request<ShiftAssignmentView[]>(`/employees/${employeeId}/shift-history`),

  // --- Work Schedule & Employee Schedule Assignment Architecture ---------
  // (0037_work_schedule.sql, shipped 2026-09-18) — the Configuration UI
  // half (WS-022–024) these three calls exist for was the only piece of
  // that increment still frontend-less; see the roadmap's own Part 4
  // entry for this UI increment for the full reasoning.
  getWeeklyPattern: (shiftId: string) => request<WorkScheduleDayView[]>(`/shifts/${shiftId}/weekly-pattern`),

  setWeeklyPattern: (shiftId: string, input: SetWeeklyPatternRequest) =>
    request<WorkScheduleDayView[]>(`/shifts/${shiftId}/weekly-pattern`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),

  listAssignmentRules: () => request<WorkScheduleAssignmentRuleView[]>("/shift-assignment-rules"),

  createAssignmentRule: (input: CreateWorkScheduleAssignmentRuleRequest) =>
    request<WorkScheduleAssignmentRuleView>("/shift-assignment-rules", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  updateAssignmentRule: (id: string, patch: UpdateWorkScheduleAssignmentRuleRequest) =>
    request<WorkScheduleAssignmentRuleView>(`/shift-assignment-rules/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteAssignmentRule: (id: string) => request<void>(`/shift-assignment-rules/${id}`, { method: "DELETE" }),

  getEmployeeWorkSchedule: (employeeId: string, date?: string) =>
    request<ResolvedWorkScheduleView>(`/employees/${employeeId}/work-schedule${date ? `?date=${date}` : ""}`),

  // --- Holiday Management (0030_holiday_management.sql) ------------------
  // Unlike Shift Management's self/team/all split, there's a single view
  // permission here (holiday.view.all) granted broadly to every role —
  // the calendar is non-sensitive, company-wide data everyone sees.
  listHolidays: (year?: string) => request<HolidayView[]>(`/holidays${year ? `?year=${year}` : ""}`),

  createHoliday: (input: CreateHolidayRequest) =>
    request<HolidayView>("/holidays", { method: "POST", body: JSON.stringify(input) }),

  updateHoliday: (id: string, patch: UpdateHolidayRequest) =>
    request<HolidayView>(`/holidays/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  deleteHoliday: (id: string) => request<void>(`/holidays/${id}`, { method: "DELETE" }),

  // --- Onboarding & Offboarding (0035_onboarding_offboarding.sql) --------
  // Gated on the existing `recruitment`/`exit` module entitlements
  // respectively — see OnboardingService/OffboardingService's own header
  // comments for why. Deliberately two parallel sets of calls (not one
  // generic "checklist" client, mirroring the two separate NestJS
  // controllers/services these both call into).
  listOnboardingItemTemplates: () => request<OnboardingItemTemplateView[]>("/onboarding/item-templates"),

  createOnboardingItemTemplate: (input: CreateOnboardingItemTemplateRequest) =>
    request<OnboardingItemTemplateView>("/onboarding/item-templates", { method: "POST", body: JSON.stringify(input) }),

  updateOnboardingItemTemplate: (id: string, patch: UpdateOnboardingItemTemplateRequest) =>
    request<OnboardingItemTemplateView>(`/onboarding/item-templates/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deactivateOnboardingItemTemplate: (id: string) =>
    request<OnboardingItemTemplateView>(`/onboarding/item-templates/${id}/deactivate`, { method: "PATCH" }),

  listOnboardingInProgress: () => request<EmployeeOnboardingView[]>("/onboarding"),

  initiateOnboarding: (employeeId: string) =>
    request<EmployeeOnboardingView>(`/employees/${employeeId}/onboarding`, { method: "POST" }),

  getOnboardingForEmployee: (employeeId: string) =>
    request<EmployeeOnboardingView | null>(`/employees/${employeeId}/onboarding`),

  updateOnboardingItem: (itemId: string, input: UpdateChecklistItemRequest) =>
    request<OnboardingChecklistItemView>(`/onboarding-items/${itemId}`, { method: "PATCH", body: JSON.stringify(input) }),

  listOffboardingItemTemplates: () => request<OffboardingItemTemplateView[]>("/offboarding/item-templates"),

  createOffboardingItemTemplate: (input: CreateOffboardingItemTemplateRequest) =>
    request<OffboardingItemTemplateView>("/offboarding/item-templates", { method: "POST", body: JSON.stringify(input) }),

  updateOffboardingItemTemplate: (id: string, patch: UpdateOffboardingItemTemplateRequest) =>
    request<OffboardingItemTemplateView>(`/offboarding/item-templates/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deactivateOffboardingItemTemplate: (id: string) =>
    request<OffboardingItemTemplateView>(`/offboarding/item-templates/${id}/deactivate`, { method: "PATCH" }),

  listOffboardingInProgress: () => request<EmployeeOffboardingView[]>("/offboarding"),

  initiateOffboarding: (employeeId: string, input: InitiateOffboardingRequest) =>
    request<EmployeeOffboardingView>(`/employees/${employeeId}/offboarding`, { method: "POST", body: JSON.stringify(input) }),

  getOffboardingForEmployee: (employeeId: string) =>
    request<EmployeeOffboardingView | null>(`/employees/${employeeId}/offboarding`),

  updateOffboardingItem: (itemId: string, input: UpdateChecklistItemRequest) =>
    request<OffboardingChecklistItemView>(`/offboarding-items/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  completeOffboarding: (employeeId: string) =>
    request<EmployeeOffboardingView>(`/employees/${employeeId}/offboarding/complete`, { method: "POST" }),

  // --- Configuration Center (0032_configuration_center.sql) --------------
  // Server-side filtered to domains this caller actually has view/manage
  // access to — a card missing here means the real permission check on
  // that domain's own service failed, not that this endpoint hid it.
  getConfigurationCenterSummary: () => request<ConfigurationDomainSummary[]>("/configuration-center"),

  // --- Leave & Attendance (Task #50) -----------------------------------
  // listLeaveRequests() is the same "server already RBAC-scopes it" shape
  // as listEmployees()/listEmployeeGroups() — hr_admin (view.all),
  // line_manager (view.team), employee_self_service (view.self) all call
  // this identical endpoint and render whatever comes back.
  listLeaveRequests: (employeeId?: string) =>
    request<LeaveRequestView[]>(`/leave-requests${employeeId ? `?employeeId=${employeeId}` : ""}`),

  submitLeaveRequest: (input: SubmitLeaveRequestRequest) =>
    request<SubmitLeaveRequestResponse>("/leave-requests", { method: "POST", body: JSON.stringify(input) }),

  // Who is actually allowed to decide a given request is entirely
  // workflow-routing-determined server-side (LeaveRequestsService.decide()'s
  // own doc comment) — this call is offered to any pending row the UI
  // shows and a real 403 is the honest answer for a non-approver, exactly
  // like every other cosmetically-gated action in this portal.
  decideLeaveRequest: (id: string, input: DecideLeaveRequestRequest) =>
    request<LeaveRequestView>(`/leave-requests/${id}/decision`, { method: "PATCH", body: JSON.stringify(input) }),

  cancelLeaveRequest: (id: string) => request<void>(`/leave-requests/${id}/cancel`, { method: "POST" }),

  getLeaveBalances: (employeeId: string) =>
    request<LeaveBalanceView[]>(`/employees/${employeeId}/leave-balances`),

  clockIn: (input: ClockInRequest) =>
    request<AttendanceRecordView>("/attendance/clock-in", { method: "POST", body: JSON.stringify(input) }),

  clockOut: (input: ClockOutRequest) =>
    request<AttendanceRecordView>("/attendance/clock-out", { method: "POST", body: JSON.stringify(input) }),

  listAttendance: (employeeId: string) =>
    request<AttendanceRecordView[]>(`/employees/${employeeId}/attendance`),

  submitAttendanceCorrection: (input: SubmitAttendanceCorrectionRequest) =>
    request<AttendanceCorrectionRequestView>("/attendance-corrections", { method: "POST", body: JSON.stringify(input) }),

  listPendingAttendanceCorrections: () =>
    request<AttendanceCorrectionRequestView[]>("/attendance-corrections/pending"),

  decideAttendanceCorrection: (id: string, input: DecideAttendanceCorrectionRequest) =>
    request<AttendanceCorrectionRequestView>(`/attendance-corrections/${id}/decision`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  listAttendanceCorrections: (employeeId: string) =>
    request<AttendanceCorrectionRequestView[]>(`/employees/${employeeId}/attendance-corrections`),

  // --- Recruitment (Task #51) -------------------------------------------
  // recruitment.manage.all is a single scope-less permission granted only
  // to hr_admin (0018_recruitment_seed.sql — no .self/.team split exists
  // here, and no candidate login ever exists), so unlike Leave/Employee
  // Core there is no RBAC-driven view variance for these endpoints to
  // account for: every call below is HR-Admin-only in practice, and the
  // frontend renders a single screen rather than a per-role variant.
  createRequisition: (input: CreateJobRequisitionRequest) =>
    request<JobRequisitionView>("/job-requisitions", { method: "POST", body: JSON.stringify(input) }),

  listRequisitions: () => request<JobRequisitionView[]>("/job-requisitions"),

  getRequisition: (id: string) => request<JobRequisitionView>(`/job-requisitions/${id}`),

  submitRequisition: (id: string) =>
    request<JobRequisitionView>(`/job-requisitions/${id}/submit`, { method: "POST" }),

  // Reuses the same {decision, comment?} shape as decideLeaveRequest —
  // RecruitmentController's own doc comment confirms it reuses
  // DecideLeaveRequestDto server-side rather than a near-identical DTO.
  // Routing is workflow-determined server-side (same
  // workflow_template.manage.all gap flagged in Decision #18 blocks this
  // too, since no "job_requisition" template exists for a real tenant
  // today), so this call is offered on any pending_approval row and a
  // real 403/404 is the honest answer when routing isn't configured.
  decideRequisition: (id: string, input: DecideLeaveRequestRequest) =>
    request<JobRequisitionView>(`/job-requisitions/${id}/decision`, { method: "PATCH", body: JSON.stringify(input) }),

  createCandidate: (input: CreateCandidateRequest) =>
    request<CandidateView>("/candidates", { method: "POST", body: JSON.stringify(input) }),

  listCandidates: () => request<CandidateView[]>("/candidates"),

  createApplication: (input: CreateApplicationRequest) =>
    request<ApplicationView>("/applications", { method: "POST", body: JSON.stringify(input) }),

  listApplications: (requisitionId?: string) =>
    request<ApplicationView[]>(`/applications${requisitionId ? `?requisitionId=${requisitionId}` : ""}`),

  // moveApplicationStage() is forward-only server-side (FORWARD_STAGES)
  // and explicitly refuses a direct move to "hired" — decideOffer(...,
  // "accepted") is the only path that reaches "hired". The UI only needs
  // to offer the buttons that make sense for the current stage; the
  // server is what actually enforces the rest.
  moveApplicationStage: (id: string, stage: ApplicationStage) =>
    request<ApplicationView>(`/applications/${id}/stage`, {
      method: "PATCH",
      body: JSON.stringify({ stage } satisfies MoveApplicationStageRequest),
    }),

  extendOffer: (input: ExtendOfferRequest) =>
    request<OfferView>("/offers", { method: "POST", body: JSON.stringify(input) }),

  rescindOffer: (id: string) => request<OfferView>(`/offers/${id}/rescind`, { method: "POST" }),

  // On "accepted" this creates a real Employee record (with a real
  // Employee Number) server-side in a separate transaction from the
  // offer/application status update — DecideOfferResponse.employee is
  // non-null only in that case, which is what the Pipeline UI uses to
  // show a "hired as employee #..." confirmation rather than assuming.
  decideOffer: (id: string, decision: "accepted" | "declined") =>
    request<DecideOfferResponse>(`/offers/${id}/decision`, { method: "PATCH", body: JSON.stringify({ decision }) }),

  // --- Task #52 (Decision #20): System Admin — workflow templates + role assignment ---

  // Any real session holding workflow_template.manage.all — today only
  // system_admin (see 0024_system_admin.sql; rbac_demo_full_access still
  // holds it too, but that's Phase 4 test scaffolding, never assigned to
  // a real company).
  listWorkflowTemplates: () => request<WorkflowTemplate[]>("/workflow/templates"),

  createWorkflowTemplate: (input: CreateWorkflowTemplateRequest) =>
    request<WorkflowTemplate>("/workflow/templates", { method: "POST", body: JSON.stringify(input) }),

  // The real tenant role catalog (4 roles), for resolving a roleId for a
  // "role" approver step — see SystemAdminService.listAssignableRoles()'s
  // own comment on why this can't just be a hardcoded list client-side.
  listAssignableRoles: () => request<Role[]>("/system-admin/roles"),

  listAssignableUsers: () => request<AssignableUserView[]>("/system-admin/assignable-users"),

  listSystemAdminRoleAssignments: () => request<SystemAdminRoleAssignmentView[]>("/system-admin/role-assignments"),

  assignSystemAdminRole: (input: AssignSystemAdminRoleRequest) =>
    request<SystemAdminRoleAssignmentView>("/system-admin/role-assignments", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  revokeSystemAdminRole: (id: string) =>
    request<{ message: string }>(`/system-admin/role-assignments/${id}`, { method: "DELETE" }),

  // --- Task #53 (Performance & Goals, Phase 11) ---
  // Review Cycles
  listReviewCycles: () => request<ReviewCycleView[]>("/review-cycles"),

  getReviewCycle: (id: string) => request<ReviewCycleView>(`/review-cycles/${id}`),

  createReviewCycle: (input: CreateReviewCycleRequest) =>
    request<ReviewCycleView>("/review-cycles", { method: "POST", body: JSON.stringify(input) }),

  launchReviewCycle: (id: string) =>
    request<ReviewCycleView>(`/review-cycles/${id}/launch`, { method: "POST" }),

  beginCalibration: (id: string) =>
    request<ReviewCycleView>(`/review-cycles/${id}/begin-calibration`, { method: "POST" }),

  closeReviewCycle: (id: string) =>
    request<{ cycle: ReviewCycleView; releasedCount: number }>(`/review-cycles/${id}/close`, { method: "POST" }),

  getRatingDistribution: (cycleId: string) =>
    request<RatingDistributionView>(`/review-cycles/${cycleId}/rating-distribution`),

  // Goals
  listGoals: (params?: { reviewCycleId?: string; employeeId?: string }) =>
    request<GoalView[]>(`/goals${params ? `?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]).toString()}` : ""}`),

  createGoal: (input: CreateGoalRequest) =>
    request<GoalView>("/goals", { method: "POST", body: JSON.stringify(input) }),

  updateGoal: (id: string, patch: UpdateGoalRequest) =>
    request<GoalView>(`/goals/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  // Performance Reviews
  listPerformanceReviews: (params?: { reviewCycleId?: string; employeeId?: string }) =>
    request<PerformanceReviewView[]>(`/performance-reviews${params ? `?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]).toString()}` : ""}`),

  getPerformanceReview: (id: string) => request<PerformanceReviewView>(`/performance-reviews/${id}`),

  submitSelfAssessment: (id: string, input: SubmitSelfAssessmentRequest) =>
    request<PerformanceReviewView>(`/performance-reviews/${id}/self-assessment`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  submitManagerAssessment: (id: string, input: SubmitManagerAssessmentRequest) =>
    request<PerformanceReviewView>(`/performance-reviews/${id}/manager-assessment`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  calibrateReview: (id: string, input: CalibrateReviewRequest) =>
    request<PerformanceReviewView>(`/performance-reviews/${id}/calibrate`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  // --- Phase 12 (Compensation & Payroll, Decision #14) ---------------------
  // `payroll.manage.all` (hr_admin) gates compensation/settings/tax-slabs/
  // run-lifecycle writes; `payroll_review.view.self` (employee_self_service)
  // only ever sees their own payslip, and only once its run is finalized —
  // enforced entirely server-side (PayrollService.listPayslips/getPayslip),
  // same "server already scopes it" posture as every other module here.
  setCompensation: (input: SetCompensationRequest) =>
    request<CompensationView>("/payroll/compensation", { method: "POST", body: JSON.stringify(input) }),

  getCompensationHistory: (employeeId: string) =>
    request<CompensationView[]>(`/payroll/compensation/${employeeId}`),

  getPayrollSettings: () => request<PayrollSettingsView>("/payroll/settings"),

  updatePayrollSettings: (patch: UpdatePayrollSettingsRequest) =>
    request<PayrollSettingsView>("/payroll/settings", { method: "PATCH", body: JSON.stringify(patch) }),

  listTaxSlabs: () => request<TaxSlabView[]>("/payroll/tax-slabs"),

  setTaxSlabs: (input: SetTaxSlabsRequest) =>
    request<TaxSlabView[]>("/payroll/tax-slabs", { method: "POST", body: JSON.stringify(input) }),

  getTaxSlabHistory: () => request<TaxSlabSetView[]>("/payroll/tax-slabs/history"),

  listPayrollRuns: () => request<PayrollRunView[]>("/payroll/runs"),

  getPayrollRun: (id: string) => request<PayrollRunView>(`/payroll/runs/${id}`),

  createPayrollRun: (input: CreatePayrollRunRequest) =>
    request<PayrollRunView>("/payroll/runs", { method: "POST", body: JSON.stringify(input) }),

  // Re-runnable while draft/calculated (fully replaces that run's
  // payslips each time); refused once finalized — PayrollService.calculateRun()'s
  // own rule, not re-validated client-side.
  calculatePayrollRun: (id: string) =>
    request<CalculatePayrollRunResponse>(`/payroll/runs/${id}/calculate`, { method: "POST" }),

  finalizePayrollRun: (id: string) =>
    request<PayrollRunView>(`/payroll/runs/${id}/finalize`, { method: "POST" }),

  listPayslips: (params?: { payrollRunId?: string; employeeId?: string }) =>
    request<PayslipView[]>(
      `/payslips${
        params
          ? `?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]).toString()}`
          : ""
      }`
    ),

  getPayslip: (id: string) => request<PayslipView>(`/payslips/${id}`),

  // The one non-JSON endpoint in this client — GET /payroll/runs/:id/disbursement
  // streams a CSV (Content-Disposition: attachment), not a JSON body, so
  // it can't go through the shared `request()` helper. Triggers a real
  // browser download rather than returning the text, since that's the
  // only thing an HR Admin actually wants to do with a bank file.
  async downloadDisbursementFile(runId: string): Promise<void> {
    const token = getToken();
    const res = await fetch(`/api/payroll/runs/${runId}/disbursement`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        const body = await res.json();
        message = body.message ?? message;
      } catch {
        // not JSON — keep the generic message
      }
      throw new ApiError(res.status, message);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `payroll-disbursement-${runId}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },
};
