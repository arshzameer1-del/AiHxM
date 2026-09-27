import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { WorkflowTemplatesPanel } from "./WorkflowTemplatesPanel";
import { RolesAccessPanel } from "./RolesAccessPanel";
import { AllConfigurationPanel } from "./AllConfigurationPanel";

type Tab = "workflows" | "access" | "configuration";

const TABS: { key: Tab; label: string }[] = [
  { key: "workflows", label: "Workflow Templates" },
  { key: "access", label: "Roles & Access" },
  // kumail's own instruction (2026-09-27): "all the configuration please
  // add in system admin with there specific tile" — see
  // AllConfigurationPanel.tsx's own doc comment for why this is a
  // deliberately different, always-visible list rather than Configuration
  // Center's own permission-filtered one.
  { key: "configuration", label: "Configuration" },
];

// Configuration Center links here with ?tab=workflows (0032_configuration_center.sql).
const VALID_TABS: Tab[] = ["workflows", "access", "configuration"];
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
  const [tab, setTab] = useState<Tab>(() => initialTabFrom(searchParams));

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-1">System Admin</h1>
      <p className="text-label-tertiary text-sm mb-6">
        Configure approval workflows and manage logins and roles for this company — no database access required.
      </p>

      <div className="flex gap-1 mb-6 border-b border-black/5">
        {TABS.map((t) => (
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
      {tab === "configuration" && <AllConfigurationPanel />}
    </div>
  );
}
