import { useEffect, useState } from "react";
import { CalendarDays, CalendarPlus, ClipboardCheck, PartyPopper, Scale, UserCog } from "lucide-react";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { useModuleContext } from "../shared/ModuleContext";
import { PageHeader } from "../shared/PageChrome";
import { TileGrid, TileGroup, type TileSpec } from "../shared/Tiles";
import { todayIso } from "../shared/dates";

/**
 * Leave Management launchpad: one tile per task, each opening its own page. A tile only appears when the
 * signed-in user's roles allow that page (the server still decides what the page may do). Time & Attendance is a
 * separate module with its own launchpad; nothing from it is shown here.
 */
const fmt = (n: number) => String(Math.round(n * 100) / 100);

export function LeaveLaunchpad() {
  const { employeeId, canSubmitSelf, canSubmitOnBehalf, canDecide, refreshKey } = useModuleContext();
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
    const today = todayIso();
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

  if (canSubmitOnBehalf) {
    manage.push({ to: "/app/leave/balances", title: "Leave Balances", description: "See and adjust an employee's balances", icon: Scale, testId: "tile-leave-balances" });
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
