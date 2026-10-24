import { FormEvent, useCallback, useEffect, useState } from "react";
import type { EmployeeWorkProfileView, SetWorkProfileRequest, TimeRecordingProfile } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { formatDay } from "../shared/dates";
import { RECORDING_LABELS, workProfileProblem, workProfileSummary } from "./workProfile";

const field = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm";
const label = "block text-xs font-medium text-label-secondary mb-1";

/**
 * BACKLOG53 - the working-time profile of an employee: how much of a full-time job they work, their weekly hours and how their
 * time is recorded. Dated: a change starts on a date and the earlier profile keeps its own history.
 * HR (`canManage`) edits it; the employee sees their own, read-only. Hidden when the company does not use time management.
 */
export function WorkProfilePanel({ employeeId, canManage }: { employeeId: string; canManage: boolean }) {
  const [current, setCurrent] = useState<EmployeeWorkProfileView | null | undefined>(undefined);
  const [history, setHistory] = useState<EmployeeWorkProfileView[]>([]);
  const [hidden, setHidden] = useState(false);
  const [editing, setEditing] = useState(false);
  const [percent, setPercent] = useState("100");
  const [weekly, setWeekly] = useState("");
  const [monthly, setMonthly] = useState("");
  const [recording, setRecording] = useState<TimeRecordingProfile>("clock");
  const [notes, setNotes] = useState("");
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.getWorkProfile(employeeId).then((p) => setCurrent(p ?? null)).catch((err) => {
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) setHidden(true);
      setCurrent(null);
    });
    if (canManage) api.workProfileHistory(employeeId).then(setHistory).catch(() => setHistory([]));
  }, [employeeId, canManage]);
  useEffect(load, [load]);

  function startEdit() {
    setPercent(String(current?.employmentPercentage ?? 100));
    setWeekly(current?.weeklyHours != null ? String(current.weeklyHours) : "");
    setMonthly(current?.monthlyHours != null ? String(current.monthlyHours) : "");
    setRecording(current?.timeRecordingProfile ?? "clock");
    setNotes(current?.notes ?? "");
    setFrom(new Date().toISOString().slice(0, 10));
    setError(null);
    setEditing(true);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const problem = workProfileProblem({ percent, weekly, monthly });
    if (problem) return setError(problem);
    const body: SetWorkProfileRequest = {
      employmentPercentage: Number(percent),
      weeklyHours: weekly.trim() ? Number(weekly) : null,
      monthlyHours: monthly.trim() ? Number(monthly) : null,
      timeRecordingProfile: recording,
      notes: notes.trim() || null,
      effectiveFrom: from,
    };
    setBusy(true);
    setError(null);
    try {
      await api.setWorkProfile(employeeId, body);
      setEditing(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the work profile.");
    } finally {
      setBusy(false);
    }
  }

  if (hidden || current === undefined) return null;
  return (
    <section className="bg-card rounded-card p-5 shadow-sm mb-6" aria-label="Work profile" data-testid="work-profile">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">Work profile</h2>
        {canManage && !editing && <button onClick={startEdit} className="text-xs font-semibold text-accent hover:underline">{current ? "Change" : "Set up"}</button>}
      </div>
      {!editing && (
        current ? (
          <div>
            <div className="text-sm" data-testid="work-profile-summary">{workProfileSummary(current)}</div>
            <div className="text-xs text-label-tertiary mt-0.5">In force since {formatDay(current.effectiveFrom)}{current.notes ? ` · ${current.notes}` : ""}</div>
          </div>
        ) : (
          <p className="text-sm text-label-tertiary">No work profile recorded. The company's standard working time applies.</p>
        )
      )}
      {editing && (
        <form onSubmit={save} className="space-y-3" aria-label="Edit work profile">
          <div className="grid sm:grid-cols-4 gap-3">
            <div>
              <label htmlFor="wp-percent" className={label}>Share of a full-time job (%)</label>
              <input id="wp-percent" className={field} inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} />
            </div>
            <div>
              <label htmlFor="wp-weekly" className={label}>Hours per week</label>
              <input id="wp-weekly" className={field} inputMode="decimal" value={weekly} onChange={(e) => setWeekly(e.target.value)} />
            </div>
            <div>
              <label htmlFor="wp-monthly" className={label}>Hours per month (optional)</label>
              <input id="wp-monthly" className={field} inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
            </div>
            <div>
              <label htmlFor="wp-recording" className={label}>How time is recorded</label>
              <select id="wp-recording" className={field} value={recording} onChange={(e) => setRecording(e.target.value as TimeRecordingProfile)}>
                {Object.entries(RECORDING_LABELS).map(([k, text]) => <option key={k} value={k}>{text}</option>)}
              </select>
            </div>
            <div className="sm:col-span-3">
              <label htmlFor="wp-notes" className={label}>Note (optional)</label>
              <input id="wp-notes" className={field} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            <div>
              <label htmlFor="wp-from" className={label}>Starts on</label>
              <input id="wp-from" type="date" className={field} value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
          </div>
          {error && <div className="text-xs text-danger" role="alert">{error}</div>}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
            <button type="button" onClick={() => setEditing(false)} className="px-3 py-1.5 rounded-lg bg-black/5 text-sm font-medium">Cancel</button>
          </div>
        </form>
      )}
      {canManage && history.length > 1 && !editing && (
        <details className="mt-3">
          <summary className="text-xs font-medium text-label-secondary cursor-pointer">History ({history.length})</summary>
          <ul className="mt-2 space-y-1">
            {history.map((h) => (
              <li key={h.id} className="text-xs text-label-secondary">
                {formatDay(h.effectiveFrom)} to {h.effectiveTo ? formatDay(h.effectiveTo) : "now"}: {workProfileSummary(h)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
