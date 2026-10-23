import { Link } from "react-router-dom";
import { Timer } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { timerText } from "../../portal/attendance/workTimer";
import { useWorkTimer } from "../../portal/attendance/useWorkTimer";

/** The top-bar pill that shows the running work timer ("Current timesheet"): only there while a timer is running. */
export function TimerPill() {
  const { identity } = useAuth();
  if (!identity?.employeeId) return null;
  return <TimerPillInner employeeId={identity.employeeId} />;
}

function TimerPillInner({ employeeId }: { employeeId: string }) {
  const { timer, seconds } = useWorkTimer(employeeId);
  if (!timer) return null;
  return (
    <Link to="/app/attendance/timesheet" className="timer-pill" data-testid="timer-pill" title={timer.label ? `Working on: ${timer.label}` : "Work timer running"}>
      <span className="timer-pill-dot" aria-hidden="true" />
      <Timer size={14} aria-hidden="true" />
      <span className="tabular-nums" data-testid="timer-pill-time">{timerText(seconds)}</span>
      {timer.label && <span className="timer-pill-label hidden md:inline">{timer.label}</span>}
    </Link>
  );
}
