import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import {
  type LucideIcon,
  Home,
  User,
  Users,
  Network,
  Settings2,
  ShieldCheck,
  Terminal,
  CalendarDays,
  Briefcase,
  Target,
  Wallet,
  BookOpenCheck,
  Receipt,
} from "lucide-react";
import type { ModuleKey, PublicTenantBranding, TenantRoleKey } from "@aihxm/shared-types";
import { api, publicTenantBrandingAssetUrl } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Topbar, type QuickJumpItem } from "../components/shell/Topbar";
import {
  SIDEBAR_CONTAINER_CLASS,
  SIDEBAR_GROUP_DIVIDER_CLASS,
  SIDEBAR_GROUP_TOGGLE_CLASS,
  sidebarNavLinkClass as navLinkClass,
} from "../components/shell/sidebarTheme";

const ROLE_LABELS: Record<TenantRoleKey, string> = {
  hr_admin: "HR Admin",
  line_manager: "Line Manager",
  employee_self_service: "Employee",
  system_admin: "System Admin",
  payroll_approver: "Payroll Approver",
};

// Organization Management Phase 9 (Unified Integration & Synchronization
// Requirements, Section 2) — `NavItem` finally gets the sub-nav/grouping
// concept every prior Organization Management phase's own comment here
// flagged as missing (`children` is optional so every OTHER section of the
// app, none of which needs grouping, is unaffected). Deliberately only ONE
// level deep — a group's `children` are always plain leaf items, never
// another nested group — since nothing in this app needs more than that.
// `icon` was added in the same theme-alignment pass as navLinkClass above —
// optional so a child item (no icon in the reference design either) simply
// renders without the leading glyph.
type NavItem = { to: string; label: string; end?: boolean; children?: NavItem[]; icon?: LucideIcon };

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

  const items: NavItem[] = [{ to: "/app", label: "Home", end: true, icon: Home }];

  if (hasRole("hr_admin", "line_manager") && hasModule("employee")) {
    // Core Employee Enterprise Phases 2/12's frontend catch-up (2026-09-27)
    // — Hiring Wizard, Bulk Hiring and Workforce Analytics all had no way
    // to reach them from the sidebar at all. Grouped under "Employees"
    // itself (the same "top-level link is also the group's `to`" pattern
    // the Organization group already established) rather than flattened
    // as three more top-level items — same reasoning Organization Phase 9
    // gave for its own consolidation. Hire/Bulk Import/Analytics are all
    // hr_admin-only server-side (employee.manage.all), so — like Legacy
    // Data Reconciliation's own precedent in the Organization group — they
    // don't show for a line_manager who can otherwise see this group.
    items.push({
      to: "/app/employees",
      label: "Employees",
      icon: Users,
      // An empty array is still truthy in JS — the render loop below treats
      // ANY `children` (checked with a plain `if (item.children)`) as "show
      // the NavGroup, disclosure arrow and all," so a line_manager without
      // hr_admin gets `undefined` here, not `[]`, to fall through to a
      // plain flat NavLink instead of an always-empty expandable group.
      ...(hasRole("hr_admin")
        ? {
            children: [
              { to: "/app/employees/hire", label: "Hire" },
              { to: "/app/employees/bulk-import", label: "Bulk Import" },
              { to: "/app/employees/analytics", label: "Workforce Analytics" },
            ],
          }
        : {}),
    });
  } else if (roleKeys.length > 0 && hasModule("employee")) {
    items.push({ to: "/app/profile", label: "My Profile", icon: User });
  }

  // Organization Management Phase 1 — org_unit.view.all is seeded broadly
  // (hr_admin/line_manager/employee_self_service, 0066_organization_units_seed.sql),
  // same audience as the Employees/My Profile split above; org_unit.manage.all
  // (hr_admin only) is what actually gates the create/edit/move/archive
  // actions the page itself renders.
  if (hasModule("employee") && roleKeys.length > 0) {
    // Organization Management Phase 9 — collapses what Phases 2-5 each
    // added as their own flat top-level item (Jobs/Positions/Assignments/
    // Reporting Lines/Locations/Financial Centers/Reorganizations, all
    // gated identically to org_unit.view.all's own broad seed audience —
    // 0069/0072/0074/0077) into one grouped "Organization" nav entry, per
    // the Unified Integration & Synchronization Requirements doc's Section
    // 2. The Hierarchy Explorer itself stays the group's own `to` (clicking
    // "Organization" still opens it, same as before this phase); every
    // other Organization Management screen becomes a child. This is the
    // one and only group `NavItem.children` is used for in this file —
    // every other section of the app stays exactly as flat as it always
    // was.
    items.push({
      to: "/app/organization",
      label: "Organization",
      end: true,
      icon: Network,
      children: [
        { to: "/app/organization/jobs", label: "Jobs" },
        { to: "/app/organization/positions", label: "Positions" },
        { to: "/app/organization/assignments", label: "Assignments" },
        { to: "/app/organization/relationships", label: "Reporting Lines" },
        { to: "/app/organization/locations", label: "Locations" },
        { to: "/app/organization/financial-centers", label: "Financial Centers" },
        { to: "/app/organization/reorganizations", label: "Reorganizations" },
        // Organization Management Phase 12 — unlike every sibling above
        // (all broadly seeded alongside org_unit.view.all), Legacy Data
        // Reconciliation is gated server-side on `employee.manage.all`,
        // hr_admin-only (0011_employee_seed.sql) — so, unlike its
        // siblings, this one child is itself conditional rather than
        // visible to the whole `roleKeys.length > 0` audience above.
        ...(roleKeys.includes("hr_admin") ? [{ to: "/app/organization/legacy-reconciliation", label: "Legacy Data Reconciliation" }] : []),
      ],
    });
  }

  // Configuration Center is a read-only index over config domains this
  // login can already reach some other way (Admin Center, System Admin,
  // Payroll Settings) — shown to the same roles that see at least one of
  // those, so it never promises a screen with nothing behind it.
  if (hasRole("hr_admin", "system_admin")) {
    items.push({ to: "/app/configuration-center", label: "Configuration Center", icon: Settings2 });
  }

  if (hasRole("hr_admin")) {
    items.push({ to: "/app/admin", label: "Admin Center", icon: ShieldCheck });
  }

  // HR Administration v2 (2026-09-27) — the reference/lookup-data
  // workspace (employment types, lifecycle reason catalogs), deliberately
  // its own top-level entry rather than a tab under Configuration Center
  // or Admin Center, per the v2 spec's own Section 7/19 split and
  // kumail's own "configuration means fields controls, not maintenance"
  // correction. `hr_reference_catalog.manage.all`/`.view.all` are both
  // hr_admin-only (0090_hr_administration_reference_catalog.sql), so this
  // is gated the same courtesy way as Admin Center/System Admin above —
  // the real gate is server-side in HrReferenceCatalogService.
  if (hasRole("hr_admin") && hasModule("employee")) {
    items.push({ to: "/app/hr-administration", label: "HR Administration", icon: BookOpenCheck });
  }

  // Decision #20 — deliberately not module-gated: workflow/role
  // configuration is a core platform capability, not a licensed module,
  // same posture as Admin Center above.
  if (hasRole("system_admin")) {
    items.push({ to: "/app/system-admin", label: "System Admin", icon: Terminal });
  }

  if (hasModule("leave") && roleKeys.length > 0) {
    items.push({ to: "/app/leave", label: "Leave & Attendance", icon: CalendarDays });
  }

  // ESS build-out (2026-10, Part 2 category 6) — expense_claim.view.self/
  // .team/.all mirror leave_request.view.*'s exact three-role seed
  // (0115_expense_management.sql), so this is gated identically to the
  // Leave entry just above it.
  if (hasModule("expense") && roleKeys.length > 0) {
    items.push({ to: "/app/expenses", label: "Expenses", icon: Receipt });
  }

  if (hasRole("hr_admin") && hasModule("recruitment")) {
    items.push({ to: "/app/recruitment", label: "Recruitment", icon: Briefcase });
  }

  if (hasModule("performance") && roleKeys.length > 0) {
    items.push({ to: "/app/performance", label: "Performance", icon: Target });
  }

  // Phase 12 (Decision #14) — 0023_payroll_seed.sql grants
  // `payroll.manage.all`/`payroll_review.view.self` only to hr_admin/
  // employee_self_service respectively (no partial-admin role), so
  // those are the only two role keys that ever have anything to see on
  // this route; a line_manager-only session gets no nav entry here.
  if (hasModule("payroll") && hasRole("hr_admin", "employee_self_service")) {
    items.push({ to: "/app/payroll", label: "Payroll", icon: Wallet });
  }

  return items;
}

/**
 * The tenant's own uploaded mark in the authenticated app shell — this used
 * to be a hardcoded "AI HXM" text label no matter what a company uploaded
 * under Branding (TM-015), because this shell never fetched tenant branding
 * at all; only the pre-login /:slug/login page (LoginPage.tsx) did. Fetched
 * from the same public, no-auth /public/tenants/:slug/branding endpoint the
 * login page already uses — a session/token isn't needed for it, and reusing
 * it means one branding pipeline for both surfaces instead of two. Falls
 * back to the plain "AI HXM" text below (never the platform's own AihxmLogo
 * mark) when the company hasn't uploaded a logo, or the slug/fetch isn't
 * available yet, so there's no visible flash from placeholder to real mark.
 */
function PortalMark({ companySlug, companyName }: { companySlug: string | null; companyName: string | null }) {
  const [branding, setBranding] = useState<PublicTenantBranding | null>(null);

  useEffect(() => {
    if (!companySlug) return;
    let cancelled = false;
    api
      .getPublicTenantBranding(companySlug)
      .then((result) => {
        if (!cancelled) setBranding(result);
      })
      .catch(() => {
        // No branding uploaded yet, or the fetch failed — fall back to the
        // plain text mark below. Cosmetic only, same posture as LoginPage's
        // own tenant-branding fetch and AihxmLogo's platform-branding fetch.
      });
    return () => {
      cancelled = true;
    };
  }, [companySlug]);

  if (companySlug && branding?.hasLogo) {
    // UI Re-skin Phase 2 — the sidebar is now a dark background, but a
    // tenant's own uploaded mark (TM-015) was never designed against one;
    // most logos assume a light surface. Wrapping it in a small white
    // chip keeps every tenant's own branding legible regardless of the
    // mark's own colors, without asking anyone to re-upload anything.
    return (
      <span className="inline-block bg-white rounded-md px-2 py-1.5">
        <img
          src={publicTenantBrandingAssetUrl(companySlug, "logo")}
          alt={companyName ?? "Company logo"}
          className="max-w-full object-contain"
          style={{ maxHeight: 32 }}
        />
      </span>
    );
  }

  return <div className="text-lg font-bold tracking-tight text-white">AI HXM</div>;
}

/**
 * Organization Management Phase 9 — renders one grouped nav entry: a
 * top-level link (the Hierarchy Explorer, for "Organization") plus its
 * `children` (Jobs, Positions, Assignments, Reporting Lines, Locations,
 * Financial Centers, Reorganizations, Legacy Data Reconciliation). Starts
 * EXPANDED unconditionally — an earlier version of this component started
 * collapsed unless the current route was already inside the group, on the
 * reasoning that the eight-item list shouldn't "dominate the sidebar for a
 * viewer who hasn't opened it." In real use that traded a minor cosmetic
 * concern for a much worse one: a collapsed group with only a small,
 * easy-to-miss disclosure arrow reads as those screens having been removed
 * entirely, not merely tucked away — real functionality (Position
 * creation, Reporting Lines) must never be one accidental click away from
 * looking deleted. The manual collapse toggle stays available for anyone
 * who wants to tidy their own view, but nobody's session should ever load
 * with it already closed. This is the only place in the sidebar that
 * renders a group; every flat `NavItem` still renders as a single
 * `NavLink`, unchanged from before this phase.
 */
function NavGroup({ item }: { item: NavItem & { children: NavItem[] } }) {
  const [expanded, setExpanded] = useState(true);
  const Icon = item.icon;

  return (
    <div>
      <div className="flex items-center gap-1">
        <NavLink to={item.to} end={item.end} className={navLinkClass} style={{ flex: 1 }}>
          {Icon && <Icon size={18} strokeWidth={1.75} className="shrink-0" />}
          {item.label}
        </NavLink>
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${item.label}` : `Expand ${item.label}`}
          className={SIDEBAR_GROUP_TOGGLE_CLASS}
        >
          <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        </button>
      </div>
      {expanded && (
        <div className={SIDEBAR_GROUP_DIVIDER_CLASS}>
          {item.children.map((child) => (
            <NavLink key={child.to} to={child.to} end={child.end} className={navLinkClass}>
              {child.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Tenant Management gap-fill Phase 1 item #4 — the persistent
 * "you're impersonating X" banner that makes a "Login As" session
 * impossible to forget you're in, per the original hardening request.
 * Rendered here (not on DashboardPage, which the impersonated session
 * never sees again) since PortalLayout wraps every /app route for the
 * whole duration of the session. `endImpersonation` (AuthContext) is
 * what actually force-revokes it server-side and restores the Platform
 * Admin's own session — this component only drives the button's busy
 * state and surfaces a failure, since `endImpersonation` swallows the
 * revoke call's own errors as best-effort (see its doc comment).
 */
function ImpersonationBanner({
  impersonation,
  endImpersonation,
}: {
  impersonation: NonNullable<ReturnType<typeof useAuth>["impersonation"]>;
  endImpersonation: () => Promise<void>;
}) {
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleEnd() {
    setEnding(true);
    setError(null);
    try {
      await endImpersonation();
    } catch {
      setError("Could not end this session — try again.");
      setEnding(false);
    }
  }

  return (
    <div className="bg-warning text-white px-4 py-2 text-sm flex flex-wrap items-center justify-between gap-2">
      <span>
        You're viewing <strong>{impersonation.companyName}</strong> as{" "}
        {impersonation.impersonatedAdminEmail} — a real, audited session that ends automatically in
        30 minutes.
      </span>
      <div className="flex items-center gap-3 shrink-0">
        {error && <span className="text-xs">{error}</span>}
        <button
          onClick={handleEnd}
          disabled={ending}
          className="bg-white/20 hover:bg-white/30 rounded-lg px-3 py-1 text-xs font-semibold disabled:opacity-50 whitespace-nowrap"
        >
          {ending ? "Ending…" : "End session"}
        </button>
      </div>
    </div>
  );
}

/**
 * UI Re-skin Phase 2 — flattens `buildNavItems()`'s own tree (a group's
 * `children` are always one level of plain leaf items, per NavItem's own
 * doc comment) into the flat list Topbar's quick-jump search filters over.
 * A child's `group` is its parent's label, so "Jobs" shows "Organization"
 * as a hint the same way a command palette entry normally would. This
 * never diverges from the sidebar's own gating — it reads the exact same
 * `navItems` the `<nav>` below renders, nothing is added or removed.
 */
function flattenNavItems(items: NavItem[]): QuickJumpItem[] {
  const flat: QuickJumpItem[] = [];
  for (const item of items) {
    flat.push({ to: item.to, label: item.label });
    if (item.children) {
      for (const child of item.children) {
        flat.push({ to: child.to, label: child.label, group: item.label });
      }
    }
  }
  return flat;
}

export function PortalLayout() {
  const { identity, logout, impersonation, endImpersonation } = useAuth();

  // ProtectedRoute/RequireTenant guarantee `identity` is loaded and
  // non-platform-admin before this ever renders.
  const roleKeys = identity?.roleKeys ?? [];
  const enabledModules = identity?.enabledModules ?? [];
  const navItems = buildNavItems(roleKeys, enabledModules);
  const roleLabel = roleKeys.length > 0 ? roleKeys.map((k) => ROLE_LABELS[k] ?? k).join(" · ") : "Member";

  return (
    <div className="min-h-screen flex flex-col">
      {impersonation && <ImpersonationBanner impersonation={impersonation} endImpersonation={endImpersonation} />}

      <div className="flex flex-1 min-h-0">
        <aside className={SIDEBAR_CONTAINER_CLASS}>
          <div className="px-3 mb-8">
            <PortalMark companySlug={identity?.companySlug ?? null} companyName={identity?.companyName ?? null} />
            <div className="text-xs text-slate-400 truncate mt-1.5">{identity?.companyName ?? "Your company"}</div>
          </div>

          <nav className="flex flex-col gap-1">
            {navItems.map((item) => {
              if (item.children) {
                return <NavGroup key={item.to} item={item as NavItem & { children: NavItem[] }} />;
              }
              const Icon = item.icon;
              return (
                <NavLink key={item.to} to={item.to} end={item.end} className={navLinkClass}>
                  {Icon && <Icon size={18} strokeWidth={1.75} className="shrink-0" />}
                  {item.label}
                </NavLink>
              );
            })}
          </nav>
        </aside>

        <div className="flex-1 flex flex-col min-w-0">
          <Topbar
            items={flattenNavItems(navItems)}
            userName={identity?.fullName ?? "Account"}
            userEmail={identity?.email ?? ""}
            roleLabel={roleLabel}
            onLogout={logout}
          />
          <main className="flex-1 px-8 py-8 max-w-5xl overflow-y-auto">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
