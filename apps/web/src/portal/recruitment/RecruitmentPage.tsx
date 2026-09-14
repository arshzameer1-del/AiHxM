import { useState } from "react";
import { RequisitionsPanel } from "./RequisitionsPanel";
import { CandidatesPanel } from "./CandidatesPanel";
import { PipelinePanel } from "./PipelinePanel";

type Tab = "requisitions" | "candidates" | "pipeline";

const TABS: { key: Tab; label: string }[] = [
  { key: "requisitions", label: "Requisitions" },
  { key: "candidates", label: "Candidates" },
  { key: "pipeline", label: "Pipeline" },
];

/**
 * Task #51 — job requisitions → candidate pool → Kanban pipeline →
 * offer → hire, same three-tab shell pattern as Task #49's Admin
 * Center. recruitment.manage.all has no self/team scoping
 * (0018_recruitment_seed.sql), so unlike Leave & Attendance there's no
 * per-role rendering here — PortalLayout's nav already keeps this route
 * hr_admin-only, and every tab renders the same single screen.
 */
export function RecruitmentPage() {
  const [tab, setTab] = useState<Tab>("requisitions");

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-1">Recruitment</h1>
      <p className="text-label-tertiary text-sm mb-6">
        Job requisitions, candidate pipeline, and offers.
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

      {tab === "requisitions" && <RequisitionsPanel />}
      {tab === "candidates" && <CandidatesPanel />}
      {tab === "pipeline" && <PipelinePanel />}
    </div>
  );
}
