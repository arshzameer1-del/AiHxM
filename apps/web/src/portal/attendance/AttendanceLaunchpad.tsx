import { useEffect, useState } from "react";
import { CalendarCheck, ClipboardList, Clock, FileClock, Hourglass, Timer, Users } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { api } from "../../api/client";
import { useModuleContext } from "../shared/ModuleContext";
import { PageHeader } from "../shared/PageChrome";
import { TileGrid, TileGroup, type TileSpec } from "../shared/Tiles";

/** Time & Attendance launchpad: clock, attendance days, timesheet and corrections, each on its own page. */
export function AttendanceLaunchpad() {
  const { employeeId, canSubmitSelf, canDecide, refreshKey } = useModuleContext();
  const { identity } = useAuth();
  const [clockedIn, setClockedIn] = useState<boolean | null>(null);
  const [waiting, setWaiting] = useState(0);

  useEffect(() => {
    if (employeeId && canSubmitSelf) {
      api
        .listAttendance(employeeId)
        .then((rows) => setClockedIn(rows.length > 0 && rows[0].clockOutAt === null))
        .catch(() => setClockedIn(null));
    }
    if (canDecide) {
      api
        .listPendingAttendanceCorrections()
        .then((rows) => setWaiting(rows.length))
        .catch(() => setWaiting(0));
    }
  }, [employeeId, canSubmitSelf, canDecide, refreshKey]);

  const mine: TileSpec[] = [];
  if (employeeId && canSubmitSelf) {
    mine.push(
      { to: "/app/attendance/clock", title: "Clock In / Out", description: clockedIn === null ? "Record your working time" : clockedIn ? "You are clocked in" : "You are not clocked in", icon: Clock, testId: "tile-clock" },
      { to: "/app/attendance/days", title: "My Attendance", description: "Your last 14 days, day by day", icon: CalendarCheck, testId: "tile-days" },
      { to: "/app/attendance/timesheet", title: "Timesheet", description: "Fill in and submit your weekly hours", icon: Timer, testId: "tile-timesheet" },
      { to: "/app/attendance/corrections", title: "Attendance Corrections", description: "Fix a missed or wrong punch", icon: FileClock, testId: "tile-corrections" },
    );
  }
  const manage: TileSpec[] = [];
  if (canDecide) {
    manage.push({ to: "/app/attendance/approvals", title: "Correction Approvals", description: "Corrections waiting for your decision", icon: ClipboardList, badge: waiting, testId: "tile-correction-approvals" });
  }

  if (identity?.roleKeys.includes("line_manager")) {
    manage.push({ to: "/app/attendance/team", title: "Team Attendance", description: "How your team did over the last 14 days", icon: Users, testId: "tile-team-attendance" });
  }

  return (
    <div>
      <PageHeader title="Time & Attendance" subtitle="Choose what you want to do. Each tile opens its own page." />
      {mine.length > 0 && (
        <TileGroup title="My time">
          <TileGrid tiles={mine} label="My time" />
        </TileGroup>
      )}
      {manage.length > 0 && (
        <TileGroup title="Manage time">
          <TileGrid tiles={manage} label="Manage time" />
        </TileGroup>
      )}
      {mine.length === 0 && manage.length === 0 && (
        <p className="text-sm text-label-secondary flex items-center gap-2">
          <Hourglass size={15} aria-hidden /> There is nothing for your role here yet.
        </p>
      )}
    </div>
  );
}
