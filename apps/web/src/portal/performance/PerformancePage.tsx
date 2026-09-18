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

      {/* Tab Navigation */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-1 -mb-px" role="tablist">
          <button
            role="tab"
            aria-selected={activeTab === "cycles"}
            onClick={() => setActiveTab("cycles")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "cycles"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300"
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
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300"
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
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300"
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
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300"
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
