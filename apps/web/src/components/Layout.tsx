import { NavLink, Outlet } from "react-router-dom";
import { LayoutDashboard, ScrollText, ShieldCheck, Palette } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { AihxmLogo } from "./AihxmLogo";

// Theme alignment pass (2026-09-26) — same change as PortalLayout.tsx's own
// navLinkClass: a soft tinted pill (bg-accent/10 text-accent) replacing the
// old solid full-saturation active block, plus an icon per item, so the
// Platform Admin shell and the tenant-facing shell read as one product
// rather than two different-looking apps.
const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
    isActive ? "bg-accent/10 text-accent" : "text-label-secondary hover:bg-black/5"
  }`;

export function Layout() {
  const { logout } = useAuth();

  return (
    <div className="min-h-screen flex">
      <aside className="w-56 shrink-0 border-r border-black/5 bg-card px-3 py-6 flex flex-col">
        <div className="px-3 mb-8">
          <AihxmLogo size={40} />
          <div className="text-xs text-label-tertiary mt-1.5">Platform Admin</div>
        </div>

        <nav className="flex flex-col gap-1">
          <NavLink to="/" end className={navLinkClass}>
            <LayoutDashboard size={18} strokeWidth={1.75} className="shrink-0" />
            Dashboard
          </NavLink>
          <NavLink to="/audit-log" className={navLinkClass}>
            <ScrollText size={18} strokeWidth={1.75} className="shrink-0" />
            Audit Log
          </NavLink>
          <NavLink to="/platform-admins" className={navLinkClass}>
            <ShieldCheck size={18} strokeWidth={1.75} className="shrink-0" />
            Platform Admins
          </NavLink>
          <NavLink to="/platform-branding" className={navLinkClass}>
            <Palette size={18} strokeWidth={1.75} className="shrink-0" />
            Platform Branding
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
