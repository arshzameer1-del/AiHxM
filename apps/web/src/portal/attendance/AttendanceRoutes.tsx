import { Outlet, Route, Routes } from "react-router-dom";
import { ModuleContext, useBuildModuleContext, useModuleContext } from "../shared/ModuleContext";
import { BackLink, PageHeader } from "../shared/PageChrome";
import { AttendanceLaunchpad } from "./AttendanceLaunchpad";
import { ClockPanel, CorrectionsPanel } from "./AttendancePanels";
import { PendingCorrectionsSection } from "./CorrectionApprovals";
import { MyAttendanceCard } from "./AttendanceCards";
import { useMyAttendance } from "./useMyAttendance";
import { MyTimesheet } from "./MyTimesheet";
import { TeamAttendancePage } from "./TeamAttendancePage";

/**
 * Time & Attendance is its own module: it opens on tiles and every tile is its own page.
 *
 *   /app/attendance                  tiles
 *   /app/attendance/clock            Clock In / Out and recent attendance
 *   /app/attendance/days             the last 14 days
 *   /app/attendance/timesheet        weekly timesheet
 *   /app/attendance/corrections      request and follow attendance corrections
 *   /app/attendance/approvals        attendance corrections waiting for the signed-in approver
 *   /app/attendance/team             how the signed-in manager's reports did (Line Manager)
 *
 * Which actions exist is decided by the roles plus the server; the client only chooses what to show.
 */
export function AttendanceRoutes() {
  const ctx: ModuleContext = useBuildModuleContext();
  return (
    <Routes>
      <Route element={<Outlet context={ctx} />}>
        <Route index element={<AttendanceLaunchpad />} />
        <Route path="clock" element={<ClockPage />} />
        <Route path="days" element={<DaysPage />} />
        <Route path="timesheet" element={<TimesheetPage />} />
        <Route path="corrections" element={<CorrectionsPage />} />
        <Route path="approvals" element={<CorrectionApprovalsPage />} />
        <Route path="team" element={<TeamAttendancePage />} />
      </Route>
    </Routes>
  );
}

function NoRecord() {
  return <p className="text-sm text-label-secondary">No employee record for this login.</p>;
}

function ClockPage() {
  const { employeeId, refreshKey, bump } = useModuleContext();
  return (
    <div>
      <BackLink to="/app/attendance">Back to Time & Attendance</BackLink>
      <PageHeader title="Clock In / Out" subtitle="Record when you start and finish work." />
      {employeeId ? <ClockPanel employeeId={employeeId} refreshKey={refreshKey} onChanged={bump} /> : <NoRecord />}
    </div>
  );
}

function DaysPage() {
  const { employeeId, refreshKey } = useModuleContext();
  const data = useMyAttendance(employeeId, refreshKey);
  return (
    <div>
      <BackLink to="/app/attendance">Back to Time & Attendance</BackLink>
      <PageHeader title="My Attendance" subtitle="The last 30 days, day by day." />
      {employeeId ? <MyAttendanceCard data={data} /> : <NoRecord />}
    </div>
  );
}

function TimesheetPage() {
  const { employeeId } = useModuleContext();
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
  const { employeeId, refreshKey, bump } = useModuleContext();
  return (
    <div>
      <BackLink to="/app/attendance">Back to Time & Attendance</BackLink>
      <PageHeader title="Attendance Corrections" subtitle="Ask for a missed or wrong punch to be fixed." />
      {employeeId ? <CorrectionsPanel employeeId={employeeId} refreshKey={refreshKey} onChanged={bump} /> : <NoRecord />}
    </div>
  );
}

function CorrectionApprovalsPage() {
  const { refreshKey, bump, canDecide } = useModuleContext();
  if (!canDecide) {
    return (
      <div>
        <BackLink to="/app/attendance">Back to Time & Attendance</BackLink>
        <PageHeader title="Correction Approvals" subtitle="Attendance corrections you can decide." />
        <p className="text-sm text-label-secondary">Only approvers can use this page. Your own corrections are under Attendance Corrections.</p>
      </div>
    );
  }
  return (
    <div>
      <BackLink to="/app/attendance">Back to Time & Attendance</BackLink>
      <PageHeader title="Correction Approvals" subtitle="Attendance corrections you can decide." />
      <PendingCorrectionsSection refreshKey={refreshKey} onChanged={bump} standalone />
    </div>
  );
}
