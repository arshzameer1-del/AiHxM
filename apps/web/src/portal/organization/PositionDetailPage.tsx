import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type {
  EmployeeOrgAssignmentView,
  EmployeeView,
  JobView,
  OrgUnitView,
  PositionBudgetView,
  PositionIncumbentView,
  PositionRelationshipView,
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
  pending_approval: "Pending approval",
  rejected: "Rejected",
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
    case "pending_approval":
      return "bg-amber-100 text-amber-800";
    case "rejected":
      return "bg-danger/15 text-red-700";
  }
}

const TABS = ["Overview", "Planning", "Assignment History", "History"] as const;
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
  // ORG-02: multi-incumbent roster, fiscal-year budgets and position-to-position lines.
  const [incumbents, setIncumbents] = useState<PositionIncumbentView[] | null>(null);
  const [budgets, setBudgets] = useState<PositionBudgetView[] | null>(null);
  const [relationships, setRelationships] = useState<PositionRelationshipView[] | null>(null);
  const [budgetYear, setBudgetYear] = useState(String(new Date().getFullYear()));
  const [budgetHeadcount, setBudgetHeadcount] = useState("1");
  const [planningError, setPlanningError] = useState<string | null>(null);

  function loadPlanning(positionId: string) {
    api.listPositionIncumbents(positionId).then(setIncumbents).catch(() => setIncumbents([]));
    api.listPositionBudgets(positionId).then(setBudgets).catch(() => setBudgets([]));
    api.listPositionRelationships(positionId).then(setRelationships).catch(() => setRelationships([]));
  }

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
    loadPlanning(id);
  }, [id]);

  async function endIncumbent(employeeId: string) {
    if (!id) return;
    setPlanningError(null);
    try {
      setPosition(await api.unassignPositionIncumbent(id, employeeId));
      loadPlanning(id);
    } catch (err) {
      setPlanningError(describeError(err));
    }
  }

  async function saveBudget() {
    if (!id) return;
    setPlanningError(null);
    try {
      await api.upsertPositionBudget(id, Number(budgetYear), { plannedHeadcount: Number(budgetHeadcount) });
      loadPlanning(id);
    } catch (err) {
      setPlanningError(describeError(err));
    }
  }

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

      {tab === "Planning" && (
        <div className="space-y-4">
          {planningError && <div className="text-danger text-sm">{planningError}</div>}
          <div className="bg-card rounded-card p-5 shadow-sm">
            <h2 className="text-sm font-semibold mb-2">Incumbents ({position.headcountFte} FTE approved)</h2>
            {incumbents === null && <div className="text-sm text-label-tertiary">Loading…</div>}
            {incumbents && incumbents.length === 0 && <div className="text-sm text-label-tertiary">Nobody holds this position.</div>}
            {incumbents?.map((i) => (
              <div key={i.id} className="flex items-center gap-3 py-2 border-b border-black/5 last:border-0 text-sm">
                <span className="font-medium">{i.employeeName ?? i.employeeId}</span>
                <span className="text-xs text-label-tertiary">{i.fte} FTE · since {i.effectiveFrom}</span>
                <button onClick={() => endIncumbent(i.employeeId)} className="ml-auto text-xs font-semibold text-danger hover:underline">
                  End slot
                </button>
              </div>
            ))}
          </div>
          <div className="bg-card rounded-card p-5 shadow-sm">
            <h2 className="text-sm font-semibold mb-2">Headcount budget by fiscal year</h2>
            {budgets?.map((b) => (
              <div key={b.id} className="text-sm py-1">
                {b.fiscalYear}: {b.plannedHeadcount} planned{b.budgetAmount !== null ? ` · ${b.currency} ${b.budgetAmount.toLocaleString()}` : ""}
              </div>
            ))}
            {budgets && budgets.length === 0 && <div className="text-sm text-label-tertiary mb-2">No budget set.</div>}
            <div className="flex items-end gap-3 mt-3">
              <label className="text-xs">
                Year
                <input id="position-budget-year" value={budgetYear} onChange={(e) => setBudgetYear(e.target.value)} className="block w-24 rounded-lg border border-black/10 px-2 py-1 text-sm font-mono" />
              </label>
              <label className="text-xs">
                Planned headcount
                <input id="position-budget-headcount" value={budgetHeadcount} onChange={(e) => setBudgetHeadcount(e.target.value)} className="block w-28 rounded-lg border border-black/10 px-2 py-1 text-sm font-mono" />
              </label>
              <button onClick={saveBudget} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold">
                Save budget
              </button>
            </div>
          </div>
          <div className="bg-card rounded-card p-5 shadow-sm">
            <h2 className="text-sm font-semibold mb-2">Reporting lines</h2>
            {relationships && relationships.length === 0 && <div className="text-sm text-label-tertiary">No position reporting lines.</div>}
            {relationships?.map((r) => (
              <div key={r.id} className="text-sm py-1">
                {r.relationshipType === "reports_to" ? "Reports to" : "Dotted line to"} {r.relatedPositionTitle ?? r.relatedPositionId}
              </div>
            ))}
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
