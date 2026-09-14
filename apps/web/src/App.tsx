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
                <Route
                  path="profile"
                  element={
                    <ComingSoonPage
                      title="My Profile"
                      description="View and update your own employee profile."
                    />
                  }
                />
                <Route
                  path="employees"
                  element={
                    <ComingSoonPage
                      title="Employees"
                      description="Employee list, profiles, and org chart for HR Admins and Managers."
                    />
                  }
                />
                <Route
                  path="admin"
                  element={
                    <ComingSoonPage
                      title="Admin Center"
                      description="Configure employee groups and leave policies for this company."
                    />
                  }
                />
                <Route
                  path="leave"
                  element={
                    <ComingSoonPage
                      title="Leave & Attendance"
                      description="Request, approve, and track leave and attendance."
                    />
                  }
                />
                <Route
                  path="recruitment"
                  element={
                    <ComingSoonPage
                      title="Recruitment"
                      description="Job requisitions, candidate pipeline, and offers."
                    />
                  }
                />
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
