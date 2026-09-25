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
  PolicyType,
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
  DataExportFormat,
  DataExportScope,
  DomainAvailabilityResult,
  PackageTierSummary,
  TestInvitationResult,
  TenantBackup,
  TenantDataExport,
  SystemAdminRoleAssignmentView,
  TaxSlabSetView,
  TaxSlabView,
  TenantConfigurationSetting,
  TenantConfigurationVersion,
  TenantFeatureEntitlement,
  TenantIntegration,
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
  constructor(public status: number, message: string) {
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
    try {
      const body = await res.json();
      message = body.message ?? message;
    } catch {
      // response body wasn't JSON — keep the generic message
    }
    throw new ApiError(res.status, Array.isArray(message) ? message.join(", ") : message);
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

  // --- Platform Admins ------------------------------------------------------
  listPlatformAdmins: () => request<PlatformAdmin[]>("/platform/admins"),

  createPlatformAdmin: (input: CreatePlatformAdminRequest) =>
    request<PlatformAdmin>("/platform/admins", { method: "POST", body: JSON.stringify(input) }),

  setPlatformAdminStatus: (id: string, status: PlatformAdmin["status"]) =>
    request<PlatformAdmin>(`/platform/admins/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),

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
  requestCompanyDeletion: (id: string, input: { reason: string; graceDays?: number }) =>
    request<Company>(`/platform/companies/${id}/deletion-request`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  cancelCompanyDeletion: (id: string) =>
    request<Company>(`/platform/companies/${id}/deletion-request`, { method: "DELETE" }),

  // TM-003 — saved, reusable Tenant Directory filter combinations.
  listSavedViews: () => request<PlatformSavedView[]>("/platform/saved-views"),

  createSavedView: (name: string, filters: CompanyListFilters) =>
    request<PlatformSavedView>("/platform/saved-views", {
      method: "POST",
      body: JSON.stringify({ name, filters }),
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

  // TM-032 — Health dashboard.
  getHealth: (companyId: string) => request<HealthCheckResult[]>(`/platform/companies/${companyId}/health`),

  runHealthCheck: (companyId: string) =>
    request<HealthCheckResult[]>(`/platform/companies/${companyId}/health/check`, { method: "POST" }),

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

  requestDataExport: (companyId: string, dto: { scope: DataExportScope; format: DataExportFormat }) =>
    request<TenantDataExport>(`/platform/companies/${companyId}/exports`, {
      method: "POST",
      body: JSON.stringify(dto),
    }),

  async downloadDataExport(companyId: string, exportId: string, fileName: string): Promise<void> {
    const token = getToken();
    const res = await fetch(`/api/platform/companies/${companyId}/exports/${exportId}/download`, {
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

  impersonate: (id: string) =>
    request<ImpersonateResponse>(`/platform/companies/${id}/impersonate`, { method: "POST" }),

  listAuditLog: (companyId?: string) =>
    request<AuditLogEntry[]>(`/platform/audit-log${companyId ? `?companyId=${companyId}` : ""}`),

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
