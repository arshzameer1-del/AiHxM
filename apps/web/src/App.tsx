import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import {
  ProtectedRoute,
  RequirePlatformAdmin,
  RequireTenant,
} from "./components/ProtectedRoute";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/LoginPage";
import { SignupPage } from "./pages/SignupPage";
import { PortalLayout } from "./portal/PortalLayout";
import { PortalHomePage } from "./portal/PortalHomePage";

/**
 * Phase 14: every route below this point used to be a top-level import,
 * so a first-time visitor's initial bundle carried the full Platform
 * Provisioning Panel AND the full tenant portal — Recruitment's Kanban
 * board, Performance's four review-cycle panels, System Admin — even
 * though any one session only ever uses the routes its role can reach
 * (RequirePlatformAdmin/RequireTenant already split sessions into two
 * disjoint groups that never render both trees). `React.lazy` turns each
 * route into its own chunk, fetched on first navigation instead of on
 * every login; see `docs/performance-caching-strategy.md` for the
 * before/after bundle size this produced.
 *
 * LoginPage and PortalHomePage stay eager: LoginPage is what every
 * unauthenticated visit renders first (lazy-loading the very first
 * screen just adds a network round trip before anything paints), and
 * PortalHomePage is the tenant portal's own landing route, reached by
 * the same fraction of sessions that reach PortalLayout at all.
 */
const DashboardPage = lazy(() =>
  import("./pages/DashboardPage").then((m) => ({ default: m.DashboardPage })),
);
const CreateCompanyPage = lazy(() =>
  import("./pages/CreateCompanyPage").then((m) => ({
    default: m.CreateCompanyPage,
  })),
);
const CompanyDetailPage = lazy(() =>
  import("./pages/CompanyDetailPage").then((m) => ({
    default: m.CompanyDetailPage,
  })),
);
const AuditLogPage = lazy(() =>
  import("./pages/AuditLogPage").then((m) => ({ default: m.AuditLogPage })),
);
const PlatformAdminsPage = lazy(() =>
  import("./pages/PlatformAdminsPage").then((m) => ({
    default: m.PlatformAdminsPage,
  })),
);
const PlatformBrandingPage = lazy(() =>
  import("./pages/PlatformBrandingPage").then((m) => ({
    default: m.PlatformBrandingPage,
  })),
);
const EmployeeListPage = lazy(() =>
  import("./portal/employees/EmployeeListPage").then((m) => ({
    default: m.EmployeeListPage,
  })),
);
const EmployeeCreatePage = lazy(() =>
  import("./portal/employees/EmployeeCreatePage").then((m) => ({
    default: m.EmployeeCreatePage,
  })),
);
const EmployeeDetailPage = lazy(() =>
  import("./portal/employees/EmployeeDetailPage").then((m) => ({
    default: m.EmployeeDetailPage,
  })),
);
const MyProfilePage = lazy(() =>
  import("./portal/employees/MyProfilePage").then((m) => ({
    default: m.MyProfilePage,
  })),
);
const AdminCenterPage = lazy(() =>
  import("./portal/admin/AdminCenterPage").then((m) => ({
    default: m.AdminCenterPage,
  })),
);
// Organization Management, Phase 1 — the Hierarchy Explorer, this
// product's first real tree/hierarchy UI. See
// claude/organization-management-4000-gap-analysis-and-roadmap.md and
// 0065_organization_units.sql.
const OrgHierarchyPage = lazy(() =>
  import("./portal/organization/OrgHierarchyPage").then((m) => ({
    default: m.OrgHierarchyPage,
  })),
);
// Organization Management, Phase 2 — Job Catalog (a setup screen) and
// Position Workbench (occupancy/lifecycle). See
// 0068_job_position_architecture.sql and jobs.service.ts's/
// positions.service.ts's own header comments.
const JobsPage = lazy(() =>
  import("./portal/organization/JobsPage").then((m) => ({
    default: m.JobsPage,
  })),
);
const PositionWorkbenchPage = lazy(() =>
  import("./portal/organization/PositionWorkbenchPage").then((m) => ({
    default: m.PositionWorkbenchPage,
  })),
);
const ConfigurationCenterPage = lazy(() =>
  import("./portal/admin/ConfigurationCenterPage").then((m) => ({
    default: m.ConfigurationCenterPage,
  })),
);
const LeavePage = lazy(() =>
  import("./portal/leave/LeavePage").then((m) => ({ default: m.LeavePage })),
);
const RecruitmentPage = lazy(() =>
  import("./portal/recruitment/RecruitmentPage").then((m) => ({
    default: m.RecruitmentPage,
  })),
);
const SystemAdminPage = lazy(() =>
  import("./portal/system-admin/SystemAdminPage").then((m) => ({
    default: m.SystemAdminPage,
  })),
);
const PerformancePage = lazy(() =>
  import("./portal/performance/PerformancePage").then((m) => ({
    default: m.PerformancePage,
  })),
);
const PayrollPage = lazy(() =>
  import("./portal/payroll/PayrollPage").then((m) => ({ default: m.PayrollPage })),
);
// Phase 3 item #1 (OIDC slice) — reached only once, right after an IdP
// redirect (SsoService.handleCallback's fixed `/sso/complete#...` landing
// point), never on a cold first visit like LoginPage — so unlike LoginPage
// this one follows the same lazy-chunk pattern as every other post-login
// route above.
const SsoCompletePage = lazy(() =>
  import("./pages/SsoCompletePage").then((m) => ({ default: m.SsoCompletePage })),
);

/** A route chunk is typically <50KB over a fast connection — a blank
 * beat, not a spinner-worthy wait — but Suspense requires a fallback,
 * and rendering nothing during that beat is worse than this. */
function RouteFallback() {
  return <div className="p-6 text-sm text-label-tertiary">Loading…</div>;
}

/**
 * Any URL this router doesn't otherwise recognize — including a plain
 * "/" visit before Decision #13, when it always meant the Platform Admin
 * dashboard. Now "home" depends on WHO is asking, so this reads the same
 * identity the route guards use rather than picking one portal by
 * default.
 */
function RootRedirect() {
  const { isAuthenticated, identity, identityLoading } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (identityLoading || !identity) return null;
  return <Navigate to={identity.isPlatformAdmin ? "/" : "/app"} replace />;
}

/**
 * Phase 2 built the Platform Provisioning Panel at the app's root paths
 * ("/", "/companies/...", etc). Decision #13 adds a second portal — the
 * tenant-facing Employee/ESS, Manager/MSS and HR Admin screens — under
 * "/app", rather than renumbering Phase 2's existing routes: both trees
 * sit side by side under one login/AuthProvider, and RequirePlatformAdmin/
 * RequireTenant (ProtectedRoute.tsx) keep a session out of the portal it
 * doesn't belong to.
 */
export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            {/* Per-company login URL (aihxm.com/leadhcm/login) — path-based
              rather than a tenant subdomain, since Netlify only supports
              wildcard custom domains on a paid plan it can't self-serve
              (see LoginPage.tsx's own doc comment). Reuses the exact same
              component; :companySlug is what switches it into tenant mode.
              A company's slug can never collide with "login", "signup",
              "app", etc. — CompaniesService.create()'s RESERVED_SLUGS
              blocklist enforces that at creation time, not here. */}
            <Route path="/:companySlug/login" element={<LoginPage />} />
            {/* Self-service signup (signup.controller.ts) — public, no
              ProtectedRoute, same tree level as /login. */}
            <Route path="/signup" element={<SignupPage />} />
            {/* Phase 3 item #1 (OIDC slice) — the fixed landing point every
              tenant's IdP redirect reaches (SsoService.handleCallback);
              public/no ProtectedRoute for the same reason /login is: a
              session doesn't exist yet when this renders, it's what
              CREATES one. */}
            <Route path="/sso/complete" element={<SsoCompletePage />} />

            <Route element={<ProtectedRoute />}>
              <Route element={<RequirePlatformAdmin />}>
                <Route element={<Layout />}>
                  <Route path="/" element={<DashboardPage />} />
                  <Route
                    path="/companies/new"
                    element={<CreateCompanyPage />}
                  />
                  <Route
                    path="/companies/:id"
                    element={<CompanyDetailPage />}
                  />
                  <Route path="/audit-log" element={<AuditLogPage />} />
                  <Route
                    path="/platform-admins"
                    element={<PlatformAdminsPage />}
                  />
                  <Route
                    path="/platform-branding"
                    element={<PlatformBrandingPage />}
                  />
                </Route>
              </Route>

              <Route path="/app" element={<RequireTenant />}>
                <Route element={<PortalLayout />}>
                  <Route index element={<PortalHomePage />} />
                  {/* Task #48 — Employee Core. My Profile is the
                    employee_self_service view of the same object the
                    other three routes show HR Admins/Managers; RBAC (not
                    a route guard) is what actually scopes each one. */}
                  <Route path="profile" element={<MyProfilePage />} />
                  <Route path="employees" element={<EmployeeListPage />} />
                  <Route
                    path="employees/new"
                    element={<EmployeeCreatePage />}
                  />
                  <Route
                    path="employees/:id"
                    element={<EmployeeDetailPage />}
                  />
                  {/* Organization Management Phase 1 — the Hierarchy
                    Explorer. org_unit.view.all/org_unit.manage.all (both
                    seeded in 0066) are the real gates, enforced server-
                    side; PortalLayout's nav gates it the same courtesy way
                    as every other route here. */}
                  <Route path="organization" element={<OrgHierarchyPage />} />
                  {/* Organization Management Phase 2 — Job Catalog +
                    Position Workbench. job.view.all/job.manage.all and
                    position.view.all/position.manage.all (both seeded in
                    0069) are the real gates; PortalLayout's nav gates
                    these the same courtesy way as every other route
                    here. */}
                  <Route path="organization/jobs" element={<JobsPage />} />
                  <Route path="organization/positions" element={<PositionWorkbenchPage />} />
                  {/* Task #49 — Admin Center. hr_admin-only in PortalLayout's
                    nav (a courtesy); EmployeeGroupsService's own
                    employee_group.manage/leave_policy.manage gates are the
                    real one, same split every portal screen follows. */}
                  <Route path="admin" element={<AdminCenterPage />} />
                  {/* Foundation gap — Configuration Center. A read-only
                    index over the config domains above plus Payroll's tax
                    slabs and System Admin's workflow templates;
                    ConfigurationCenterService filters cards server-side to
                    whatever this login can actually manage/view, the same
                    courtesy-nav pattern every other route here follows. */}
                  <Route path="configuration-center" element={<ConfigurationCenterPage />} />
                  {/* Task #50 — Leave & Attendance. Server-side RBAC/workflow
                    routing decides who can submit/decide/cancel what;
                    LeavePage renders one screen for every role, same
                    pattern as Task #48/#49. */}
                  <Route path="leave" element={<LeavePage />} />
                  {/* Task #51 — Recruitment. recruitment.manage.all is
                    hr_admin-only with no self/team scoping, so unlike
                    Leave/Employee Core there's no per-role rendering
                    here; PortalLayout's nav already keeps this route
                    hr_admin-only. */}
                  <Route path="recruitment" element={<RecruitmentPage />} />
                  {/* Task #52 (Decision #20) — System Admin. Gated the same
                    courtesy way as Admin Center: role_assignment.manage.all/
                    workflow_template.manage.all are the real gates,
                    enforced server-side; PortalLayout's nav keeps this
                    route system_admin-only. */}
                  <Route path="system-admin" element={<SystemAdminPage />} />
                  <Route path="performance" element={<PerformancePage />} />
                  {/* Task — Payroll (Phase 12, Decision #14). Same
                    server-scopes-it split as Leave/Performance: hr_admin
                    gets the full run lifecycle, employee_self_service
                    gets only their own finalized payslips, both from this
                    one route. */}
                  <Route path="payroll" element={<PayrollPage />} />
                </Route>
              </Route>
            </Route>

            <Route path="*" element={<RootRedirect />} />
          </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  );
}
