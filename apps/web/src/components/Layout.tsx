import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `block px-3 py-2 rounded-lg text-sm font-medium ${
    isActive ? "bg-accent text-white" : "text-label-secondary hover:bg-black/5"
  }`;

export function Layout() {
  const { logout } = useAuth();

  return (
    <div className="min-h-screen flex">
      <aside className="w-56 shrink-0 border-r border-black/5 bg-card px-3 py-6 flex flex-col">
        <div className="px-3 mb-8">
          <div className="text-lg font-bold tracking-tight">BoostFactor</div>
          <div className="text-xs text-label-tertiary">Platform Admin</div>
        </div>

        <nav className="flex flex-col gap-1">
          <NavLink to="/" end className={navLinkClass}>
            Dashboard
          </NavLink>
          <NavLink to="/audit-log" className={navLinkClass}>
            Audit Log
          </NavLink>
          <NavLink to="/platform-admins" className={navLinkClass}>
            Platform Admins
          </NavLink>
        </nav>

        <div className="mt-auto px-3">
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
