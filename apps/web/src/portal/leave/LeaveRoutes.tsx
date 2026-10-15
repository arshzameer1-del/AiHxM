import { useEffect, useState } from "react";
import { Link, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { HolidayView, OverlapWarning } from "@aihxm/shared-types";
import { OverlapNotice } from "./LeaveRequestForm";
import { Users } from "lucide-react";
import { api } from "../../api/client";
import { LeaveContext, useBuildLeaveContext, useLeaveContext } from "./LeaveContext";
import { BackLink, PageHeader } from "./LeaveChrome";
import { describeError, PendingCorrectionsSection, RequestsSection, UpcomingHolidaysCard } from "./LeavePage";
import { ClockPanel, CorrectionsPanel } from "./AttendancePanels";
import { MyAttendanceDays } from "./MyAttendanceDays";
import { MyTimesheet } from "./MyTimesheet";
import { MyLeaveOverview } from "./LeaveOverview";
import { LeaveFormPage } from "./LeaveFormPage";
import { LeaveDetailPage } from "./LeaveDetailPage";
import { OnBehalfOverviewPage, OnBehalfSelectPage } from "./OnBehalfPages";
import { AttendanceLaunchpad, LeaveLaunchpad } from "./Launchpads";
import { SapSection } from "./SapPage";

/**
 * Leave Management and Time & Attendance are two separate modules. Each opens on a launchpad of tiles and every
 * tile opens its own page (nothing is stacked on one long screen):
 *
 *   /app/leave                       Leave Management tiles
 *   /app/leave/my-requests           My Leave Request (entitlement, calendar, items)
 *   /app/leave/new                   Create Request
 *   /app/leave/:id                   one request (approval chain, team calendar)
 *   /app/leave/:id/edit              Edit Request
 *   /app/leave/approvals             leave requests waiting for the signed-in approver
 *   /app/leave/on-behalf             Select Employee, then /on-behalf/:employeeId
 *   /app/leave/holidays              holiday calendar
 *
 *   /app/attendance                  Time & Attendance tiles
 *   /app/attendance/clock            Clock In / Out and recent attendance
 *   /app/attendance/days             the last 14 days
 *   /app/attendance/timesheet        weekly timesheet
 *   /app/attendance/corrections      request and follow attendance corrections
 *   /app/attendance/approvals        attendance corrections waiting for the signed-in approver
 *
 * Which actions exist is still decided by the roles plus the server; the client only chooses what to show.
 */
export function LeaveRoutes() {
  const ctx: LeaveContext = useBuildLeaveContext();
  return (
    <Routes>
      <Route element={<Outlet context={ctx} />}>
        <Route index element={<LeaveLaunchpad />} />
        <Route path="my-requests" element={<MyLeavePage />} />
        <Route path="approvals" element={<LeaveApprovalsPage />} />
        <Route path="holidays" element={<HolidaysPage />} />
        <Route path="new" element={<LeaveFormPage />} />
        <Route path="on-behalf" element={<OnBehalfSelectPage />} />
        <Route path="on-behalf/:employeeId" element={<OnBehalfOverviewPage />} />
        <Route path=":id/edit" element={<LeaveFormPage />} />
        <Route path=":id" element={<LeaveDetailPage />} />
      </Route>
    </Routes>
  );
}

export function AttendanceRoutes() {
  const ctx: LeaveContext = useBuildLeaveContext();
  return (
    <Routes>
      <Route element={<Outlet context={ctx} />}>
        <Route index element={<AttendanceLaunchpad />} />
        <Route path="clock" element={<ClockPage />} />
        <Route path="days" element={<DaysPage />} />
        <Route path="timesheet" element={<TimesheetPage />} />
        <Route path="corrections" element={<CorrectionsPage />} />
        <Route path="approvals" element={<CorrectionApprovalsPage />} />
      </Route>
    </Routes>
  );
}

function MyLeavePage() {
  const ctx = useLeaveContext();
  const navigate = useNavigate();
  const { employeeId, canSubmitSelf, refreshKey, bump } = ctx;
  const warnings = (useLocation().state as { overlapWarnings?: OverlapWarning[] } | null)?.overlapWarnings ?? [];
  return (
    <div>
      <BackLink to="/app/leave">Back to Leave Management</BackLink>
      <PageHeader
        title="My Leave Request"
        subtitle="Your leave balance, calendar and requests."
        actions={
          employeeId && canSubmitSelf ? (
            <button type="button" onClick={() => navigate("/app/leave/new")} className="bg-accent text-white rounded px-4 py-1.5 text-sm font-semibold">
              Create Request
            </button>
          ) : undefined
        }
      />
      {warnings.length > 0 && (
        <div className="mb-3">
          <OverlapNotice warnings={warnings} />
        </div>
      )}
      {employeeId ? (
        <div className="grid xl:grid-cols-[minmax(0,1fr)_300px] gap-x-4 items-start">
          <MyLeaveOverview employeeId={employeeId} refreshKey={refreshKey} canSubmit={canSubmitSelf} onChanged={bump} />
          <UpcomingHolidaysCard />
        </div>
      ) : (
        <p className="text-sm text-label-secondary">Your login has no employee record, so there is no personal leave to show.</p>
      )}
    </div>
  );
}

function LeaveApprovalsPage() {
  const { canSubmitOnBehalf, canDecide, canCancel, refreshKey, bump } = useLeaveContext();
  return (
    <div>
      <BackLink to="/app/leave">Back to Leave Management</BackLink>
      <PageHeader
        title="Leave Approvals"
        subtitle="Leave requests you can decide."
        actions={
          canSubmitOnBehalf ? (
            <Link to="/app/leave/on-behalf" title="Select Employee" className="inline-flex items-center gap-1.5 border border-accent text-accent rounded px-3 py-1.5 text-sm font-semibold">
              <Users size={15} /> Request on behalf
            </Link>
          ) : undefined
        }
      />
      <RequestsSection canSubmitOnBehalf={false} canDecide={canDecide} canCancel={canCancel} refreshKey={refreshKey} onChanged={bump} />
    </div>
  );
}

function HolidaysPage() {
  const [holidays, setHolidays] = useState<HolidayView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const y = new Date().getUTCFullYear();
    Promise.all([api.listHolidays(String(y)), api.listHolidays(String(y + 1))])
      .then(([a, b]) => setHolidays([...a, ...b].sort((x, z) => x.holidayDate.localeCompare(z.holidayDate))))
      .catch((err) => setError(describeError(err)));
  }, []);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div>
      <BackLink to="/app/leave">Back to Leave Management</BackLink>
      <PageHeader title="Holidays" subtitle="Company holidays for this year and next." />
      <SapSection title="Holiday calendar" count={holidays?.length} collapsible={false}>
        {error ? (
          <p className="text-sm text-label-secondary">{error}</p>
        ) : !holidays ? (
          <p className="text-sm text-label-tertiary">Loading…</p>
        ) : holidays.length === 0 ? (
          <p className="text-sm text-label-tertiary">No holidays are set up yet.</p>
        ) : (
          <ul className="divide-y divide-black/5">
            {holidays.map((h) => (
              <li key={h.id} className={`flex items-center justify-between gap-3 py-2 text-sm ${h.holidayDate < today ? "text-label-tertiary" : ""}`}>
                <span>
                  {h.name}
                  {h.isOptional && <span className="text-xs text-label-tertiary"> (optional)</span>}
                </span>
                <span className="font-mono text-xs shrink-0">{h.holidayDate}</span>
              </li>
            ))}
          </ul>
        )}
      </SapSection>
    </div>
  );
}

function NoRecord() {
  return <p className="text-sm text-label-secondary">No employee record for this login.</p>;
}

function ClockPage() {
  const { employeeId, refreshKey, bump } = useLeaveContext();
  return (
    <div>
      <BackLink to="/app/attendance">Back to Time & Attendance</BackLink>
      <PageHeader title="Clock In / Out" subtitle="Record when you start and finish work." />
      {employeeId ? <ClockPanel employeeId={employeeId} refreshKey={refreshKey} onChanged={bump} /> : <NoRecord />}
    </div>
  );
}

function DaysPage() {
  const { employeeId, refreshKey } = useLeaveContext();
  return (
    <div>
      <BackLink to="/app/attendance">Back to Time & Attendance</BackLink>
      <PageHeader title="My Attendance" subtitle="Your last 14 days." />
      {employeeId ? (
        <section className="bg-white rounded-md shadow-sm p-4" aria-label="My attendance">
          <MyAttendanceDays employeeId={employeeId} refreshKey={refreshKey} />
        </section>
      ) : (
        <NoRecord />
      )}
    </div>
  );
}

function TimesheetPage() {
  const { employeeId } = useLeaveContext();
  return (
    <div>
      <BackLink to="/app/attendance">Back to Time & Attendance</BackLink>
      <PageHeader title="Timesheet" subtitle="Type your hours per day, then send the week for approval." />
      {employeeId ? (
        <section className="bg-white rounded-md shadow-sm p-4" aria-label="Timesheet">
          <MyTimesheet employeeId={employeeId} />
        </section>
      ) : (
        <NoRecord />
      )}
    </div>
  );
}

function CorrectionsPage() {
  const { employeeId, refreshKey, bump } = useLeaveContext();
  return (
    <div>
      <BackLink to="/app/attendance">Back to Time & Attendance</BackLink>
      <PageHeader title="Attendance Corrections" subtitle="Ask for a missed or wrong punch to be fixed." />
      {employeeId ? <CorrectionsPanel employeeId={employeeId} refreshKey={refreshKey} onChanged={bump} /> : <NoRecord />}
    </div>
  );
}

function CorrectionApprovalsPage() {
  const { refreshKey, bump } = useLeaveContext();
  return (
    <div>
      <BackLink to="/app/attendance">Back to Time & Attendance</BackLink>
      <PageHeader title="Correction Approvals" subtitle="Attendance corrections you can decide." />
      <PendingCorrectionsSection refreshKey={refreshKey} onChanged={bump} standalone />
    </div>
  );
}
