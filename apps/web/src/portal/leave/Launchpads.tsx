import { useEffect, useState } from "react";
import { CalendarCheck, CalendarDays, CalendarPlus, ClipboardCheck, ClipboardList, Clock, FileClock, Hourglass, PartyPopper, Timer, UserCog } from "lucide-react";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { useLeaveContext } from "./LeaveContext";
import { PageHeader } from "./LeaveChrome";
import { TileGrid, TileGroup, type TileSpec } from "./Tiles";

/**
 * The two launchpads. Leave Management and Time & Attendance are separate modules with their own sidebar
 * entry and their own tiles; nothing from one is shown inside the other. A tile only appears when the signed-in
 * user's roles allow that page (the server still decides what the page may do).
 */

const fmt = (n: number) => String(Math.round(n * 100) / 100);

export function LeaveLaunchpad() {
  const { employeeId, canSubmitSelf, canSubmitOnBehalf, canDecide, refreshKey } = useLeaveContext();
  const { identity } = useAuth();
  const [available, setAvailable] = useState<number | null>(null);
  const [waiting, setWaiting] = useState(0);
  const [upcoming, setUpcoming] = useState<number | null>(null);

  useEffect(() => {
    // Figures on the tiles are a convenience: a failed call just leaves the tile without a number.
    if (employeeId) {
      api
        .getLeaveBalances(employeeId)
        .then((rows) => {
          const year = new Date().getUTCFullYear();
          setAvailable(rows.filter((r) => r.year === year).reduce((sum, r) => sum + r.remainingDays, 0));
        })
        .catch(() => setAvailable(null));
    }
    if (canDecide) {
      api
        .listLeaveRequests()
        .then((rows) => setWaiting(rows.filter((r) => r.status === "pending" && r.employeeId !== identity?.employeeId).length))
        .catch(() => setWaiting(0));
    }
    const today = new Date().toISOString().slice(0, 10);
    api
      .listHolidays(String(new Date().getUTCFullYear()))
      .then((rows) => setUpcoming(rows.filter((h) => h.holidayDate >= today).length))
      .catch(() => setUpcoming(null));
  }, [employeeId, canDecide, identity?.employeeId, refreshKey]);

  const mine: TileSpec[] = [];
  if (employeeId) {
    mine.push({ to: "/app/leave/my-requests", title: "My Leave Request", description: "Balance, calendar and all your requests", icon: CalendarDays, figure: available === null ? null : fmt(available), figureLabel: "days available", testId: "tile-my-leave" });
  }
  if (employeeId && canSubmitSelf) {
    mine.push({ to: "/app/leave/new", title: "Create Leave Request", description: "Apply for leave and pick your approvers", icon: CalendarPlus, testId: "tile-create-leave" });
  }
  mine.push({ to: "/app/leave/holidays", title: "Holidays", description: "Company holiday calendar", icon: PartyPopper, figure: upcoming, figureLabel: "coming up", testId: "tile-holidays" });

  const manage: TileSpec[] = [];
  if (canDecide) {
    manage.push({ to: "/app/leave/approvals", title: "Leave Approvals", description: "Requests waiting for your decision", icon: ClipboardCheck, badge: waiting, testId: "tile-leave-approvals" });
  }
  if (canSubmitOnBehalf) {
    manage.push({ to: "/app/leave/on-behalf", title: "Request on Behalf", description: "Create leave for an employee", icon: UserCog, testId: "tile-on-behalf" });
  }

  return (
    <div>
      <PageHeader title="Leave Management" subtitle="Choose what you want to do. Each tile opens its own page." />
      <TileGroup title="My leave">
        <TileGrid tiles={mine} label="My leave" />
      </TileGroup>
      {manage.length > 0 && (
        <TileGroup title="Manage leave">
          <TileGrid tiles={manage} label="Manage leave" />
        </TileGroup>
      )}
      {!employeeId && <p className="text-sm text-label-secondary">Your login has no employee record, so there is no personal leave to show.</p>}
    </div>
  );
}

export function AttendanceLaunchpad() {
  const { employeeId, canSubmitSelf, canDecide, refreshKey } = useLeaveContext();
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
