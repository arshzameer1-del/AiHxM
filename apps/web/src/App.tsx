import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { ProtectedRoute, RequirePlatformAdmin, RequireTenant } from "./components/ProtectedRoute";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { CreateCompanyPage } from "./pages/CreateCompanyPage";
import { CompanyDetailPage } from "./pages/CompanyDetailPage";
import { AuditLogPage } from "./pages/AuditLogPage";
import { PlatformAdminsPage } from "./pages/PlatformAdminsPage";
import { PortalLayout } from "./portal/PortalLayout";
import { PortalHomePage } from "./portal/PortalHomePage";
import { ComingSoonPage } from "./portal/ComingSoonPage";
import { EmployeeListPage } from "./portal/employees/EmployeeListPage";
import { EmployeeCreatePage } from "./portal/employees/EmployeeCreatePage";
import { EmployeeDetailPage } from "./portal/employees/EmployeeDetailPage";
import { MyProfilePage } from "./portal/employees/MyProfilePage";
import { AdminCenterPage } from "./portal/admin/AdminCenterPage";
import { LeavePage } from "./portal/leave/LeavePage";
import { RecruitmentPage } from "./portal/recruitment/RecruitmentPage";
import { SystemAdminPage } from "./portal/system-admin/SystemAdminPage";

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
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route element={<ProtectedRoute />}>
            <Route element={<RequirePlatformAdmin />}>
              <Route element={<Layout />}>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/companies/new" element={<CreateCompanyPage />} />
                <Route path="/companies/:id" element={<CompanyDetailPage />} />
                <Route path="/audit-log" element={<AuditLogPage />} />
                <Route path="/platform-admins" element={<PlatformAdminsPage />} />
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
                <Route path="employees/new" element={<EmployeeCreatePage />} />
                <Route path="employees/:id" element={<EmployeeDetailPage />} />
                {/* Task #49 — Admin Center. hr_admin-only in PortalLayout's
                    nav (a courtesy); EmployeeGroupsService's own
                    employee_group.manage/leave_policy.manage gates are the
                    real one, same split every portal screen follows. */}
                <Route path="admin" element={<AdminCenterPage />} />
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
                <Route
                  path="performance"
                  element={
                    <ComingSoonPage
                      title="Performance"
                      description="Review cycles, goals, assessments, and calibration."
                    />
                  }
                />
              </Route>
            </Route>
          </Route>

          <Route path="*" element={<RootRedirect />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
