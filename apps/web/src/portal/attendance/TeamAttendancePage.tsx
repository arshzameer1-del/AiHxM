import { useEffect, useState } from "react";
import type { TeamAttendanceView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { EmployeeAvatar } from "../shared/EmployeeAvatar";
import { BackLink, LoadingNote, PageHeader } from "../shared/PageChrome";
import { formatDay } from "../shared/dates";
import { STATUS_LABELS, STATUS_STYLES } from "./MyAttendanceDays";
import { staleClockInHours } from "./openClockIn";
import { hoursMinutes, sortTeam, teamWindow } from "./teamAttendance";

/** Team Attendance: how the people who report to you did over the last 14 days. Read only. */
export function TeamAttendancePage() {
  const [view, setView] = useState<TeamAttendanceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const { from, to } = teamWindow();
    api
      .getTeamAttendance(from, to)
      .then(setView)
      .catch(() => setError("Team attendance could not be loaded."));
  }, []);

  return (
    <div data-testid="team-attendance">
      <BackLink to="/app/attendance">Back to Time & Attendance</BackLink>
      <PageHeader title="Team Attendance" subtitle={view ? `${formatDay(view.from)} to ${formatDay(view.to)}, for the people who report to you.` : "The people who report to you."} />
      {error && <p className="text-sm text-label-secondary">{error}</p>}
      {!error && !view && <LoadingNote what="your team's attendance" />}
      {view && view.members.length === 0 && <p className="text-sm text-label-secondary">No one reports to you.</p>}
      {view && view.members.length > 0 && (
        <div className="bg-white rounded-md shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-label-tertiary border-b border-black/5">
                <th className="px-4 py-2 font-semibold">Person</th>
                <th className="px-4 py-2 font-semibold">Now</th>
                <th className="px-4 py-2 font-semibold text-right">Days</th>
                <th className="px-4 py-2 font-semibold text-right">Absent</th>
                <th className="px-4 py-2 font-semibold text-right">Late</th>
                <th className="px-4 py-2 font-semibold text-right">Worked</th>
                <th className="px-4 py-2 font-semibold">Last day</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5">
              {sortTeam(view.members).map((m) => {
                const stale = m.clockedInSince ? staleClockInHours(m.clockedInSince) : null;
                return (
                  <tr key={m.employeeId} data-testid="team-attendance-row">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <EmployeeAvatar employeeId={m.employeeId} name={m.employeeName} size="sm" />
                        <div>
                          <span className="font-medium">{m.employeeName}</span> <span className="text-xs text-label-tertiary">({m.employeeNumber})</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {m.clockedInSince ? (
                        <span className={stale !== null ? "text-warning font-semibold" : "text-green-700"}>
                          {stale !== null ? `Clocked in ${stale}h, check` : "Clocked in"}
                        </span>
                      ) : (
                        <span className="text-label-tertiary">Not clocked in</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{m.summary.days}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{m.summary.byStatus.absent ?? 0}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{m.summary.lateMinutes} min</td>
                    <td className="px-4 py-2 text-right tabular-nums">{hoursMinutes(m.summary.workedMinutes)}</td>
                    <td className="px-4 py-2">
                      {m.lastDayStatus ? (
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_STYLES[m.lastDayStatus]}`}>{STATUS_LABELS[m.lastDayStatus]}</span>
                      ) : (
                        <span className="text-xs text-label-tertiary">Not processed yet</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
