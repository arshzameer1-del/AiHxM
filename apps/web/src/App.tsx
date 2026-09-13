import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { CreateCompanyPage } from "./pages/CreateCompanyPage";
import { CompanyDetailPage } from "./pages/CompanyDetailPage";
import { AuditLogPage } from "./pages/AuditLogPage";

/**
 * Phase 2: the Platform Provisioning Panel. Phase 1's /health hello-world
 * screen is gone — its job (proving the monorepo wires together) is done;
 * this is the actual first screen from the plan doc's Phase 2 scope.
 */
export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route element={<ProtectedRoute />}>
            <Route element={<Layout />}>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/companies/new" element={<CreateCompanyPage />} />
              <Route path="/companies/:id" element={<CompanyDetailPage />} />
              <Route path="/audit-log" element={<AuditLogPage />} />
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
