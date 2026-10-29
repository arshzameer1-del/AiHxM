import { useState } from "react";
import { RequisitionsPanel } from "./RequisitionsPanel";
import { CandidatesPanel } from "./CandidatesPanel";
import { PipelinePanel } from "./PipelinePanel";
import { InterviewsPanel } from "./InterviewsPanel";
import { ChecksPanel } from "./ChecksPanel";
import { OffersPanel } from "./OffersPanel";
import { EventsPanel } from "./EventsPanel";
import { RecruitmentSettingsPanel } from "./RecruitmentSettingsPanel";
import { CareersPanel } from "./CareersPanel";

type Tab = "requisitions" | "candidates" | "pipeline" | "interviews" | "checks" | "offers" | "events" | "careers" | "settings";

const TABS: { key: Tab; label: string }[] = [
  { key: "requisitions", label: "Requisitions" },
  { key: "candidates", label: "Candidates" },
  { key: "pipeline", label: "Pipeline" },
  { key: "interviews", label: "Interviews" },
  { key: "checks", label: "Checks" },
  { key: "offers", label: "Offers" },
  { key: "events", label: "Events" },
  { key: "careers", label: "Careers page" },
  { key: "settings", label: "Settings" },
];

/**
 * Task #51 - job requisitions, candidate pool, Kanban pipeline, offer, hire. Step 11A adds interviews and feedback,
 * pre-employment checks, offers with pay components and letters, recruitment events and the tenant's recruitment rules.
 * recruitment.manage.all has no self/team scoping (0018_recruitment_seed.sql), so PortalLayout's nav keeps this route
 * hr_admin-only and every tab renders the same single screen.
 */
export function RecruitmentPage() {
  const [tab, setTab] = useState<Tab>("requisitions");

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-1">Recruitment</h1>
      <p className="text-label-tertiary text-sm mb-6">Job requisitions, candidates, interviews, checks and offers.</p>

      <div className="flex gap-1 mb-6 border-b border-black/5 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors whitespace-nowrap ${
              tab === t.key ? "border-accent text-accent" : "border-transparent text-label-tertiary hover:text-label-primary"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "requisitions" && <RequisitionsPanel />}
      {tab === "candidates" && <CandidatesPanel />}
      {tab === "pipeline" && <PipelinePanel />}
      {tab === "interviews" && <InterviewsPanel />}
      {tab === "checks" && <ChecksPanel />}
      {tab === "offers" && <OffersPanel />}
      {tab === "events" && <EventsPanel />}
      {tab === "careers" && <CareersPanel />}
      {tab === "settings" && <RecruitmentSettingsPanel />}
    </div>
  );
}
