import { useEffect, useState } from "react";
import type { AttendanceDailyResultView, AttendanceDailyStatus, AttendancePeriodSummary } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

const STATUS_LABELS: Record<AttendanceDailyStatus, string> = {
  present: "Present",
  absent: "Absent",
  late: "Late",
  early_departure: "Left early",
  late_and_early: "Late and left early",
  half_day: "Half day",
  on_leave: "On leave",
  on_duty: "On duty",
  holiday: "Holiday",
  rest_day: "Rest day",
  no_schedule: "No schedule",
};

const STATUS_STYLES: Record<AttendanceDailyStatus, string> = {
  present: "bg-success/10 text-success",
  absent: "bg-danger/10 text-danger",
  late: "bg-warning/10 text-warning",
  early_departure: "bg-warning/10 text-warning",
  late_and_early: "bg-warning/10 text-warning",
  half_day: "bg-accent/10 text-accent",
  on_leave: "bg-accent/10 text-accent",
  on_duty: "bg-accent/10 text-accent",
  holiday: "bg-black/5 text-label-secondary",
  rest_day: "bg-black/5 text-label-secondary",
  no_schedule: "bg-black/5 text-label-secondary",
};

const EXCEPTION_LABELS: Record<string, string> = {
  missing_clock_out: "No clock-out",
  unscheduled_work: "Worked on a day off",
};

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function hm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function time(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
}

/**
 * TLM-04 - the processed attendance day: what the time-evaluation job made of the punches, the
 * work schedule, holidays and approved leave. Read-only; HR corrections go through an override.
 */
export function MyAttendanceDays({ employeeId, refreshKey }: { employeeId: string; refreshKey: number }) {
  const [days, setDays] = useState<AttendanceDailyResultView[] | null>(null);
  const [summary, setSummary] = useState<AttendancePeriodSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const to = new Date();
    const from = new Date(to.getTime() - 13 * 86400000);
    Promise.all([
      api.attendanceResults(employeeId, isoDay(from), isoDay(to)),
      api.attendanceSummary(employeeId, isoDay(from), isoDay(to)),
    ])
      .then(([rows, sum]) => {
        setDays(rows);
        setSummary(sum);
      })
      .catch((err) => setError(err instanceof ApiError && err.status === 403 ? "" : "Could not load your attendance days."));
  }, [employeeId, refreshKey]);

  if (error === "") return null;
  if (error) return <p className="text-sm text-danger mt-6">{error}</p>;
  if (!days || !summary) return null;

  return (
    <div className="mt-6">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-2">
        <h3 className="text-xs uppercase tracking-wide text-label-tertiary font-semibold">Last 14 days</h3>
        <p className="text-xs text-label-secondary tabular-nums">
          Worked {hm(summary.workedMinutes)} of {hm(summary.scheduledMinutes)} · late {summary.lateMinutes} min · early leave {summary.earlyLeaveMinutes} min
        </p>
      </div>
      {days.length === 0 ? (
        <p className="text-sm text-label-tertiary">Days appear here once the nightly attendance run has processed them.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-label-tertiary">
                <th className="py-1 pr-4 font-medium">Date</th>
                <th className="py-1 pr-4 font-medium">Status</th>
                <th className="py-1 pr-4 font-medium">In</th>
                <th className="py-1 pr-4 font-medium">Out</th>
                <th className="py-1 pr-4 font-medium">Worked</th>
                <th className="py-1 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5 tabular-nums">
              {[...days].reverse().map((d) => (
                <tr key={d.id}>
                  <td className="py-1.5 pr-4 whitespace-nowrap">{new Date(`${d.workDate}T00:00:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}</td>
                  <td className="py-1.5 pr-4">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_STYLES[d.status]}`}>{STATUS_LABELS[d.status]}</span>
                  </td>
                  <td className="py-1.5 pr-4">{time(d.firstInAt)}</td>
                  <td className="py-1.5 pr-4">{time(d.lastOutAt)}</td>
                  <td className="py-1.5 pr-4">{d.workedMinutes > 0 ? hm(d.workedMinutes) : "—"}</td>
                  <td className="py-1.5 text-xs text-label-secondary">
                    {[
                      d.lateMinutes > 0 ? `${d.lateMinutes} min late` : null,
                      d.earlyLeaveMinutes > 0 ? `${d.earlyLeaveMinutes} min early` : null,
                      ...d.exceptions.map((x) => EXCEPTION_LABELS[x] ?? x),
                      d.isOverridden ? `Corrected by HR: ${d.overrideReason ?? ""}` : null,
                    ].filter(Boolean).join(" · ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
