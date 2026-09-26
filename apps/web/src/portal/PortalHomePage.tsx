import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  type LucideIcon,
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
} from "lucide-react";
import type { ModuleKey, OrganizationCommandCenterSummary, TenantRoleKey } from "@aihxm/shared-types";
import { useAuth } from "../auth/AuthContext";
import { api } from "../api/client";

const ROLE_LABELS: Record<string, string> = {
  hr_admin: "HR Admin",
  line_manager: "Line Manager",
  employee_self_service: "Employee",
};

// Theme alignment pass (2026-09-26) — kumail's reference screenshot shows
// the tenant home page as a grid of module cards (icon badge + title +
// one-line description), not the plain "modules enabled" pill list this
// page used to lead with. Mirrors buildNavItems()'s own gating in
// PortalLayout.tsx exactly (same role/module conditions, same routes) so a
// card here never links anywhere the sidebar itself wouldn't also show —
// deliberately NOT duplicating that function; a small parallel list is
// easier to keep honest than importing a function that returns nav-only
// shapes (icons/children) this page doesn't need. Per kumail's explicit
// instruction, these cards carry no status/phase badge — the reference
// prototype's "Phase 1/2/3" pills marked build order for a not-yet-built
// roadmap, which doesn't apply to features that are already live.
type HomeCard = { to: string; label: string; description: string; icon: LucideIcon };

function buildHomeCards(roleKeys: TenantRoleKey[], enabledModules: ModuleKey[]): HomeCard[] {
  const hasRole = (...keys: TenantRoleKey[]) => keys.some((k) => roleKeys.includes(k));
  const hasModule = (key: ModuleKey) => enabledModules.includes(key);
  const cards: HomeCard[] = [];

  if (hasRole("hr_admin", "line_manager") && hasModule("employee")) {
    cards.push({ to: "/app/employees", label: "Employees", description: "Directory, records & profiles", icon: Users });
  } else if (roleKeys.length > 0 && hasModule("employee")) {
    cards.push({ to: "/app/profile", label: "My Profile", description: "Your own employee record", icon: User });
  }

  if (hasModule("employee") && roleKeys.length > 0) {
    cards.push({ to: "/app/organization", label: "Organization", description: "Org chart, positions & structure", icon: Network });
  }

  if (hasRole("hr_admin", "system_admin")) {
    cards.push({ to: "/app/configuration-center", label: "Configuration Center", description: "Tenant setup & configuration", icon: Settings2 });
  }

  if (hasRole("hr_admin")) {
    cards.push({ to: "/app/admin", label: "Admin Center", description: "Policies, schedules & groups", icon: ShieldCheck });
  }

  if (hasRole("system_admin")) {
    cards.push({ to: "/app/system-admin", label: "System Admin", description: "Roles, workflow & platform rules", icon: Terminal });
  }

  if (hasModule("leave") && roleKeys.length > 0) {
    cards.push({ to: "/app/leave", label: "Leave & Attendance", description: "Requests, balances & calendar", icon: CalendarDays });
  }

  if (hasRole("hr_admin") && hasModule("recruitment")) {
    cards.push({ to: "/app/recruitment", label: "Recruitment", description: "Requisitions, candidates & offers", icon: Briefcase });
  }

  if (hasModule("performance") && roleKeys.length > 0) {
    cards.push({ to: "/app/performance", label: "Performance", description: "Goals & review cycles", icon: Target });
  }

  if (hasModule("payroll") && hasRole("hr_admin", "employee_self_service")) {
    cards.push({ to: "/app/payroll", label: "Payroll", description: "Payslips & statutory calculations", icon: Wallet });
  }

  return cards;
}

function HomeCardTile({ card }: { card: HomeCard }) {
  const Icon = card.icon;
  return (
    <Link
      to={card.to}
      className="flex flex-col gap-3 bg-card rounded-card p-4 shadow-sm border border-black/5 hover:border-accent/30 hover:shadow transition-all"
    >
      <div className="w-10 h-10 rounded-lg bg-accent/10 text-accent flex items-center justify-center">
        <Icon size={20} strokeWidth={1.75} />
      </div>
      <div>
        <div className="font-semibold text-sm">{card.label}</div>
        <div className="text-xs text-label-tertiary mt-0.5">{card.description}</div>
      </div>
    </Link>
  );
}

const REORG_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  validated: "Validated",
  pending_approval: "Pending approval",
  approved: "Approved",
  rejected: "Rejected",
  published: "Published",
  failed: "Failed",
};

export function PortalHomePage() {
  const { identity } = useAuth();
  const [commandCenter, setCommandCenter] = useState<OrganizationCommandCenterSummary | null>(null);

  // Organization Management Phase 6 — the scoped Command Center panel.
  // Mirrors Tenant Management's own Platform Health panel: loaded
  // alongside the rest of the home page, not gated behind it. Gated on
  // the exact same condition PortalLayout's own nav uses for every other
  // Organization Management surface (`employee` module enabled + at
  // least one role) — within that gate, every role the seed data grants
  // (hr_admin/line_manager/employee_self_service) already holds
  // `org_unit.view.all`, so a 403 here would mean something is actually
  // wrong, not just "this viewer shouldn't see it" — in which case hiding
  // the panel silently (rather than showing an error box) is still the
  // right call for a glance panel nobody explicitly asked to open.
  const canSeeCommandCenter = (identity?.enabledModules.includes("employee") ?? false) && (identity?.roleKeys.length ?? 0) > 0;

  useEffect(() => {
    if (!canSeeCommandCenter) return;
    api.getOrganizationCommandCenterSummary().then(setCommandCenter).catch(() => undefined);
  }, [canSeeCommandCenter]);

  if (!identity) return null;

  const { fullName, companyName, roleKeys, enabledModules } = identity;
  const homeCards = buildHomeCards(roleKeys, enabledModules);

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-1">Good to see you, {fullName}</h1>
      <p className="text-sm text-label-tertiary mb-6">{companyName}</p>

      {homeCards.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
          {homeCards.map((card) => (
            <HomeCardTile key={card.to} card={card} />
          ))}
        </div>
      )}

      {roleKeys.length === 0 ? (
        <div className="bg-card rounded-card p-6 shadow-sm border border-amber-200">
          <h2 className="text-base font-semibold mb-1">No role assigned yet</h2>
          <p className="text-sm text-label-secondary">
            Your login exists, but you haven't been granted an HR Admin, Manager, or Employee role in
            AI HXM yet. Ask your company's HR Admin (or your Platform Admin, if this is a brand-new
            company) to grant you one.
          </p>
        </div>
      ) : (
        <div className="bg-card rounded-card p-6 shadow-sm mb-6">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-3">
            Your roles
          </h2>
          <div className="flex flex-wrap gap-2">
            {roleKeys.map((key) => (
              <span
                key={key}
                className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-accent/10 text-accent"
              >
                {ROLE_LABELS[key] ?? key}
              </span>
            ))}
          </div>
        </div>
      )}

      {canSeeCommandCenter && commandCenter && (
        <div className="bg-card rounded-card p-4 shadow-sm mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold">Organization Command Center</h2>
            <span className="text-xs text-label-tertiary">
              Updated {new Date(commandCenter.generatedAt).toLocaleTimeString()}
            </span>
          </div>

          <div className="flex flex-wrap gap-8 mb-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary">Org units</div>
              <div className="text-xl font-bold">{commandCenter.totalOrgUnits}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary">Positions</div>
              <div className="text-xl font-bold">{commandCenter.totalPositions}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary">Vacant</div>
              <div className="text-xl font-bold text-warning">{commandCenter.vacantPositions}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary">Filled</div>
              <div className="text-xl font-bold">{commandCenter.filledPositions}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary">Active assignments</div>
              <div className="text-xl font-bold">{commandCenter.activeAssignments}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary">Reorgs in flight</div>
              <div className="text-xl font-bold">{commandCenter.reorganizationsInFlight}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary">Locations</div>
              <div className="text-xl font-bold">{commandCenter.totalLocations}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary">Cost centers</div>
              <div className="text-xl font-bold">{commandCenter.totalCostCenters}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary">Profit centers</div>
              <div className="text-xl font-bold">{commandCenter.totalProfitCenters}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary">Data quality issues</div>
              <div className={`text-xl font-bold ${commandCenter.dataQualityIssues > 0 ? "text-warning" : ""}`}>
                {commandCenter.dataQualityIssues}
              </div>
            </div>
          </div>

          {commandCenter.integrityWarnings.some((w) => w.count > 0) && (
            <div className="mb-3">
              <div className="text-xs uppercase tracking-wide text-label-tertiary mb-1.5">Warnings</div>
              <ul className="space-y-1">
                {commandCenter.integrityWarnings
                  .filter((w) => w.count > 0)
                  .map((w) => (
                    <li key={w.code} className="flex items-center justify-between gap-4 text-sm">
                      <span className="text-warning">
                        <span aria-hidden="true">⚠</span> {w.label}
                      </span>
                      <span className="font-semibold tabular-nums">{w.count}</span>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {commandCenter.recentReorganizations.length === 0 ? (
            <div className="text-sm text-label-secondary">No reorganizations yet.</div>
          ) : (
            <ul className="divide-y divide-black/5">
              {commandCenter.recentReorganizations.map((c) => (
                <li key={c.id} className="py-2 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <Link to="/app/organization/reorganizations" className="font-semibold text-sm hover:underline truncate">
                      {c.title}
                    </Link>
                    <div className="text-xs text-label-tertiary">
                      {REORG_STATUS_LABELS[c.status] ?? c.status} · Effective {c.effectiveDate}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="bg-card rounded-card p-6 shadow-sm">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-3">
          Modules enabled for {companyName}
        </h2>
        {enabledModules.length === 0 ? (
          <p className="text-sm text-label-tertiary">No modules are currently licensed for this company.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {enabledModules.map((key) => (
              <span
                key={key}
                className="inline-block px-2.5 py-0.5 rounded-full text-xs font-medium bg-black/5 text-label-secondary capitalize"
              >
                {key}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
