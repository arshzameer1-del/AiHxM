import { useEffect, useState } from "react";
import type { TimesheetStatus, TimesheetView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { formatPeriod, formatWeekdayAndDate, todayIso } from "../shared/dates";

const STATUS_LABELS: Record<TimesheetStatus, string> = {
  draft: "Draft",
  pending: "Waiting for approval",
  approved: "Approved",
  rejected: "Rejected",
  returned: "Sent back to you",
  cancelled: "Cancelled",
};

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function hoursOf(minutes: number): string {
  return (minutes / 60).toFixed(2).replace(/\.?0+$/, "") || "0";
}

/**
 * TLM-06 - the weekly timesheet. Hours are typed per day, compared with what the clock recorded,
 * then submitted to the approver (workflow engine when a Timesheet template exists, otherwise the
 * direct manager).
 */
export function MyTimesheet({ employeeId }: { employeeId: string }) {
  const [week, setWeek] = useState(() => todayIso());
  const [sheet, setSheet] = useState<TimesheetView | null>(null);
  const [hours, setHours] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function apply(t: TimesheetView) {
    setSheet(t);
    const next: Record<string, string> = {};
    for (const e of t.entries) next[e.workDate] = hoursOf(e.minutes);
    setHours(next);
  }

  useEffect(() => {
    setError(null);
    api
      .timesheetForWeek(employeeId, week)
      .then(apply)
      .catch((err) => setError(err instanceof ApiError && err.status === 403 ? "" : "Could not load the timesheet."));
  }, [employeeId, week]);

  if (error === "") return null;
  if (!sheet) return error ? <p className="text-sm text-danger mt-6">{error}</p> : null;

  const days = Array.from({ length: 7 }, (_, i) => addDays(sheet.periodStart, i));
  const editable = sheet.status === "draft" || sheet.status === "returned";
  const totalMinutes = days.reduce((sum, d) => sum + Math.round((Number(hours[d]) || 0) * 60), 0);

  async function run(fn: () => Promise<TimesheetView>) {
    setBusy(true);
    setError(null);
    try {
      apply(await fn());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  const entries = () =>
    days
      .filter((d) => Number(hours[d]) > 0)
      .map((d) => ({ workDate: d, minutes: Math.round(Number(hours[d]) * 60) }));

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <h3 className="text-xs uppercase tracking-wide text-label-tertiary font-semibold">Timesheet</h3>
        <div className="flex items-center gap-2 text-sm">
          <button className="px-2 py-1 rounded-lg hover:bg-black/5" aria-label="Previous week" onClick={() => setWeek(addDays(sheet.periodStart, -7))}>‹</button>
          <span className="tabular-nums">{formatPeriod(sheet.periodStart, sheet.periodEnd)}</span>
          <button className="px-2 py-1 rounded-lg hover:bg-black/5" aria-label="Next week" onClick={() => setWeek(addDays(sheet.periodStart, 7))}>›</button>
          <span className="ml-2 text-xs font-semibold px-2 py-0.5 rounded-full bg-black/5">{STATUS_LABELS[sheet.status]}</span>
        </div>
      </div>
      {error && <p className="text-sm text-danger mb-2">{error}</p>}
      {sheet.decisionComment && <p className="text-xs text-label-secondary mb-2">Approver's note: {sheet.decisionComment}</p>}
      <div className="grid grid-cols-7 gap-2">
        {days.map((d) => (
          <div key={d} className="text-center">
            <label htmlFor={`ts-${d}`} className="block text-xs text-label-tertiary mb-1">
              {formatWeekdayAndDate(d)}
            </label>
            <input
              id={`ts-${d}`}
              inputMode="decimal"
              disabled={!editable || busy}
              value={hours[d] ?? ""}
              onChange={(e) => setHours({ ...hours, [d]: e.target.value })}
              placeholder="0"
              className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm text-center tabular-nums disabled:bg-black/5"
            />
            <div className="text-[11px] text-label-tertiary mt-1 tabular-nums">
              clock {hoursOf(sheet.recordedMinutesByDay[d] ?? 0)}h
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
        <span className="text-sm tabular-nums">Total {hoursOf(totalMinutes)} h</span>
        <div className="flex gap-3">
          {editable && (
            <>
              <button disabled={busy} onClick={() => run(() => api.saveTimesheetEntries(sheet.id, { entries: entries() }))} className="text-sm font-semibold text-accent disabled:opacity-50">
                Save draft
              </button>
              <button
                disabled={busy}
                onClick={() => run(async () => { await api.saveTimesheetEntries(sheet.id, { entries: entries() }); return api.submitTimesheet(sheet.id); })}
                className="bg-accent text-white rounded-lg px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
              >
                Submit for approval
              </button>
            </>
          )}
          {sheet.status === "pending" && (
            <button disabled={busy} onClick={() => run(() => api.cancelTimesheet(sheet.id))} className="text-sm font-semibold text-danger disabled:opacity-50">
              Withdraw
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
