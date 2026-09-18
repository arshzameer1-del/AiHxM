import { NavLink, Outlet } from "react-router-dom";
import type { ModuleKey, TenantRoleKey } from "@boostfactor/shared-types";
import { useAuth } from "../auth/AuthContext";

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `block px-3 py-2 rounded-lg text-sm font-medium ${
    isActive ? "bg-accent text-white" : "text-label-secondary hover:bg-black/5"
  }`;

type NavItem = { to: string; label: string; end?: boolean };

/**
 * Decision #13 — nav visibility is the union of every role this session
 * holds (a login can hold more than one — see `EmployeesService.createLogin()`),
 * further narrowed by which modules the company actually has entitled.
 * This mirrors, in the UI, the same "is the module even licensed -> can
 * the role touch this object" order the API itself enforces (plan doc
 * Section 4) — a hidden nav item here is a courtesy, not the real gate;
 * every one of these routes still goes through EntitlementsService/
 * RbacService server-side regardless of what this function decides to
 * show.
 */
function buildNavItems(roleKeys: TenantRoleKey[], enabledModules: ModuleKey[]): NavItem[] {
  const hasRole = (...keys: TenantRoleKey[]) => keys.some((k) => roleKeys.includes(k));
  const hasModule = (key: ModuleKey) => enabledModules.includes(key);

  const items: NavItem[] = [{ to: "/app", label: "Home", end: true }];

  if (hasRole("hr_admin", "line_manager") && hasModule("employee")) {
    items.push({ to: "/app/employees", label: "Employees" });
  } else if (roleKeys.length > 0 && hasModule("employee")) {
    items.push({ to: "/app/profile", label: "My Profile" });
  }

  // Configuration Center is a read-only index over config domains this
  // login can already reach some other way (Admin Center, System Admin,
  // Payroll Settings) — shown to the same roles that see at least one of
  // those, so it never promises a screen with nothing behind it.
  if (hasRole("hr_admin", "system_admin")) {
    items.push({ to: "/app/configuration-center", label: "Configuration Center" });
  }

  if (hasRole("hr_admin")) {
    items.push({ to: "/app/admin", label: "Admin Center" });
  }

  // Decision #20 — deliberately not module-gated: workflow/role
  // configuration is a core platform capability, not a licensed module,
  // same posture as Admin Center above.
  if (hasRole("system_admin")) {
    items.push({ to: "/app/system-admin", label: "System Admin" });
  }

  if (hasModule("leave") && roleKeys.length > 0) {
    items.push({ to: "/app/leave", label: "Leave & Attendance" });
  }

  if (hasRole("hr_admin") && hasModule("recruitment")) {
    items.push({ to: "/app/recruitment", label: "Recruitment" });
  }

  if (hasModule("performance") && roleKeys.length > 0) {
    items.push({ to: "/app/performance", label: "Performance" });
  }

  // Phase 12 (Decision #14) — 0023_payroll_seed.sql grants
  // `payroll.manage.all`/`payroll_review.view.self` only to hr_admin/
  // employee_self_service respectively (no partial-admin role), so
  // those are the only two role keys that ever have anything to see on
  // this route; a line_manager-only session gets no nav entry here.
  if (hasModule("payroll") && hasRole("hr_admin", "employee_self_service")) {
    items.push({ to: "/app/payroll", label: "Payroll" });
  }

  return items;
}

export function PortalLayout() {
  const { identity, logout } = useAuth();

  // ProtectedRoute/RequireTenant guarantee `identity` is loaded and
  // non-platform-admin before this ever renders.
  const roleKeys = identity?.roleKeys ?? [];
  const enabledModules = identity?.enabledModules ?? [];
  const navItems = buildNavItems(roleKeys, enabledModules);

  return (
    <div className="min-h-screen flex">
      <aside className="w-56 shrink-0 border-r border-black/5 bg-card px-3 py-6 flex flex-col">
        <div className="px-3 mb-8">
          <div className="text-lg font-bold tracking-tight">AI HXM</div>
          <div className="text-xs text-label-tertiary truncate">{identity?.companyName ?? "Your company"}</div>
        </div>

        <nav className="flex flex-col gap-1">
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={navLinkClass}>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto px-3">
          <div className="text-xs text-label-tertiary mb-2 truncate">{identity?.fullName}</div>
          <button
            onClick={logout}
            className="text-sm text-label-tertiary hover:text-danger transition-colors"
          >
            Log out
          </button>
        </div>
      </aside>

      <main className="flex-1 px-8 py-8 max-w-5xl">
        <Outlet />
      </main>
    </div>
  );
}
