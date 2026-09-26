import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type {
  AssignmentType,
  EmployeeOrgAssignmentVersionView,
  EmployeeOrgAssignmentView,
  EmployeeView,
  OrgUnitView,
  PositionView,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

const TYPE_LABELS: Record<AssignmentType, string> = {
  primary: "Primary",
  secondary: "Secondary",
  concurrent: "Concurrent",
  temporary: "Temporary",
  acting: "Acting",
  secondment: "Secondment",
};

function typeBadgeClass(type: AssignmentType): string {
  return type === "primary" ? "bg-accent/15 text-accent" : "bg-black/5 text-label-secondary";
}

const TABS = ["Overview", "History"] as const;
type Tab = (typeof TABS)[number];

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "This assignment doesn't exist, or the Employee module isn't enabled.";
    if (err.status === 403) return "You don't have permission to view this.";
    return err.message;
  }
  return "Something went wrong.";
}

/**
 * Organization Management Phase 9 — the unified workspace's Assignment
 * detail page, the simplest of the three (an assignment slot has no
 * further children to tab into the way an Org Unit has Positions/Employees
 * or a Position has an occupancy history spanning multiple employees — an
 * assignment slot belongs to exactly one employee for its whole life).
 * Reached via the "View" link AssignmentWorkbenchPage's `AssignmentRow` now
 * renders. Composed entirely from endpoints that already existed before
 * this phase (`getEmployeeOrgAssignment`, `getEmployee`, `getOrgUnit`,
 * `getPosition`, `getEmployeeOrgAssignmentHistory`) — no backend change was
 * needed for this page specifically.
 */
export function AssignmentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [assignment, setAssignment] = useState<EmployeeOrgAssignmentView | null>(null);
  const [employee, setEmployee] = useState<EmployeeView | null>(null);
  const [orgUnit, setOrgUnit] = useState<OrgUnitView | null>(null);
  const [position, setPosition] = useState<PositionView | null>(null);
  const [history, setHistory] = useState<EmployeeOrgAssignmentVersionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");

  useEffect(() => {
    if (!id) return;
    setAssignment(null);
    setEmployee(null);
    setOrgUnit(null);
    setPosition(null);
    setError(null);
    api
      .getEmployeeOrgAssignment(id)
      .then((a) => {
        setAssignment(a);
        api.getEmployee(a.employeeId).then(setEmployee).catch(() => undefined);
        api.getOrgUnit(a.orgUnitId).then(setOrgUnit).catch(() => undefined);
        if (a.positionId) {
          api.getPosition(a.positionId).then(setPosition).catch(() => undefined);
        }
      })
      .catch((err) => setError(describeError(err)));
    api.getEmployeeOrgAssignmentHistory(id).then(setHistory).catch(() => undefined);
  }, [id]);

  const employeeName = useMemo(() => (employee ? `${employee.firstName} ${employee.lastName}` : null), [employee]);

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!assignment) return <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div>
      <Link to="/app/organization/assignments" className="text-xs font-medium text-label-tertiary hover:text-accent">
        ← Back to Assignments
      </Link>

      <div className="flex items-center gap-2 flex-wrap mt-2 mb-1">
        <h1 className="text-2xl font-bold tracking-tight">{employeeName ?? "Assignment"}</h1>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${typeBadgeClass(assignment.assignmentType)}`}>
          {TYPE_LABELS[assignment.assignmentType]}
        </span>
        <span
          className={`text-xs px-2 py-0.5 rounded-full font-medium ${
            assignment.status === "active" ? "bg-success/15 text-green-700" : "bg-black/10 text-label-tertiary"
          }`}
        >
          {assignment.status}
        </span>
      </div>
      <p className="text-sm text-label-tertiary mb-6">
        {orgUnit ? (
          <>
            <Link to={`/app/organization/units/${orgUnit.id}`} className="text-accent hover:underline">
              {orgUnit.name}
            </Link>
          </>
        ) : (
          "Unknown unit"
        )}
        {position && (
          <>
            {" · "}
            <Link to={`/app/organization/positions/${position.id}`} className="text-accent hover:underline">
              {position.positionTitle}
            </Link>
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
              <div className="text-xs uppercase tracking-wide text-label-tertiary mb-1">Employee</div>
              <div>
                {employee ? (
                  <Link to={`/app/employees/${employee.id}`} className="text-accent hover:underline">
                    {employeeName}
                  </Link>
                ) : (
                  "—"
                )}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary mb-1">Type</div>
              <div>{TYPE_LABELS[assignment.assignmentType]}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary mb-1">Org Unit</div>
              <div>{orgUnit ? orgUnit.name : "—"}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary mb-1">Position</div>
              <div>{position ? position.positionTitle : "— none —"}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary mb-1">Status</div>
              <div>{assignment.status}</div>
            </div>
          </div>
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
                  <span className="text-xs px-2 py-0.5 rounded-full bg-black/5 text-label-secondary">{TYPE_LABELS[v.assignmentType]}</span>
                  <span className="text-xs text-label-tertiary">{v.status}</span>
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
