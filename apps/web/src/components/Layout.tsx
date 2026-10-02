import { NavLink, Outlet } from "react-router-dom";
import { LayoutDashboard, ScrollText, ShieldCheck, Palette } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { AihxmLogo } from "./AihxmLogo";
import { Topbar, type QuickJumpItem } from "./shell/Topbar";
import { SIDEBAR_CONTAINER_CLASS, sidebarNavLinkClass as navLinkClass } from "./shell/sidebarTheme";

const QUICK_JUMP_ITEMS: QuickJumpItem[] = [
  { to: "/", label: "Dashboard" },
  { to: "/audit-log", label: "Audit Log" },
  { to: "/platform-admins", label: "Platform Admins" },
  { to: "/platform-branding", label: "Platform Branding" },
];

export function Layout() {
  const { identity, logout } = useAuth();

  return (
    <div className="min-h-screen flex">
      <aside className={SIDEBAR_CONTAINER_CLASS}>
        <div className="px-3 mb-8">
          <AihxmLogo size={40} className="text-white" />
          <div className="text-xs text-slate-400 mt-1.5">Platform Admin</div>
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
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <Topbar
          items={QUICK_JUMP_ITEMS}
          userName={identity?.fullName ?? "Platform Admin"}
          userEmail={identity?.email ?? ""}
          roleLabel="Platform Admin"
          onLogout={logout}
        />
        <main className="flex-1 px-8 py-8 max-w-5xl overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
