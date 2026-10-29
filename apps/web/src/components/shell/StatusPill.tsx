import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { useTheme } from "../../theme/useTheme";
import { hasStandardLook } from "../../theme/theme";
import { formatTime } from "../../portal/shared/dates";
import { useMyAttendance } from "../../portal/attendance/useMyAttendance";
import { ATTENDANCE_CHANGED_EVENT } from "../../portal/attendance/attendanceEvents";

/** The One exD top-bar pill: "Not checked in" (amber) or "In 10:05 AM" (green). Shown only in that theme, for people with an employee record. */
export function StatusPill() {
  const theme = useTheme();
  const { identity } = useAuth();
  if (!hasStandardLook(theme) || !identity?.employeeId) return null;
  return <StatusPillInner employeeId={identity.employeeId} />;
}

function StatusPillInner({ employeeId }: { employeeId: string }) {
  const attendance = useMyAttendance(employeeId);
  const { reload } = attendance;
  // The pill lives in the top bar for the whole visit, so it reads again after a punch, when the tab is shown again, and every minute.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") reload();
    };
    window.addEventListener(ATTENDANCE_CHANGED_EVENT, reload);
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(reload, 60000);
    return () => {
      window.removeEventListener(ATTENDANCE_CHANGED_EVENT, reload);
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [reload]);
  if (attendance.loading || attendance.error) return null;
  const today = attendance.days.get(attendance.today);
  const clockedIn = Boolean(today?.open && today.firstIn);
  const text = clockedIn && today?.firstIn ? `In ${formatTime(today.firstIn)}` : today?.firstIn ? `Out · in ${formatTime(today.firstIn)}` : "Not checked in";
  return (
    <Link to="/app/attendance/clock" className="status-pill" data-testid="status-pill" title="Open Clock In / Out">
      <span className={`ws-dot ws-dot-${clockedIn ? "on" : "off"}`} aria-hidden="true" />
      {text}
    </Link>
  );
}
