import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarDays, ChevronLeft, ChevronRight, Clock, Maximize2 } from "lucide-react";
import type { TimesheetView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { LoadingNote } from "../shared/PageChrome";
import { formatDayWithWeekday, formatPeriod, formatTime, todayIso, WEEKDAYS_SHORT } from "../shared/dates";
import { DAY_KIND_LABELS, minutesText, stripDays, type DayKind, type DayRow } from "./attendanceDays";
import type { MyAttendance } from "./useMyAttendance";

const KIND_DOT: Record<DayKind, string> = {
  on_time: "bg-success",
  late: "bg-warning",
  early: "bg-warning/60",
  half: "bg-accent/60",
  absent: "bg-danger",
  leave: "bg-accent",
  holiday: "bg-black/30",
  none: "bg-black/10",
};

const LEGEND: DayKind[] = ["on_time", "late", "early", "absent", "leave", "holiday"];

function CardShell({ icon: Icon, title, actions, children, footer, testId }: { icon: typeof Clock; title: string; actions?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; testId?: string }) {
  return (
    <section className="bg-card rounded-card shadow-sm border border-black/5 overflow-hidden flex flex-col" data-testid={testId}>
      <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-black/5">
        <h2 className="flex items-center gap-2 text-base font-bold">
          <Icon size={18} strokeWidth={1.75} className="text-accent" aria-hidden />
          {title}
        </h2>
        {actions}
      </header>
      <div className="p-4 flex-1">{children}</div>
      {footer && <footer className="px-4 py-2.5 text-xs text-label-tertiary bg-black/[0.03] border-t border-black/5">{footer}</footer>}
    </section>
  );
}

/** The day the summary box and the table highlight: today when it has anything to show, else the newest day with punches. */
function pickDefaultDay(days: Map<string, DayRow>, today: string): string {
  if (days.get(today)?.firstIn) return today;
  const withData = [...days.values()].filter((d) => d.firstIn).sort((a, b) => b.date.localeCompare(a.date));
  return withData[0]?.date ?? today;
}

function dayLabel(date: string): string {
  return formatDayWithWeekday(date);
}

/** Reference-style "My Attendance": a month of coloured days, the chosen day's check-in/out/worked, and the recent days table. */
export function MyAttendanceCard({ data, expandTo }: { data: MyAttendance; expandTo?: string }) {
  const { days, today } = data;
  const [selected, setSelected] = useState<string | null>(null);
  const strip = useMemo(() => stripDays(days, today, 30), [days, today]);
  const chosen = selected ?? pickDefaultDay(days, today);
  const row = days.get(chosen);
  const table = useMemo(() => [...days.values()].filter((d) => d.date <= today).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 14), [days, today]);

  return (
    <CardShell
      icon={CalendarDays}
      title="My Attendance"
      testId="my-attendance-card"
      actions={
        expandTo ? (
          <Link to={expandTo} className="text-label-tertiary hover:text-accent p-1.5 rounded-lg hover:bg-black/5" aria-label="Open My Attendance">
            <Maximize2 size={15} aria-hidden />
          </Link>
        ) : undefined
      }
    >
      {data.loading ? (
        <LoadingNote what="attendance" />
      ) : data.error ? (
        <p className="text-sm text-danger">{data.error}</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Last 30 days">
            {strip.map((d) => (
              <button
                key={d.date}
                type="button"
                onClick={() => setSelected(d.date)}
                aria-label={`${dayLabel(d.date)}: ${DAY_KIND_LABELS[d.kind]}`}
                aria-pressed={chosen === d.date}
                title={`${dayLabel(d.date)} · ${DAY_KIND_LABELS[d.kind]}`}
                data-testid={`strip-${d.date}`}
                className={`w-[22px] h-[22px] rounded-md ${KIND_DOT[d.kind]} ${chosen === d.date ? "ring-2 ring-accent ring-offset-2 ring-offset-[var(--card,transparent)]" : ""}`}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs text-label-secondary">
            {LEGEND.map((k) => (
              <span key={k} className="inline-flex items-center gap-1.5">
                <span className={`w-2.5 h-2.5 rounded-sm ${KIND_DOT[k]}`} aria-hidden /> {DAY_KIND_LABELS[k]}
              </span>
            ))}
          </div>

          <div className="mt-4 rounded-lg border border-black/5 bg-black/[0.03] px-4 py-3" data-testid="attendance-summary">
            <div className="text-xs text-label-tertiary mb-2">{dayLabel(chosen)}{row && <span> · {DAY_KIND_LABELS[row.kind]}</span>}</div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <Stat label="Check-in" value={row?.firstIn ? formatTime(row.firstIn) : "—"} />
              <Stat label="Check-out" value={row?.open ? "Working…" : row?.lastOut ? formatTime(row.lastOut) : "—"} />
              <Stat label="Worked" value={row ? minutesText(row.workedMinutes) : "—"} />
            </div>
            {row && row.notes.length > 0 && <p className="text-xs text-label-secondary mt-2">{row.notes.join(" · ")}</p>}
          </div>

          {table.length === 0 ? (
            <p className="text-sm text-label-tertiary mt-4">No attendance recorded yet. Clock in to start.</p>
          ) : (
            <div className="mt-4 rounded-lg border border-black/5 overflow-hidden">
              <div className="max-h-72 overflow-y-auto">
                <table className="w-full text-sm tabular-nums">
                  <thead className="sticky top-0 bg-card text-xs text-label-tertiary uppercase tracking-wide">
                    <tr>
                      <th className="text-left font-medium px-3 py-2">Day</th>
                      <th className="text-right font-medium px-3 py-2">In</th>
                      <th className="text-right font-medium px-3 py-2">Out</th>
                      <th className="text-right font-medium px-3 py-2 hidden sm:table-cell">Break</th>
                      <th className="text-right font-medium px-3 py-2">Worked</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-black/5">
                    {table.map((d) => (
                      <tr key={d.date} onClick={() => setSelected(d.date)} className={`cursor-pointer hover:bg-black/[0.03] ${chosen === d.date ? "bg-accent/5" : ""}`}>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className={`inline-block w-2 h-2 rounded-full mr-2 ${KIND_DOT[d.kind]}`} aria-hidden />
                          {dayLabel(d.date)}
                        </td>
                        {d.firstIn || d.workedMinutes > 0 ? (
                          <>
                            <td className="px-3 py-2 text-right whitespace-nowrap">{formatTime(d.firstIn, "—")}</td>
                            <td className="px-3 py-2 text-right whitespace-nowrap">{d.open ? "Working" : formatTime(d.lastOut, "—")}</td>
                            <td className="px-3 py-2 text-right hidden sm:table-cell">{minutesText(d.breakMinutes)}</td>
                            <td className="px-3 py-2 text-right">{minutesText(d.workedMinutes)}</td>
                          </>
                        ) : (
                          <td colSpan={4} className="px-3 py-2 text-right text-label-secondary">{DAY_KIND_LABELS[d.kind]}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </CardShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-label-tertiary">{label}</div>
      <div className="text-base font-bold mt-0.5">{value}</div>
    </div>
  );
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const TARGET_HOURS_PER_DAY = 8;
const TARGET_HOURS_PER_WEEK = 40;

/** Reference-style "My Timesheet": the week's hours as bars against the 8 h daily target; read only, the timesheet page edits. */
export function MyTimesheetCard({ employeeId, refreshKey = 0 }: { employeeId: string; refreshKey?: number }) {
  const [week, setWeek] = useState(() => todayIso());
  const [sheet, setSheet] = useState<TimesheetView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .timesheetForWeek(employeeId, week)
      .then((t) => !cancelled && setSheet(t))
      .catch(() => !cancelled && setError("Could not load the timesheet."));
    return () => {
      cancelled = true;
    };
  }, [employeeId, week, refreshKey]);

  const dates = sheet ? Array.from({ length: 7 }, (_, i) => addDays(sheet.periodStart, i)) : [];
  const entered = new Map((sheet?.entries ?? []).map((e) => [e.workDate, e.minutes]));
  const usingClock = sheet ? entered.size === 0 : false;
  const minutesFor = (d: string) => (usingClock ? sheet?.recordedMinutesByDay[d] ?? 0 : entered.get(d) ?? 0);
  const total = dates.reduce((sum, d) => sum + minutesFor(d), 0);
  const maxMinutes = Math.max(TARGET_HOURS_PER_DAY * 60, ...dates.map(minutesFor));
  const todayKey = todayIso();

  return (
    <CardShell
      icon={Clock}
      title="My Timesheet"
      testId="my-timesheet-card"
      actions={
        <Link to="/app/attendance/timesheet" className="text-xs font-semibold border border-black/10 rounded-lg px-2.5 py-1.5 hover:bg-black/5">
          Timesheet
        </Link>
      }
      footer={
        <>Dashed line = {TARGET_HOURS_PER_DAY}h daily target · {usingClock ? "bars show hours the clock recorded until hours are typed in" : "bars show the hours typed in the timesheet"} · read-only view</>
      }
    >
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !sheet ? (
        <LoadingNote what="timesheet" />
      ) : (
        <>
          <div className="flex items-center justify-between mb-3">
            <button type="button" className="p-1.5 rounded-lg hover:bg-black/5" aria-label="Previous week" onClick={() => setWeek(addDays(sheet.periodStart, -7))}>
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm font-semibold tabular-nums">{formatPeriod(sheet.periodStart, sheet.periodEnd)}</span>
            <button type="button" className="p-1.5 rounded-lg hover:bg-black/5" aria-label="Next week" onClick={() => setWeek(addDays(sheet.periodStart, 7))}>
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="relative h-36 flex items-end gap-2" role="img" aria-label={`Hours per day this week, total ${(total / 60).toFixed(1)} of ${TARGET_HOURS_PER_WEEK}`}>
            <div className="absolute left-0 right-0 border-t border-dashed border-label-tertiary/50" style={{ bottom: `${(TARGET_HOURS_PER_DAY * 60 / maxMinutes) * 100}%` }} aria-hidden />
            {dates.map((d) => {
              const m = minutesFor(d);
              return (
                <div key={d} className="flex-1 h-full flex items-end rounded-md bg-black/[0.04]">
                  <div className={`w-full rounded-md ${m > 0 ? "bg-accent" : ""}`} style={{ height: `${(m / maxMinutes) * 100}%` }} />
                </div>
              );
            })}
          </div>
          <div className="flex gap-2 mt-1.5 text-center tabular-nums">
            {dates.map((d) => {
              const m = minutesFor(d);
              const weekday = WEEKDAYS_SHORT[new Date(`${d}T00:00:00Z`).getUTCDay()];
              return (
                <div key={d} className="flex-1">
                  <div className="text-xs text-label-tertiary">{m > 0 ? (m / 60).toFixed(1) : "–"}</div>
                  <div className={`text-xs mt-0.5 ${d === todayKey ? "font-bold text-accent" : "text-label-secondary"}`}>{weekday}</div>
                </div>
              );
            })}
          </div>
          <div className="flex items-baseline justify-between mt-4">
            <div className="tabular-nums">
              <span className="text-2xl font-bold">{(total / 60).toFixed(1)}</span>
              <span className="text-sm text-label-tertiary"> / {TARGET_HOURS_PER_WEEK}h logged</span>
            </div>
            <span className="text-xs font-semibold rounded-lg bg-accent/10 text-accent px-2.5 py-1.5 capitalize">{sheet.status === "draft" ? "Draft" : sheet.status}</span>
          </div>
        </>
      )}
    </CardShell>
  );
}
