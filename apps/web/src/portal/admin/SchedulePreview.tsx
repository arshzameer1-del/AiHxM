import { useEffect, useState } from "react";
import type { EmployeeView, ResolvedWorkScheduleView } from "@boostfactor/shared-types";
import { api, ApiError } from "../../api/client";

const ASSIGNMENT_SOURCE_LABELS: Record<NonNullable<ResolvedWorkScheduleView["assignmentSource"]>, string> = {
  individual: "Direct assignment",
  temporary: "Temporary assignment",
  rule: "Assignment rule",
  default: "Company default",
};

/**
 * Section 36's `GET /employees/:id/work-schedule?date=` preview (WS-024,
 * "Schedule Preview") — lets HR check, before relying on it, exactly
 * what `WorkScheduleResolutionService` will resolve for a given employee
 * on a given date: which schedule applies, via what source (a direct
 * assignment beats a rule beats the company default — the same 3-tier
 * precedence `ShiftsService.resolveForEmployeeOnDate` implements), and
 * whether a holiday or rest day overrides it. Read-only — this screen
 * changes nothing, it only shows what resolution already decided.
 *
 * WS-025's Conflict Detection (flagging two active rules that could both
 * match the same employee) is deliberately NOT built here — this preview
 * already answers "what does one employee get on one date," which is
 * the more common real question, and a dedicated conflict-detection pass
 * across every rule combination is real, separate work with no concrete
 * demand yet, consistent with the "don't over-build ahead of need"
 * discipline every prior engine/UI increment in this roadmap has followed.
 */
export function SchedulePreview() {
  const [employees, setEmployees] = useState<EmployeeView[] | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [result, setResult] = useState<ResolvedWorkScheduleView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.listEmployees().then(setEmployees).catch(() => setEmployees([]));
  }, []);

  async function handlePreview() {
    if (!employeeId) return;
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const resolved = await api.getEmployeeWorkSchedule(employeeId, date);
      setResult(resolved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not resolve a schedule for this employee/date.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-card rounded-card p-5 shadow-sm space-y-4">
      <div>
        <h2 className="font-semibold">Schedule preview</h2>
        <p className="text-sm text-label-tertiary mt-0.5">
          Check exactly what applies to one employee on one date, before an employee actually clocks in.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[14rem]">
          <label className="block text-xs font-medium mb-1">Employee</label>
          <select
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="" disabled>
              Select an employee…
            </option>
            {(employees ?? []).map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.firstName} {emp.lastName} ({emp.employeeNumber})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-lg border border-black/10 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <button
          onClick={handlePreview}
          disabled={!employeeId || loading}
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {loading ? "Resolving…" : "Preview"}
        </button>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      {result && (
        <div className="bg-black/5 rounded-lg p-4 space-y-3">
          <div className="flex flex-wrap gap-1.5">
            <span
              className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                result.isMandatoryHoliday
                  ? "bg-danger/10 text-danger"
                  : !result.isWorking
                    ? "bg-black/10 text-label-secondary"
                    : "bg-success/15 text-green-700"
              }`}
            >
              {result.isMandatoryHoliday ? "Mandatory holiday" : result.isWorking ? "Working day" : "Rest day"}
            </span>
            {result.isHoliday && !result.isMandatoryHoliday && (
              <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-accent/10 text-accent">
                Optional holiday{result.holidayName ? `: ${result.holidayName}` : ""}
              </span>
            )}
            {result.isMandatoryHoliday && result.holidayName && (
              <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-medium bg-black/5 text-label-secondary">
                {result.holidayName}
              </span>
            )}
            {result.isHalfDay && (
              <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-black/5 text-label-secondary">
                Half day
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary mb-0.5">Schedule</div>
              <div>{result.hasSchedule ? result.scheduleName : "None configured"}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary mb-0.5">Source</div>
              <div>{result.assignmentSource ? ASSIGNMENT_SOURCE_LABELS[result.assignmentSource] : "—"}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary mb-0.5">Hours</div>
              <div className="font-mono">
                {result.isWorking && result.startTime && result.endTime
                  ? `${result.startTime.slice(0, 5)}–${result.endTime.slice(0, 5)}${result.crossesMidnight ? " (+1d)" : ""}`
                  : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary mb-0.5">Grace (late / early)</div>
              <div className="font-mono">
                {result.graceMinutesLate}m / {result.graceMinutesEarly}m
              </div>
            </div>
          </div>

          {result.assignmentRuleName && (
            <p className="text-xs text-label-tertiary">
              Matched via assignment rule: <span className="font-medium text-label-secondary">{result.assignmentRuleName}</span>
            </p>
          )}

          {result.breaks.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary mb-1">Breaks</div>
              <div className="flex flex-wrap gap-1.5">
                {result.breaks.map((b, i) => (
                  <span key={i} className="text-xs font-mono bg-card rounded px-2 py-0.5">
                    {b.startTime.slice(0, 5)}–{b.endTime.slice(0, 5)}
                    {b.isPaid ? "" : " (unpaid)"}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
