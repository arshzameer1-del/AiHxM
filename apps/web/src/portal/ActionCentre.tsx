import { Link } from "react-router-dom";
import { ClipboardCheck, Clock, Hourglass, UserCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ApprovalStepper } from "../components/ApprovalStepper";
import { useAuth } from "../auth/AuthContext";
import { useApprovals } from "./approvals/useApprovals";
import { ageText, KIND_LABELS } from "./approvals/approvals";
import { attendanceMonth, hoursText, weekHours, WEEK_TARGET_MINUTES } from "./attendance/attendanceStats";
import { useMyAttendance } from "./attendance/useMyAttendance";
import { LoadingNote } from "./shared/PageChrome";

function Tile({ icon: Icon, label, value, sub, to, tone, testId }: { icon: LucideIcon; label: string; value: string; sub: string; to: string; tone: string; testId: string }) {
  return (
    <Link to={to} data-testid={testId} className={`kpi-tile kpi-tile-${tone} bg-card rounded-card p-4 shadow-sm ui-card flex items-center gap-3`}>
      <div className="kpi-tile-icon w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-accent/10 text-accent">
        <Icon size={20} strokeWidth={1.75} />
      </div>
      <div className="min-w-0">
        <div className="text-lg font-bold tabular-nums truncate">{value}</div>
        <div className="text-xs text-label-tertiary truncate">{label}</div>
        <div className="text-xs text-label-secondary truncate">{sub}</div>
      </div>
    </Link>
  );
}

/**
 * The home page's "Action centre" (the One exD workspace): what waits for your decision, how this week's hours stand, how
 * often you were present, then your own requests that are still in progress.
 */
export function ActionCentre({ employeeId }: { employeeId: string }) {
  const { identity } = useAuth();
  const canDecide = Boolean(identity?.roleKeys.includes("hr_admin") || identity?.roleKeys.includes("line_manager"));
  const approvals = useApprovals(employeeId, canDecide);
  const attendance = useMyAttendance(employeeId);
  const week = weekHours(attendance.days, attendance.today);
  const month = attendance.loading ? null : attendanceMonth(attendance.days, attendance.today);
  const waiting = approvals.toDecide.length;

  return (
    <section className="mb-6" aria-label="Action centre" data-testid="action-centre">
      <h2 className="action-centre-title text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-3">Action centre</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        {canDecide && (
          <Tile icon={ClipboardCheck} label="Waiting for your approval" value={approvals.loading ? "…" : String(waiting)} sub={approvals.loading ? "" : waiting === 0 ? "nothing waiting" : "open to decide"} to="/app/approvals" tone="indigo" testId="kpi-waiting" />
        )}
        <Tile icon={Clock} label="Hours this week" value={attendance.loading ? "…" : `${hoursText(week.workedMinutes)} h`} sub={`of ${WEEK_TARGET_MINUTES / 60}h target`} to="/app/attendance" tone="green" testId="kpi-hours-week" />
        <Tile icon={UserCheck} label="Present, 30 days" value={month?.presentPercent == null ? "—" : `${month.presentPercent}%`} sub={month ? `${month.late} late · ${month.absent} absent` : ""} to="/app/attendance/days" tone="plum" testId="kpi-present" />
        {!canDecide && (
          <Tile icon={Hourglass} label="Requests in progress" value={approvals.loading ? "…" : String(approvals.mine.length)} sub={approvals.mine.length === 0 ? "all settled" : "waiting on approvers"} to="/app/approvals" tone="indigo" testId="kpi-in-progress" />
        )}
      </div>
      <div>
        <section className="bg-card rounded-card shadow-sm border border-black/5 overflow-hidden" data-testid="requests-in-progress">
          <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-black/5">
            <h3 className="text-base font-bold">Your requests in progress</h3>
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-accent/10 text-accent tabular-nums">{approvals.loading ? "…" : approvals.mine.length}</span>
          </header>
          <div className="p-4">
            {approvals.loading ? (
              <LoadingNote what="your requests" />
            ) : approvals.mine.length === 0 ? (
              <p className="text-sm text-label-tertiary">Nothing in progress. Leave, timesheets and attendance corrections you send show up here until they are decided.</p>
            ) : (
              <ul className="divide-y divide-black/5">
                {approvals.mine.slice(0, 5).map((i) => (
                  <li key={i.key} className="py-2.5 first:pt-0 last:pb-0">
                    <Link to={i.to} className="block hover:bg-black/[0.02] rounded-lg">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-semibold truncate">
                          <span className="text-[11px] font-bold uppercase tracking-wide text-label-tertiary mr-2">{KIND_LABELS[i.kind]}</span>
                          {i.title}
                        </span>
                        <span className="text-xs text-label-tertiary whitespace-nowrap">{ageText(i.submittedAt)}</span>
                      </div>
                      <div className="text-xs text-label-secondary mt-0.5">
                        {i.stage}
                        {i.waitingOn ? ` · waiting on ${i.waitingOn}` : ""}
                      </div>
                      <ApprovalStepper steps={["Sent", i.stage, "Decided"]} current={1} title={`${i.title} progress`} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {approvals.mine.length > 5 && (
              <Link to="/app/approvals" className="block text-xs font-semibold text-accent hover:underline mt-3">See all {approvals.mine.length}</Link>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
