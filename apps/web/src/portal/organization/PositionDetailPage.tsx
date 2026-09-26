import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type {
  EmployeeOrgAssignmentView,
  EmployeeView,
  JobView,
  OrgUnitView,
  PositionStatus,
  PositionVersionView,
  PositionView,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

const STATUS_LABELS: Record<PositionStatus, string> = {
  vacant: "Vacant",
  filled: "Filled",
  frozen: "Frozen",
  abolished: "Abolished",
};

function statusBadgeClass(status: PositionStatus): string {
  switch (status) {
    case "filled":
      return "bg-success/15 text-green-700";
    case "vacant":
      return "bg-accent/15 text-accent";
    case "frozen":
      return "bg-yellow-500/15 text-yellow-700";
    case "abolished":
      return "bg-black/10 text-label-tertiary";
  }
}

const TABS = ["Overview", "Assignment History", "History"] as const;
type Tab = (typeof TABS)[number];

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "This position doesn't exist, or the Employee module isn't enabled.";
    if (err.status === 403) return "You don't have permission to view this.";
    return err.message;
  }
  return "Something went wrong.";
}

/**
 * Organization Management Phase 9 — the unified workspace's Position detail
 * page, mirroring OrgUnitDetailPage's own shape and reasoning (see that
 * file's header comment for the general pattern). Reached via the "View"
 * link PositionWorkbenchPage's `PositionRow` now renders.
 *
 * The "Assignment History" tab is the one genuinely new backend capability
 * this phase adds: `EmployeeOrgAssignmentsService.list()` previously had no
 * `positionId` filter (only `employeeId`/`orgUnitId`/`assignmentType`/
 * `status`), so there was no way to ask "every assignment slot that has
 * ever pointed at this position" — a small, additive filter, wired through
 * the controller and this client's `listEmployeeOrgAssignments()` the same
 * way `orgUnitId` already was. Called with no `status` filter here
 * deliberately, so both active and ended slots show — this position's full
 * occupancy history, not just who holds it today.
 */
export function PositionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [position, setPosition] = useState<PositionView | null>(null);
  const [orgUnits, setOrgUnits] = useState<OrgUnitView[]>([]);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [assignmentHistory, setAssignmentHistory] = useState<EmployeeOrgAssignmentView[] | null>(null);
  const [history, setHistory] = useState<PositionVersionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");

  useEffect(() => {
    if (!id) return;
    setPosition(null);
    setError(null);
    api.getPosition(id).then(setPosition).catch((err) => setError(describeError(err)));
    api.listOrgUnits().then(setOrgUnits).catch(() => undefined);
    api.listJobs().then(setJobs).catch(() => undefined);
    api.listEmployees().then(setEmployees).catch(() => undefined);
    api.listEmployeeOrgAssignments({ positionId: id }).then(setAssignmentHistory).catch(() => undefined);
    api.getPositionHistory(id).then(setHistory).catch(() => undefined);
  }, [id]);

  const orgUnit = useMemo(() => orgUnits.find((u) => u.id === position?.orgUnitId), [orgUnits, position]);
  const job = useMemo(() => jobs.find((j) => j.id === position?.jobId), [jobs, position]);
  const employeeById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const occupant = useMemo(() => employees.find((e) => e.positionId === id), [employees, id]);

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!position) return <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div>
      <Link to="/app/organization/positions" className="text-xs font-medium text-label-tertiary hover:text-accent">
        ← Back to Positions
      </Link>

      <div className="flex items-center gap-2 flex-wrap mt-2 mb-1">
        <h1 className="text-2xl font-bold tracking-tight">{position.positionTitle}</h1>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusBadgeClass(position.status)}`}>
          {STATUS_LABELS[position.status]}
        </span>
      </div>
      <p className="text-sm text-label-tertiary mb-6">
        {position.positionCode ? `${position.positionCode} · ` : ""}
        {orgUnit ? (
          <>
            In{" "}
            <Link to={`/app/organization/units/${orgUnit.id}`} className="text-accent hover:underline">
              {orgUnit.name}
            </Link>
          </>
        ) : (
          "No org unit"
        )}
        {occupant && (
          <>
            {" "}
            · Held by{" "}
            <span className="text-label-secondary font-medium">
              {occupant.firstName} {occupant.lastName}
            </span>
          </>
        )}
      </p>

      <div className="flex gap-1 border-b border-black/10 mb-4">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === t ? "border-accent text-accent" : "border-transparent text-label-tertiary hover:text-label-secondary"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Overview" && (
        <div className="bg-card rounded-card p-6 shadow-sm">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary mb-1">Org Unit</div>
              <div>{orgUnit ? orgUnit.name : "—"}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary mb-1">Job</div>
              <div>{job ? job.title : "— none —"}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary mb-1">Headcount</div>
              <div>{position.headcountFte} FTE</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary mb-1">Status</div>
              <div>{STATUS_LABELS[position.status]}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary mb-1">Current occupant</div>
              <div>{occupant ? `${occupant.firstName} ${occupant.lastName}` : "— vacant —"}</div>
            </div>
          </div>
        </div>
      )}

      {tab === "Assignment History" && (
        <div className="bg-card rounded-card shadow-sm px-4">
          {assignmentHistory === null && <div className="text-sm text-label-tertiary py-4">Loading…</div>}
          {assignmentHistory && assignmentHistory.length === 0 && (
            <div className="text-sm text-label-tertiary py-4">No assignment slot has ever pointed at this position.</div>
          )}
          {assignmentHistory &&
            assignmentHistory.map((a) => {
              const employee = employeeById.get(a.employeeId);
              return (
                <div key={a.id} className="flex items-center gap-2 py-2.5 border-b border-black/5 last:border-0 flex-wrap">
                  <Link to={`/app/organization/assignments/${a.id}`} className="font-medium text-sm text-accent hover:underline">
                    {employee ? `${employee.firstName} ${employee.lastName}` : "Unknown employee"}
                  </Link>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-black/5 text-label-secondary">{a.assignmentType}</span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      a.status === "active" ? "bg-success/15 text-green-700" : "bg-black/10 text-label-tertiary"
                    }`}
                  >
                    {a.status}
                  </span>
                </div>
              );
            })}
        </div>
      )}

      {tab === "History" && (
        <div className="bg-card rounded-card shadow-sm px-4">
          {history === null && <div className="text-sm text-label-tertiary py-4">Loading…</div>}
          {history && history.length === 0 && <div className="text-sm text-label-tertiary py-4">No history yet.</div>}
          {history &&
            [...history].reverse().map((v) => (
              <div key={v.id} className="py-2.5 border-b border-black/5 last:border-0 text-sm">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{v.positionTitle}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-black/5 text-label-secondary">{v.status}</span>
                  <span className="text-xs text-label-tertiary">{v.headcountFte} FTE</span>
                </div>
                <div className="text-xs text-label-tertiary mt-0.5">
                  Effective {v.effectiveFrom}
                  {v.effectiveTo ? ` – ${v.effectiveTo}` : " – present"}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
