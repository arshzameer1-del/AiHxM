import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { OrganizationCommandCenterSummary } from "@aihxm/shared-types";
import { useAuth } from "../auth/AuthContext";
import { api } from "../api/client";

const ROLE_LABELS: Record<string, string> = {
  hr_admin: "HR Admin",
  line_manager: "Line Manager",
  employee_self_service: "Employee",
};

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

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-1">Welcome, {fullName}</h1>
      <p className="text-sm text-label-tertiary mb-6">{companyName}</p>

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
          </div>

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
