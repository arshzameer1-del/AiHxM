import { useEffect, useMemo, useState } from "react";
import { CalendarCheck, CalendarDays, Hourglass, Play, Plus, Square, Target, Trophy, X } from "lucide-react";
import type { CostCenterView, TimesheetStatus, TimesheetView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { ApprovalStepper } from "../../components/ApprovalStepper";
import { StatTile } from "../../components/StatTile";
import { formatMonthYear, formatPeriod, formatWeekdayAndDate, todayIso } from "../shared/dates";
import type { DayKind } from "./attendanceDays";
import { useMyAttendance } from "./useMyAttendance";
import { timesheetStepper, weekTarget } from "./timesheetView";
import { dayTotals, emptyLine, entriesFromLines, hoursOf, lineTotal, linesFromEntries, minutesByDay, monthGrid, shiftMonth, type TimesheetLine } from "./timesheetLines";
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

const WEEKDAY_HEADS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * TLM-06 - the timesheet. A week is a set of lines (project and task) with hours for each day, compared with what the clock
 * recorded, then submitted to the approver (workflow engine when a Timesheet template exists, otherwise the direct manager).
 * The Month view shows the sheets already created as a calendar with the month's totals.
 */
export function MyTimesheet({ employeeId }: { employeeId: string }) {
  const [week, setWeek] = useState(() => todayIso());
  const [view, setView] = useState<"week" | "month">("week");
  const [monthDay, setMonthDay] = useState(() => todayIso());
  const [monthSheets, setMonthSheets] = useState<TimesheetView[] | null>(null);
  const [sheet, setSheet] = useState<TimesheetView | null>(null);
  const [lines, setLines] = useState<TimesheetLine[]>([emptyLine()]);
  const [costCenters, setCostCenters] = useState<CostCenterView[]>([]);
  const [showWeekend, setShowWeekend] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const attendance = useMyAttendance(employeeId);
  const workTimer = useWorkTimer(employeeId);
  const [timerLabel, setTimerLabel] = useState("");

  function apply(t: TimesheetView) {
    setSheet(t);
    setLines(linesFromEntries(t.entries));
    setMonthSheets(null);
  }

  useEffect(() => {
    setError(null);
    api
      .timesheetForWeek(employeeId, week)
      .then(apply)
      .catch((err) => setError(err instanceof ApiError && err.status === 403 ? "" : "Could not load the timesheet."));
  }, [employeeId, week]);

  // Projects are the company's cost centres. Not everyone may read them; without access the Project column is simply not shown.
  useEffect(() => {
    api.listCostCenters().then((c) => setCostCenters(c.filter((x) => x.status === "active"))).catch(() => setCostCenters([]));
  }, []);

  useEffect(() => {
    if (view !== "month" || monthSheets) return;
    let cancelled = false;
    api
      .listTimesheets({ employeeId })
      .then((s) => !cancelled && setMonthSheets(s))
      .catch(() => !cancelled && setMonthSheets([]));
    return () => {
      cancelled = true;
    };
  }, [view, monthSheets, employeeId]);

  const days = useMemo(() => (sheet ? Array.from({ length: 7 }, (_, i) => addDays(sheet.periodStart, i)) : []), [sheet]);

  if (error === "") return null;
  if (!sheet) return error ? <p className="text-sm text-danger mt-6">{error}</p> : null;

  const editable = sheet.status === "draft" || sheet.status === "returned";
  const totalsByDay = dayTotals(lines, days);
  const minutesOf = (d: string) => totalsByDay[d] ?? 0;
  const totalMinutes = days.reduce((sum, d) => sum + minutesOf(d), 0);
  const kindOf = (d: string): DayKind | undefined => attendance.days.get(d)?.kind;
  const target = weekTarget(days, kindOf);
  const todayKey = todayIso();
  const stepper = timesheetStepper(sheet.status);
  const percent = target.minutes > 0 ? Math.min(100, Math.round((totalMinutes / target.minutes) * 100)) : 0;
  const extra = totalMinutes > target.minutes;
  const daysLogged = target.workingDates.filter((d) => minutesOf(d) > 0).length;
  const weekendVisible = showWeekend || days.some((d) => isWeekend(d) && (minutesOf(d) > 0 || d === todayKey));
  const shownDays = weekendVisible ? days : days.filter((d) => !isWeekend(d));

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
      else setMonthSheets(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add the timer's time. It is still running.");
    } finally {
      setBusy(false);
    }
  }

  const entries = () => entriesFromLines(lines, days);
  const patchLine = (key: string, patch: Partial<TimesheetLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const setCell = (key: string, day: string, value: string) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, hours: { ...l.hours, [day]: value } } : l)));
  const removeLine = (key: string) => setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : [emptyLine()]));
  const showProject = costCenters.length > 0 || lines.some((l) => l.costCenterId);

  const legend = (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-label-secondary mt-2" data-testid="ts-legend" aria-label="Legend">
      <span><span className="inline-block w-2.5 h-2.5 rounded-sm border border-accent align-middle mr-1" />Today</span>
      <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-black/10 align-middle mr-1" />Day off</span>
      <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-orange-500/30 align-middle mr-1" />Time off</span>
      <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-500/30 align-middle mr-1" />Holiday</span>
      <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-danger/30 align-middle mr-1" />Absent</span>
    </div>
  );

  const viewSwitch = (
    <div className="inline-flex rounded-lg border border-black/10 overflow-hidden text-xs font-semibold" role="group" aria-label="Timesheet view">
      {(["week", "month"] as const).map((v) => (
        <button
          key={v}
          type="button"
          data-testid={`ts-view-${v}`}
          aria-pressed={view === v}
          onClick={() => setView(v)}
          className={`px-3 py-1.5 ${view === v ? "bg-accent text-white" : "hover:bg-black/5"}`}
        >
          {v === "week" ? "Week" : "Month"}
        </button>
      ))}
    </div>
  );

  const timerBox = (
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
        placeholder="Task, for example Payroll run"
        className="flex-1 min-w-[12rem] rounded-lg border border-black/10 px-3 py-2 text-sm disabled:bg-black/5"
      />
      {workTimer.timer && (
        <button type="button" onClick={() => { clearTimer(); }} className="text-xs text-label-tertiary hover:text-danger" data-testid="timer-discard">Discard</button>
      )}
      <p className="basis-full text-xs text-label-tertiary">Stop adds the time to today, on the line for this task. The running time also shows in the top bar.</p>
    </div>
  );

  // ------------------------------------------------------------------ Month view
  if (view === "month") {
    const grid = monthGrid(monthDay);
    const perDay = minutesByDay(monthSheets ?? []);
    const monthDays = grid.cells.filter((c) => c.inMonth).map((c) => c.day);
    const working = monthDays.filter((d) => !isWeekend(d) && kindOf(d) !== "holiday" && kindOf(d) !== "leave");
    const loggedMonth = monthDays.reduce((sum, d) => sum + (perDay[d] ?? 0), 0);
    const targetMonth = working.length * 8 * 60;
    const extraMonth = loggedMonth > targetMonth;
    const loggedDays = working.filter((d) => (perDay[d] ?? 0) > 0).length;
    return (
      <div className="mt-6" data-testid="timesheet-month">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div className="flex items-center gap-2 text-sm">
            <button className="px-3 py-1.5 rounded-lg border border-black/10 font-semibold hover:bg-black/5" data-testid="ts-month-today" onClick={() => setMonthDay(todayIso())}>This month</button>
            <button className="px-2 py-1 rounded-lg hover:bg-black/5" aria-label="Previous month" onClick={() => setMonthDay(shiftMonth(monthDay, -1))}>‹</button>
            <button className="px-2 py-1 rounded-lg hover:bg-black/5" aria-label="Next month" onClick={() => setMonthDay(shiftMonth(monthDay, 1))}>›</button>
            <span className="font-semibold" data-testid="ts-month-title">{formatMonthYear(monthDay)}</span>
          </div>
          {viewSwitch}
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3" data-testid="ts-month-tiles">
          <StatTile icon={CalendarCheck} value={hoursClock(loggedMonth)} label="Logged" testId="ts-month-logged" />
          <StatTile icon={Target} value={hoursClock(targetMonth)} label="Target" testId="ts-month-target" />
          <StatTile icon={extraMonth ? Trophy : Hourglass} value={hoursClock(Math.abs(targetMonth - loggedMonth))} label={extraMonth ? "Extra" : "Remaining"} testId="ts-month-remaining" />
          <StatTile icon={CalendarDays} value={`${loggedDays} / ${working.length}`} label="Days logged" testId="ts-month-days" />
        </div>
        {!monthSheets ? (
          <p className="text-sm text-label-tertiary">Loading the month…</p>
        ) : (
          <div className="overflow-x-auto">
            <div className="grid grid-cols-7 gap-1.5 min-w-[560px]" role="grid" aria-label="Month calendar">
              {WEEKDAY_HEADS.map((w) => <div key={w} className="text-xs text-label-tertiary text-center py-1" role="columnheader">{w}</div>)}
              {grid.cells.map(({ day, inMonth }) => {
                const kind = kindOf(day);
                const marker = kind === "holiday" ? "Holiday" : kind === "leave" ? "Time off" : kind === "absent" ? "Absent" : null;
                const m = perDay[day] ?? 0;
                return (
                  <button
                    key={day}
                    type="button"
                    data-testid={`ts-month-${day}`}
                    onClick={() => { setWeek(day); setView("week"); }}
                    title="Open this week"
                    className={`ts-day rounded-lg border px-2 py-2 text-center ${day === todayKey ? "is-today" : ""} ${isWeekend(day) ? "is-weekend" : ""} ${marker ? `is-${marker === "Time off" ? "leave" : marker.toLowerCase()}` : ""} ${inMonth ? "" : "opacity-40"}`}
                  >
                    <div className="text-xs text-label-tertiary">{Number(day.slice(8))}</div>
                    <div className="text-sm font-semibold tabular-nums">{m > 0 ? `${hoursOf(m)} h` : "·"}</div>
                    <div className="ts-bar mt-1" aria-hidden="true"><span style={{ width: `${Math.min(100, (m / 480) * 100)}%` }} /></div>
                    {marker && <div className="ts-marker mt-1">{marker}</div>}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {legend}
        <p className="text-xs text-label-tertiary mt-2">Click a day to open its week. Weeks you have not opened yet show no hours.</p>
      </div>
    );
  }

  // ------------------------------------------------------------------ Week view
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
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <button
            type="button"
            onClick={() => setShowWeekend(!weekendVisible)}
            disabled={days.some((d) => isWeekend(d) && (minutesOf(d) > 0 || d === todayKey))}
            aria-pressed={weekendVisible}
            data-testid="ts-weekend-toggle"
            title={weekendVisible ? "Hide Saturday and Sunday" : "Show Saturday and Sunday"}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-black/5 font-semibold hover:bg-black/10 disabled:cursor-default disabled:hover:bg-black/5"
          >
            <CalendarDays size={12} aria-hidden /> {weekendVisible ? "All days" : "Mon – Fri"}
          </button>
          <span className="font-semibold px-2 py-1 rounded-full bg-accent/10 text-accent" data-testid="ts-status">{STATUS_LABELS[sheet.status]}</span>
          {viewSwitch}
        </div>
      </div>

      {timerBox}

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

      <div className="overflow-x-auto">
        <table className="w-full text-sm border-separate border-spacing-x-1.5 border-spacing-y-1.5 min-w-[680px]" data-testid="ts-lines">
          <thead>
            <tr>
              {showProject && <th scope="col" className="text-left text-xs font-semibold uppercase tracking-wide text-label-tertiary w-36">Project</th>}
              <th scope="col" className="text-left text-xs font-semibold uppercase tracking-wide text-label-tertiary">Task</th>
              {shownDays.map((d) => {
                const kind = kindOf(d);
                const marker = kind === "holiday" ? "Holiday" : kind === "leave" ? "Time off" : kind === "absent" ? "Absent" : null;
                const weekend = !target.workingDates.includes(d) && !marker && isWeekend(d);
                return (
                  <th
                    key={d}
                    scope="col"
                    data-testid={`ts-day-${d}`}
                    className={`ts-day rounded-lg border px-1.5 py-1.5 text-center text-xs font-normal text-label-tertiary w-[4.5rem] ${d === todayKey ? "is-today" : ""} ${weekend ? "is-weekend" : ""} ${marker ? `is-${marker === "Time off" ? "leave" : marker.toLowerCase()}` : ""}`}
                  >
                    {formatWeekdayAndDate(d)}
                    {marker && <div className="ts-marker mt-0.5" data-testid={`ts-marker-${d}`}>{marker}</div>}
                  </th>
                );
              })}
              <th scope="col" className="text-right text-xs font-semibold uppercase tracking-wide text-label-tertiary w-16">Total</th>
              {editable && <th scope="col" className="w-8"><span className="sr-only">Remove line</span></th>}
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <tr key={line.key} data-testid={`ts-line-${i}`}>
                {showProject && (
                  <td className="align-top">
                    <label htmlFor={`ts-project-${i}`} className="sr-only">Project for line {i + 1}</label>
                    <select
                      id={`ts-project-${i}`}
                      data-testid={`ts-project-${i}`}
                      disabled={!editable || busy}
                      value={line.costCenterId ?? ""}
                      onChange={(e) => patchLine(line.key, { costCenterId: e.target.value || null })}
                      className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm disabled:bg-black/5"
                    >
                      <option value="">No project</option>
                      {costCenters.map((c) => <option key={c.id} value={c.id}>{c.code ? `${c.code} · ${c.name}` : c.name}</option>)}
                      {line.costCenterId && !costCenters.some((c) => c.id === line.costCenterId) && <option value={line.costCenterId}>Project (inactive)</option>}
                    </select>
                  </td>
                )}
                <td className="align-top">
                  <label htmlFor={`ts-task-${i}`} className="sr-only">Task for line {i + 1}</label>
                  <input
                    id={`ts-task-${i}`}
                    data-testid={`ts-task-${i}`}
                    disabled={!editable || busy}
                    value={line.task}
                    maxLength={120}
                    onChange={(e) => patchLine(line.key, { task: e.target.value })}
                    placeholder="Task"
                    className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm disabled:bg-black/5"
                  />
                  <label htmlFor={`ts-desc-${i}`} className="sr-only">Description for line {i + 1}</label>
                  <input
                    id={`ts-desc-${i}`}
                    data-testid={`ts-desc-${i}`}
                    disabled={!editable || busy}
                    value={line.description}
                    maxLength={200}
                    onChange={(e) => patchLine(line.key, { description: e.target.value })}
                    placeholder="Description (optional)"
                    className="w-full mt-1 rounded-lg border border-black/10 px-2 py-1 text-xs disabled:bg-black/5"
                  />
                </td>
                {shownDays.map((d) => (
                  <td key={d} className="align-top">
                    <label htmlFor={i === 0 ? `ts-${d}` : `ts-${line.key}-${d}`} className="sr-only">{formatWeekdayAndDate(d)} hours, line {i + 1}</label>
                    <input
                      id={i === 0 ? `ts-${d}` : `ts-${line.key}-${d}`}
                      inputMode="decimal"
                      disabled={!editable || busy}
                      value={line.hours[d] ?? ""}
                      onChange={(e) => setCell(line.key, d, e.target.value)}
                      placeholder="0"
                      className="w-full rounded-lg border border-black/10 px-1.5 py-1.5 text-sm text-center tabular-nums disabled:bg-black/5"
                    />
                  </td>
                ))}
                <td className="align-top text-right tabular-nums pt-2 font-semibold" data-testid={`ts-line-total-${i}`}>{hoursOf(lineTotal(line, days))}</td>
                {editable && (
                  <td className="align-top pt-1.5">
                    <button type="button" onClick={() => removeLine(line.key)} disabled={busy} aria-label={`Remove line ${i + 1}`} className="text-label-tertiary hover:text-danger disabled:opacity-50" data-testid={`ts-remove-${i}`}>
                      <X size={14} aria-hidden />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={showProject ? 2 : 1} className="text-xs text-label-tertiary text-right pr-1">Day total</td>
              {shownDays.map((d) => (
                <td key={d} className="text-center" data-testid={`ts-day-total-${d}`}>
                  <div className="text-xs font-semibold tabular-nums">{hoursOf(minutesOf(d))}</div>
                  <div className="ts-bar mt-1" aria-hidden="true"><span style={{ width: `${Math.min(100, (minutesOf(d) / 480) * 100)}%` }} /></div>
                </td>
              ))}
              <td className="text-right text-xs font-semibold tabular-nums">{hoursOf(totalMinutes)}</td>
              {editable && <td />}
            </tr>
            <tr>
              <td colSpan={showProject ? 2 : 1} className="text-[11px] text-label-tertiary text-right pr-1">Clock recorded</td>
              {shownDays.map((d) => (
                <td key={d} className="text-center text-[11px] text-label-tertiary tabular-nums">{hoursOf(sheet.recordedMinutesByDay[d] ?? 0)}h</td>
              ))}
              <td />
              {editable && <td />}
            </tr>
          </tfoot>
        </table>
      </div>
      {editable && (
        <button
          type="button"
          onClick={() => setLines((ls) => [...ls, emptyLine()])}
          disabled={busy}
          data-testid="ts-add-line"
          className="mt-1 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold text-teal-700 bg-teal-500/10 hover:bg-teal-500/20 disabled:opacity-50"
        >
          <Plus size={14} aria-hidden /> Add a line
        </button>
      )}
      {legend}
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
