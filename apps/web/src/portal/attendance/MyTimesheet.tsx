import { useEffect, useState } from "react";
import { CalendarCheck, CalendarDays, Hourglass, Play, Square, Target, Trophy } from "lucide-react";
import type { TimesheetStatus, TimesheetView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { ApprovalStepper } from "../../components/ApprovalStepper";
import { StatTile } from "../../components/StatTile";
import { formatPeriod, formatWeekdayAndDate, todayIso } from "../shared/dates";
import type { DayKind } from "./attendanceDays";
import { useMyAttendance } from "./useMyAttendance";
import { timesheetStepper, weekTarget } from "./timesheetView";
import { useWorkTimer } from "./useWorkTimer";
import { clearTimer, mergeIntoDay, minutesToLog, timerText } from "./workTimer";

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

function hoursClock(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(Math.round(minutes % 60)).padStart(2, "0")}`;
}

function isWeekend(day: string): boolean {
  const w = new Date(`${day}T00:00:00Z`).getUTCDay();
  return w === 0 || w === 6;
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
  const attendance = useMyAttendance(employeeId);
  const workTimer = useWorkTimer(employeeId);
  const [timerLabel, setTimerLabel] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});

  function apply(t: TimesheetView) {
    setSheet(t);
    const next: Record<string, string> = {};
    const note: Record<string, string> = {};
    const minutesByDay = new Map<string, number>();
    for (const e of t.entries) {
      const day = e.workDate.slice(0, 10);
      minutesByDay.set(day, (minutesByDay.get(day) ?? 0) + e.minutes);
      if (e.description) note[day] = [...new Set([...(note[day] ? note[day].split("; ") : []), e.description])].join("; ");
    }
    for (const [day, minutes] of minutesByDay) next[day] = hoursOf(minutes);
    setHours(next);
    setNotes(note);
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
  const minutesOf = (d: string) => Math.round((Number(hours[d]) || 0) * 60);
  const totalMinutes = days.reduce((sum, d) => sum + minutesOf(d), 0);
  const kindOf = (d: string): DayKind | undefined => attendance.days.get(d)?.kind;
  const target = weekTarget(days, kindOf);
  const todayKey = todayIso();
  const stepper = timesheetStepper(sheet.status);
  const percent = target.minutes > 0 ? Math.min(100, Math.round((totalMinutes / target.minutes) * 100)) : 0;
  const extra = totalMinutes > target.minutes;
  const daysLogged = target.workingDates.filter((d) => minutesOf(d) > 0).length;

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

  async function stopWorkTimer() {
    if (!workTimer.timer) return;
    const minutes = minutesToLog(workTimer.seconds);
    if (minutes === 0) {
      clearTimer();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const todaySheet = await api.timesheetForWeek(employeeId, todayIso());
      if (todaySheet.status !== "draft" && todaySheet.status !== "returned") {
        setError(`This week is already ${STATUS_LABELS[todaySheet.status].toLowerCase()}, so ${minutes} min could not be added. Keep the timer running, or discard it.`);
        return;
      }
      const saved = await api.saveTimesheetEntries(todaySheet.id, { entries: mergeIntoDay(todaySheet.entries, todayIso(), minutes, workTimer.timer.label) });
      clearTimer();
      setTimerLabel("");
      if (sheet && saved.periodStart === sheet.periodStart) apply(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add the timer's time. It is still running.");
    } finally {
      setBusy(false);
    }
  }

  const entries = () =>
    days
      .filter((d) => Number(hours[d]) > 0)
      .map((d) => ({ workDate: d, minutes: Math.round(Number(hours[d]) * 60), description: notes[d] || null }));

  return (
    <div className="mt-6" data-testid="timesheet-week">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <div className="flex items-center gap-2 text-sm">
          <button className="ts-today px-3 py-1.5 rounded-lg border border-black/10 font-semibold hover:bg-black/5" data-testid="ts-today" onClick={() => setWeek(todayIso())}>
            Today
          </button>
          <button className="px-2 py-1 rounded-lg hover:bg-black/5" aria-label="Previous week" onClick={() => setWeek(addDays(sheet.periodStart, -7))}>‹</button>
          <button className="px-2 py-1 rounded-lg hover:bg-black/5" aria-label="Next week" onClick={() => setWeek(addDays(sheet.periodStart, 7))}>›</button>
          <span className="tabular-nums font-semibold" data-testid="ts-period">{formatPeriod(sheet.periodStart, sheet.periodEnd)}</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-black/5 font-semibold"><CalendarDays size={12} aria-hidden /> Mon – Fri</span>
          <span className="font-semibold px-2 py-1 rounded-full bg-accent/10 text-accent" data-testid="ts-status">{STATUS_LABELS[sheet.status]}</span>
        </div>
      </div>

      <div className="work-timer rounded-card border border-black/5 bg-card shadow-sm px-4 py-3 mb-3 flex items-center gap-3 flex-wrap" data-testid="work-timer">
        {workTimer.timer ? (
          <button type="button" disabled={busy} onClick={stopWorkTimer} className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold bg-danger/10 text-danger disabled:opacity-50" data-testid="timer-stop">
            <Square size={14} aria-hidden /> Stop
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={() => workTimer.start(timerLabel)} className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold bg-accent text-white disabled:opacity-50" data-testid="timer-start">
            <Play size={14} aria-hidden /> Start
          </button>
        )}
        <span className="font-mono text-lg tabular-nums" data-testid="timer-clock" aria-live="off">{timerText(workTimer.seconds)}</span>
        <label htmlFor="timer-label" className="sr-only">What are you working on</label>
        <input
          id="timer-label"
          value={workTimer.timer ? workTimer.timer.label : timerLabel}
          onChange={(e) => setTimerLabel(e.target.value)}
          disabled={Boolean(workTimer.timer)}
          maxLength={120}
          placeholder="What are you working on?"
          className="flex-1 min-w-[12rem] rounded-lg border border-black/10 px-3 py-2 text-sm disabled:bg-black/5"
        />
        {workTimer.timer && (
          <button type="button" onClick={() => { clearTimer(); }} className="text-xs text-label-tertiary hover:text-danger" data-testid="timer-discard">Discard</button>
        )}
        <p className="basis-full text-xs text-label-tertiary">Stop adds the time to today in this timesheet. The running time also shows in the top bar.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3" data-testid="ts-tiles">
        <StatTile icon={CalendarCheck} value={hoursClock(totalMinutes)} label="Logged" testId="ts-logged" />
        <StatTile icon={Target} value={hoursClock(target.minutes)} label="Target" testId="ts-target" />
        <StatTile icon={extra ? Trophy : Hourglass} value={hoursClock(Math.abs(target.minutes - totalMinutes))} label={extra ? "Extra" : "Remaining"} testId="ts-remaining" />
        <StatTile icon={CalendarDays} value={`${daysLogged} / ${target.workingDates.length}`} label="Days logged" testId="ts-days" />
      </div>
      <div className="flex items-center gap-3 mb-4" aria-label={`Progress ${percent}%`}>
        <span className="text-xs uppercase tracking-wide text-label-tertiary">Progress</span>
        <div className="flex-1 h-2 rounded-full bg-black/10 overflow-hidden">
          <div className={`h-full rounded-full ${extra ? "bg-success" : "bg-accent"}`} style={{ width: `${percent}%` }} />
        </div>
        <span className="text-xs font-semibold tabular-nums" data-testid="ts-percent">{percent}%</span>
      </div>

      <div className="mb-4 rounded-lg border border-black/5 px-4 py-3" data-testid="ts-approval">
        <div className="text-xs uppercase tracking-wide text-label-tertiary mb-1">Approval · {formatPeriod(sheet.periodStart, sheet.periodEnd)}</div>
        <ApprovalStepper steps={stepper.steps} current={stepper.current} failed={stepper.failed} title="Timesheet approval" />
        <p className="text-xs text-label-secondary mt-1">{stepper.note}</p>
      </div>

      {error && <p className="text-sm text-danger mb-2">{error}</p>}
      {sheet.decisionComment && <p className="text-xs text-label-secondary mb-2">Approver's note: {sheet.decisionComment}</p>}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
        {days.map((d) => {
          const kind = kindOf(d);
          const marker = kind === "holiday" ? "Holiday" : kind === "leave" ? "Time off" : kind === "absent" ? "Absent" : null;
          const weekend = !target.workingDates.includes(d) && !marker && isWeekend(d);
          const m = minutesOf(d);
          return (
            <div
              key={d}
              data-testid={`ts-day-${d}`}
              className={`ts-day rounded-lg border px-2 py-2 text-center ${d === todayKey ? "is-today" : ""} ${weekend ? "is-weekend" : ""} ${marker ? `is-${marker === "Time off" ? "leave" : marker.toLowerCase()}` : ""}`}
            >
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
              {notes[d] && <div className="text-[11px] text-label-secondary mt-1 truncate" title={notes[d]} data-testid={`ts-note-${d}`}>{notes[d]}</div>}
              <div className="ts-bar mt-1.5" aria-hidden="true"><span style={{ width: `${Math.min(100, (m / 480) * 100)}%` }} /></div>
              {marker && <div className="ts-marker mt-1" data-testid={`ts-marker-${d}`}>{marker}</div>}
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
        <span className="text-sm tabular-nums" data-testid="ts-total">Total {hoursOf(totalMinutes)} h</span>
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
