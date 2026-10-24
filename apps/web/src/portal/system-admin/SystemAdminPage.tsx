import { useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { useSearchParams } from "react-router-dom";
import { WorkflowTemplatesPanel } from "./WorkflowTemplatesPanel";
import { RolesAccessPanel } from "./RolesAccessPanel";
import { RolesPermissionsPanel } from "./RolesPermissionsPanel";
import { AllConfigurationPanel } from "./AllConfigurationPanel";
import { AppearancePanel } from "./AppearancePanel";

type Tab = "workflows" | "access" | "permissions" | "configuration" | "appearance";

// `needs` is what the tab asks of the person: a permission key, or the System Admin role. A custom role that was given
// "workflow_template.manage.all" sees Workflow Templates only; the server enforces the same rule.
const TABS: { key: Tab; label: string; needs: string }[] = [
  { key: "workflows", label: "Workflow Templates", needs: "workflow_template.manage.all" },
  { key: "access", label: "Roles & Access", needs: "role:system_admin" },
  { key: "permissions", label: "Roles & Permissions", needs: "role:system_admin" },
  // kumail's own instruction (2026-09-27): "all the configuration please
  // add in system admin with there specific tile" — see
  // AllConfigurationPanel.tsx's own doc comment for why this is a
  // deliberately different, always-visible list rather than Configuration
  // Center's own permission-filtered one.
  { key: "configuration", label: "Configuration", needs: "role:system_admin" },
  { key: "appearance", label: "Appearance", needs: "company_appearance.manage" },
];

// Configuration Center links here with ?tab=workflows (0032_configuration_center.sql).
const VALID_TABS: Tab[] = ["workflows", "access", "permissions", "configuration", "appearance"];
function initialTabFrom(searchParams: URLSearchParams): Tab {
  const requested = searchParams.get("tab");
  return (VALID_TABS as string[]).includes(requested ?? "") ? (requested as Tab) : "workflows";
}

/**
 * Task #52 (Decision #20) — System Admin, modeled on SAP SuccessFactors'
 * Admin Center: a role separate from hr_admin that configures approval
 * workflows and manages who has which login and role, without holding any
 * rights over employee HR data itself. Both tabs are thin config UIs over
 * already-real engines (the Phase 6 workflow engine; the Phase 4 RBAC
 * engine's own user_role_assignments) — nothing here re-implements either.
 */
export function SystemAdminPage() {
  const [searchParams] = useSearchParams();
  const { identity } = useAuth();
  const allowed = (needs: string) => (needs.startsWith("role:") ? (identity?.roleKeys ?? []).some((k) => k === needs.slice(5)) : (identity?.permissions ?? []).includes(needs) || (identity?.roleKeys ?? []).includes("system_admin"));
  const visibleTabs = TABS.filter((t) => allowed(t.needs));
  const requested = initialTabFrom(searchParams);
  const [picked, setTab] = useState<Tab>(requested);
  const tab: Tab = visibleTabs.some((t) => t.key === picked) ? picked : (visibleTabs[0]?.key ?? "workflows");

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-1">System Admin</h1>
      <p className="text-label-tertiary text-sm mb-6">
        Configure approval workflows, logins, roles and how the company looks — no database access required.
      </p>

      <div className="flex gap-1 mb-6 border-b border-black/5">
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
              tab === t.key ? "border-accent text-accent" : "border-transparent text-label-tertiary hover:text-label-primary"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "workflows" && <WorkflowTemplatesPanel />}
      {tab === "access" && <RolesAccessPanel />}
      {tab === "permissions" && <RolesPermissionsPanel />}
      {tab === "configuration" && <AllConfigurationPanel />}
      {tab === "appearance" && <AppearancePanel />}
    </div>
  );
}
