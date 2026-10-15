import { useState } from "react";
import { ReviewCyclesPanel } from "./ReviewCyclesPanel";
import { GoalsPanel } from "./GoalsPanel";
import { PerformanceReviewsPanel } from "./PerformanceReviewsPanel";
import { CalibrationPanel } from "./CalibrationPanel";
import { FeedbackPanel } from "./FeedbackPanel";
import { DevelopmentPlansPanel } from "./DevelopmentPlansPanel";
import { PerformanceSetupPanel } from "./PerformanceSetupPanel";
import { useAuth } from "../../auth/AuthContext";

type Tab = "cycles" | "goals" | "reviews" | "calibration" | "feedback" | "development" | "setup";

export function PerformancePage() {
  const { identity } = useAuth();
  const isHr = (identity?.roleKeys ?? []).includes("hr_admin");
  const [activeTab, setActiveTab] = useState<Tab>("cycles");

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "cycles", label: "Review Cycles" },
    { key: "goals", label: "Goals" },
    { key: "reviews", label: "Performance Reviews" },
    { key: "calibration", label: "Calibration" },
    { key: "feedback", label: "Feedback" },
    { key: "development", label: "Development" },
    ...(isHr ? [{ key: "setup" as Tab, label: "Setup" }] : []),
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold tracking-tight mb-1">Performance</h1>

      {/* Tab navigation uses the shared accent/black-10 tokens (UI re-skin Phase 4). */}
      <div className="border-b border-black/10 overflow-x-auto">
        <nav className="flex gap-1 -mb-px" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={activeTab === t.key}
              onClick={() => setActiveTab(t.key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === t.key
                  ? "border-accent text-accent"
                  : "border-transparent text-label-secondary hover:text-label-primary hover:border-black/20"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="mt-6">
        {activeTab === "cycles" && <ReviewCyclesPanel />}
        {activeTab === "goals" && <GoalsPanel />}
        {activeTab === "reviews" && <PerformanceReviewsPanel />}
        {activeTab === "calibration" && <CalibrationPanel />}
        {activeTab === "feedback" && <FeedbackPanel />}
        {activeTab === "development" && <DevelopmentPlansPanel />}
        {activeTab === "setup" && isHr && <PerformanceSetupPanel />}
      </div>
    </div>
  );
}
