import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { EmployeeGroupsPanel } from "./EmployeeGroupsPanel";
import { LeavePoliciesPanel } from "./LeavePoliciesPanel";
import { ShiftsPanel } from "./ShiftsPanel";
import { HolidaysPanel } from "./HolidaysPanel";
import { ChecklistsPanel } from "./ChecklistsPanel";

type Tab = "groups" | "policies" | "shifts" | "holidays" | "checklists";

const TABS: { key: Tab; label: string }[] = [
  { key: "groups", label: "Employee Groups" },
  { key: "policies", label: "Leave Policies" },
  { key: "shifts", label: "Shifts & Work Schedule" },
  { key: "holidays", label: "Holidays" },
  { key: "checklists", label: "Onboarding & Offboarding" },
];

// Configuration Center links here with e.g. ?tab=holidays — matched
// against the same query-param keys its own admin_route rows use
// (0032_configuration_center.sql), read once on mount so a normal
// in-page tab click still just uses local state, not the URL.
const VALID_TABS: Tab[] = ["groups", "policies", "shifts", "holidays", "checklists"];
function initialTabFrom(searchParams: URLSearchParams): Tab {
  const requested = searchParams.get("tab");
  return (VALID_TABS as string[]).includes(requested ?? "") ? (requested as Tab) : "groups";
}

/**
 * Task #49 — the P1 item the MVP gate audit named directly: "so no
 * customer needs a developer to touch the database." Both tabs are thin
 * CRUD/assignment UIs over Phase 8's already-tested resolver
 * (EmployeeGroupsService) — nothing here re-implements matching or
 * specificity, it only lets an HR Admin configure the inputs to it.
 */
export function AdminCenterPage() {
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => initialTabFrom(searchParams));

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-1">Admin Center</h1>
      <p className="text-label-tertiary text-sm mb-6">
        Configure employee groups, leave policies, shifts and work schedules, holidays, and onboarding/offboarding
        checklists for this company — no database access required.
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

      {tab === "groups" ? (
        <EmployeeGroupsPanel />
      ) : tab === "policies" ? (
        <LeavePoliciesPanel />
      ) : tab === "shifts" ? (
        <ShiftsPanel />
      ) : tab === "holidays" ? (
        <HolidaysPanel />
      ) : (
        <ChecklistsPanel />
      )}
    </div>
  );
}
