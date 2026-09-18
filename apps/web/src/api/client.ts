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
  HolidayView,
  ConfigurationDomainSummary,
  ImpersonateResponse,
  InitiateOffboardingRequest,
  JobHistoryEntryView,
  JobRequisitionView,
  LeaveBalanceView,
  LeavePolicyVersionView,
  LeavePolicyView,
  LeaveRequestView,
  LoginResult,
  MeResponse,
  ModuleKey,
  MoveApplicationStageRequest,
  OffboardingChecklistItemView,
  OffboardingItemTemplateView,
  OfferView,
  OnboardingChecklistItemView,
  OnboardingItemTemplateView,
  PasswordResetRequestResult,
  PayrollRunView,
  PayrollSettingsView,
  PayslipView,
  PerformanceReviewView,
  PlatformAdmin,
  PolicyType,
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
  SystemAdminRoleAssignmentView,
  TaxSlabSetView,
  TaxSlabView,
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
  WorkflowTemplate,
  WorkScheduleAssignmentRuleView,
  WorkScheduleDayView,
  CreateWorkScheduleAssignmentRuleRequest,
} from "@boostfactor/shared-types";

const TOKEN_KEY = "boostfactor.platformAdminToken";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
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

  listCompanies: () => request<CompanyDashboardRow[]>("/platform/companies"),

  createCompany: (input: CreateCompanyRequest) =>
    request<CompanyDetail>("/platform/companies", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  getCompany: (id: string) => request<CompanyDetail>(`/platform/companies/${id}`),

  updateCompanyStatus: (id: string, status: Company["status"]) =>
    request<Company>(`/platform/companies/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),

  updateCompanyConfig: (
    id: string,
    patch: {
      branding?: CompanyConfig["branding"];
      enabledModules?: ModuleKey[];
      employeeNumberFormat?: Partial<EmployeeNumberFormat>;
    }
  ) =>
    request<CompanyConfig>(`/platform/companies/${id}/config`, {
      method: "PATCH",
      body: JSON.stringify(patch),
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

  createAdminLogin: (id: string, adminId: string, initialPassword: string) =>
    request<CompanyAdmin>(`/platform/companies/${id}/admins/${adminId}/account`, {
      method: "POST",
      body: JSON.stringify({ initialPassword }),
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
