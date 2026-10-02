import { useState } from "react";
import { ReviewCyclesPanel } from "./ReviewCyclesPanel";
import { GoalsPanel } from "./GoalsPanel";
import { PerformanceReviewsPanel } from "./PerformanceReviewsPanel";
import { CalibrationPanel } from "./CalibrationPanel";

type Tab = "cycles" | "goals" | "reviews" | "calibration";

export function PerformancePage() {
  const [activeTab, setActiveTab] = useState<Tab>("cycles");

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold tracking-tight mb-1">Performance</h1>

      {/* Tab Navigation — UI Re-skin Phase 4: moved off hardcoded
          blue-600/gray-200 onto the shared accent/black-10 tokens so this
          page follows the rest of the app's palette instead of a
          coincidentally-identical hardcoded blue. */}
      <div className="border-b border-black/10">
        <nav className="flex gap-1 -mb-px" role="tablist">
          <button
            role="tab"
            aria-selected={activeTab === "cycles"}
            onClick={() => setActiveTab("cycles")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "cycles"
                ? "border-accent text-accent"
                : "border-transparent text-label-secondary hover:text-label-primary hover:border-black/20"
            }`}
          >
            Review Cycles
          </button>

          <button
            role="tab"
            aria-selected={activeTab === "goals"}
            onClick={() => setActiveTab("goals")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "goals"
                ? "border-accent text-accent"
                : "border-transparent text-label-secondary hover:text-label-primary hover:border-black/20"
            }`}
          >
            Goals
          </button>

          <button
            role="tab"
            aria-selected={activeTab === "reviews"}
            onClick={() => setActiveTab("reviews")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "reviews"
                ? "border-accent text-accent"
                : "border-transparent text-label-secondary hover:text-label-primary hover:border-black/20"
            }`}
          >
            Performance Reviews
          </button>

          <button
            role="tab"
            aria-selected={activeTab === "calibration"}
            onClick={() => setActiveTab("calibration")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "calibration"
                ? "border-accent text-accent"
                : "border-transparent text-label-secondary hover:text-label-primary hover:border-black/20"
            }`}
          >
            Calibration
          </button>
        </nav>
      </div>

      {/* Tab Content */}
      <div className="mt-6">
        {activeTab === "cycles" && <ReviewCyclesPanel />}
        {activeTab === "goals" && <GoalsPanel />}
        {activeTab === "reviews" && <PerformanceReviewsPanel />}
        {activeTab === "calibration" && <CalibrationPanel />}
      </div>
    </div>
  );
}
