import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import type { OverlapWarning } from "@aihxm/shared-types";
import { OverlapNotice } from "./LeaveRequestForm";
import { Users } from "lucide-react";
import type { EmployeeView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { useModuleContext } from "../shared/ModuleContext";
import { BackLink, PageHeader, LoadingNote } from "../shared/PageChrome";
import { OnBehalfBanner } from "./OnBehalfBanner";
import { MyLeaveOverview } from "./LeaveOverview";

/**
 * HR acting for someone else, the way the reference app does it: a Select Employee page with search, then the
 * same overview for that employee under a banner. The server still decides whether the caller may do it
 * (`leave_request.manage.all`).
 */
export function OnBehalfSelectPage() {
  const { canSubmitOnBehalf } = useModuleContext();
  const navigate = useNavigate();
  const [employees, setEmployees] = useState<EmployeeView[] | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    api.listEmployees().then(setEmployees).catch(() => setEmployees([]));
  }, []);

  if (!canSubmitOnBehalf) return <p className="text-sm text-label-secondary">Only HR can create leave on behalf of an employee.</p>;

  const needle = filter.trim().toLowerCase();
  const matches = (employees ?? []).filter((e) => (needle === "" ? true : `${e.firstName} ${e.lastName} ${e.employeeNumber} ${e.department ?? ""}`.toLowerCase().includes(needle)));

  return (
    <div role="region" aria-label="Select Employee" data-testid="select-employee-page">
      <BackLink to="/app/leave">Back to Leave Management</BackLink>
      <PageHeader title="Select Employee" subtitle="Pick the employee you are creating leave for." />
      <div className="bg-white rounded-md shadow-sm p-4">
        <div className="flex items-center gap-2 mb-3 text-accent">
          <Users size={16} aria-hidden />
          <span className="text-sm font-bold">Employees</span>
          {employees && <span className="text-xs text-label-tertiary font-normal">({matches.length})</span>}
        </div>
        <label htmlFor="on-behalf-search" className="sr-only">
          Search employees
        </label>
        <input
          id="on-behalf-search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search by name, number or department"
          className="w-full rounded border border-black/25 px-2 py-1.5 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <ul className="divide-y divide-black/5 border border-black/10 rounded">
          {employees === null && <li className="px-3 py-2 text-sm text-label-tertiary">Loading…</li>}
          {employees !== null && matches.length === 0 && <li className="px-3 py-2 text-sm text-label-tertiary">No employee matches.</li>}
          {matches.map((emp) => (
            <li key={emp.id}>
              <button type="button" onClick={() => navigate(`/app/leave/on-behalf/${emp.id}`)} className="w-full text-left px-3 py-2.5 text-sm hover:bg-accent/10 flex items-center justify-between gap-3">
                <span className="font-medium">
                  {emp.firstName} {emp.lastName}
                </span>
                <span className="text-label-tertiary">
                  {emp.employeeNumber}
                  {emp.department ? ` · ${emp.department}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** The chosen employee's own overview page, under the on-behalf banner. */
export function OnBehalfOverviewPage() {
  const { employeeId } = useParams();
  const { canSubmitOnBehalf, refreshKey, bump } = useModuleContext();
  const [target, setTarget] = useState<EmployeeView | null>(null);
  const [failed, setFailed] = useState(false);
  const warnings = (useLocation().state as { overlapWarnings?: OverlapWarning[] } | null)?.overlapWarnings ?? [];

  useEffect(() => {
    if (!employeeId) return;
    api.getEmployee(employeeId).then(setTarget).catch(() => setFailed(true));
  }, [employeeId]);

  if (!canSubmitOnBehalf) return <p className="text-sm text-label-secondary">Only HR can create leave on behalf of an employee.</p>;
  if (failed) return <p className="text-sm text-label-secondary">This employee could not be loaded. <Link className="text-accent underline" to="/app/leave/on-behalf">Choose another</Link></p>;
  if (!target || !employeeId) return <LoadingNote />;

  return (
    <div data-testid="on-behalf-leave">
      <PageHeader
        title="My Leave Request"
        actions={
          <Link to={`/app/leave/new?employee=${employeeId}`} className="bg-accent text-white rounded px-4 py-1.5 text-sm font-semibold">
            Create Request
          </Link>
        }
      />
      <OnBehalfBanner name={`${target.firstName} ${target.lastName}`} number={target.employeeNumber} stopTo="/app/leave" />
      {warnings.length > 0 && (
        <div className="mb-3">
          <OverlapNotice warnings={warnings} />
        </div>
      )}
      <MyLeaveOverview employeeId={employeeId} refreshKey={refreshKey} canSubmit onChanged={bump} onBehalf />
    </div>
  );
}
