import { useEffect, useState } from "react";
import { Link, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { HolidayView, OverlapWarning } from "@aihxm/shared-types";
import { OverlapNotice } from "./LeaveRequestForm";
import { Users } from "lucide-react";
import { api } from "../../api/client";
import { ModuleContext, useBuildModuleContext, useModuleContext } from "../shared/ModuleContext";
import { BackLink, PageHeader, LoadingNote } from "../shared/PageChrome";
import { describeError } from "../shared/describeError";
import { RequestsSection } from "./LeaveApprovalsList";
import { UpcomingHolidaysCard } from "./UpcomingHolidaysCard";
import { MyLeaveOverview } from "./LeaveOverview";
import { LeaveFormPage } from "./LeaveFormPage";
import { LeaveDetailPage } from "./LeaveDetailPage";
import { OnBehalfOverviewPage, OnBehalfSelectPage } from "./OnBehalfPages";
import { LeaveLaunchpad } from "./LeaveLaunchpad";
import { LeaveBalancesPage, LeaveBalancesSelectPage } from "./LeaveBalancesPages";
import { SapSection } from "../shared/FormSections";
import { formatDay, todayIso } from "../shared/dates";

/**
 * Leave Management opens on a launchpad of tiles and every tile opens its own page (nothing is stacked on one
 * long screen). Time & Attendance is a separate module (see ../attendance/AttendanceRoutes.tsx):
 *
 *   /app/leave                       Leave Management tiles
 *   /app/leave/my-requests           My Leave Request (entitlement, calendar, items)
 *   /app/leave/new                   Create Request
 *   /app/leave/:id                   one request (approval chain, team calendar)
 *   /app/leave/:id/edit              Edit Request
 *   /app/leave/approvals             leave requests waiting for the signed-in approver
 *   /app/leave/on-behalf             Select Employee, then /on-behalf/:employeeId
 *   /app/leave/holidays              holiday calendar
 *   /app/leave/balances              HR: Select Employee, then /balances/:employeeId (balances and adjustments)
 *
 * Which actions exist is still decided by the roles plus the server; the client only chooses what to show.
 */
export function LeaveRoutes() {
  const ctx: ModuleContext = useBuildModuleContext();
  return (
    <Routes>
      <Route element={<Outlet context={ctx} />}>
        <Route index element={<LeaveLaunchpad />} />
        <Route path="my-requests" element={<MyLeavePage />} />
        <Route path="approvals" element={<LeaveApprovalsPage />} />
        <Route path="holidays" element={<HolidaysPage />} />
        <Route path="balances" element={<LeaveBalancesSelectPage />} />
        <Route path="balances/:employeeId" element={<LeaveBalancesPage />} />
        <Route path="new" element={<LeaveFormPage />} />
        <Route path="on-behalf" element={<OnBehalfSelectPage />} />
        <Route path="on-behalf/:employeeId" element={<OnBehalfOverviewPage />} />
        <Route path=":id/edit" element={<LeaveFormPage />} />
        <Route path=":id" element={<LeaveDetailPage />} />
      </Route>
    </Routes>
  );
}

function MyLeavePage() {
  const ctx = useModuleContext();
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
  const { canSubmitOnBehalf, canDecide, canCancel, refreshKey, bump } = useModuleContext();
  if (!canDecide) {
    return (
      <div>
        <BackLink to="/app/leave">Back to Leave Management</BackLink>
        <PageHeader title="Leave Approvals" subtitle="Leave requests you can decide." />
        <p className="text-sm text-label-secondary">Only approvers can use this page. Your own requests are under My Leave Request.</p>
      </div>
    );
  }
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
  const today = todayIso();
  return (
    <div>
      <BackLink to="/app/leave">Back to Leave Management</BackLink>
      <PageHeader title="Holidays" subtitle="Company holidays for this year and next." />
      <SapSection title="Holiday calendar" count={holidays?.length} collapsible={false}>
        {error ? (
          <p className="text-sm text-label-secondary">{error}</p>
        ) : !holidays ? (
          <LoadingNote />
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
                <span className="font-mono text-xs shrink-0">{formatDay(h.holidayDate)}</span>
              </li>
            ))}
          </ul>
        )}
      </SapSection>
    </div>
  );
}
