import { useEffect, useState } from "react";
import type { EmployeeAnalyticsSummary, EmployeeHeadcountBreakdown } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

/**
 * Core Employee Enterprise Phase 12's frontend catch-up (2026-09-27) —
 * `GET /employees/analytics/summary` had no UI. Follows the same
 * "one stat-tile row + breakdown lists" layout `PortalHomePage.tsx`'s own
 * Organization Command Center panel already established for this app's
 * one other summary-dashboard screen — this app has no charting library
 * (no recharts/d3/chart.js anywhere), so breakdowns are simple ranked
 * lists with a lightweight bar, not a chart.
 */
function Breakdown({ title, rows }: { title: string; rows: EmployeeHeadcountBreakdown[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-2">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-label-tertiary">No data.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.key} className="flex items-center gap-3">
              <div className="w-32 shrink-0 text-sm truncate">{row.key}</div>
              <div className="flex-1 bg-black/5 rounded-full h-2 overflow-hidden">
                <div className="bg-accent h-2 rounded-full" style={{ width: `${(row.count / max) * 100}%` }} />
              </div>
              <div className="w-8 text-right text-sm font-mono tabular-nums text-label-secondary">{row.count}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatTile({ label, value, tone }: { label: string; value: string | number; tone?: "warning" | "danger" }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-label-tertiary">{label}</div>
      <div className={`text-xl font-bold ${tone === "warning" ? "text-warning" : tone === "danger" ? "text-danger" : ""}`}>
        {value}
      </div>
    </div>
  );
}

export function WorkforceAnalyticsPage() {
  const [summary, setSummary] = useState<EmployeeAnalyticsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getWorkforceAnalyticsSummary()
      .then(setSummary)
      .catch((err) => setError(err instanceof ApiError && err.status === 403 ? "Requires HR Admin." : "Could not load workforce analytics."));
  }, []);

  if (error) return <div className="text-danger text-sm">{error}</div>;
  if (!summary) return <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold tracking-tight mb-1">Workforce Analytics</h1>
      <p className="text-label-tertiary text-sm mb-6">
        Generated {new Date(summary.generatedAt).toLocaleString()}
      </p>

      <section className="bg-card rounded-card p-5 shadow-sm mb-6">
        <div className="flex flex-wrap gap-8">
          <StatTile label="Active employees" value={summary.totalActiveEmployees} />
          <StatTile
            label="Avg. tenure"
            value={summary.averageTenureYears === null ? "—" : `${summary.averageTenureYears} yrs`}
          />
          <StatTile label="Terminations (90d)" value={summary.terminationsLast90Days} tone={summary.terminationsLast90Days > 0 ? "warning" : undefined} />
          <StatTile
            label="Dates due (30d)"
            value={summary.upcomingImportantDatesNext30Days}
            tone={summary.upcomingImportantDatesNext30Days > 0 ? "warning" : undefined}
          />
          <StatTile label="Assets assigned" value={summary.assetsCurrentlyAssigned} />
        </div>
      </section>

      <section className="bg-card rounded-card p-5 shadow-sm space-y-6">
        <Breakdown title="Headcount by department" rows={summary.headcountByDepartment} />
        <Breakdown title="Headcount by employment type" rows={summary.headcountByEmploymentType} />
        <Breakdown title="Gender breakdown" rows={summary.genderBreakdown} />
      </section>
    </div>
  );
}
