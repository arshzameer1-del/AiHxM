import { NavLink, Outlet } from "react-router-dom";

const TABS: { to: string; label: string; end?: boolean }[] = [
  { to: "/app/reports", label: "Overview", end: true },
  { to: "/app/reports/library", label: "Library" },
  { to: "/app/reports/saved", label: "My reports" },
  { to: "/app/reports/dashboards", label: "Dashboards" },
  { to: "/app/reports/builder", label: "Builder" },
  { to: "/app/reports/schedules", label: "Scheduled" },
  { to: "/app/reports/exports", label: "Exports" },
];

/** The frame every Reports & Analytics page sits in: one row of tabs, then the page. */
export function ReportsShell() {
  return (
    <div>
      <nav aria-label="Reports & Analytics sections" className="mb-5 -mx-1 overflow-x-auto">
        <ul className="flex gap-1 border-b border-border min-w-max px-1">
          {TABS.map((t) => (
            <li key={t.to}>
              <NavLink
                to={t.to}
                end={t.end}
                className={({ isActive }) =>
                  `inline-block px-3 py-2 text-sm font-semibold border-b-2 -mb-px outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-t ${
                    isActive ? "border-accent text-accent" : "border-transparent text-label-secondary hover:text-label-primary"
                  }`
                }
              >
                {t.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <Outlet />
    </div>
  );
}
