import { useState } from "react";
import { EmployeeGroupsPanel } from "./EmployeeGroupsPanel";
import { LeavePoliciesPanel } from "./LeavePoliciesPanel";

type Tab = "groups" | "policies";

const TABS: { key: Tab; label: string }[] = [
  { key: "groups", label: "Employee Groups" },
  { key: "policies", label: "Leave Policies" },
];

/**
 * Task #49 — the P1 item the MVP gate audit named directly: "so no
 * customer needs a developer to touch the database." Both tabs are thin
 * CRUD/assignment UIs over Phase 8's already-tested resolver
 * (EmployeeGroupsService) — nothing here re-implements matching or
 * specificity, it only lets an HR Admin configure the inputs to it.
 */
export function AdminCenterPage() {
  const [tab, setTab] = useState<Tab>("groups");

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-1">Admin Center</h1>
      <p className="text-label-tertiary text-sm mb-6">
        Configure employee groups and leave policies for this company — no database access required.
      </p>

      <div className="flex gap-1 mb-6 border-b border-black/5">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? "border-accent text-accent"
                : "border-transparent text-label-tertiary hover:text-label-primary"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "groups" ? <EmployeeGroupsPanel /> : <LeavePoliciesPanel />}
    </div>
  );
}
