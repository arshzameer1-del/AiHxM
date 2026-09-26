import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type {
  CostCenterView,
  EmployeeOrgAssignmentView,
  EmployeeView,
  OrgChangeView,
  OrgRelationshipView,
  OrgUnitType,
  OrgUnitVersionView,
  OrgUnitView,
  PositionView,
} from "@aihxm/shared-types";
import { ORG_REPORTING_RELATIONSHIP_CODES, ORG_STRUCTURE_RELATIONSHIP_CODES } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";

const UNIT_TYPE_LABELS: Record<OrgUnitType, string> = {
  department: "Department",
  division: "Division",
  business_unit: "Business Unit",
  function: "Function",
};

// The same in-flight set OrgChangesService/OrganizationCommandCenterService
// both already use server-side (org-changes.service.ts, Phase 5;
// organization-command-center.service.ts, Phase 6) — a change still on its
// way to being applied, not yet published/rejected/failed.
const IN_FLIGHT_STATUSES = new Set(["draft", "validated", "pending_approval", "approved"]);

const TABS = ["Overview", "Positions", "Employees", "History", "Pending Changes"] as const;
type Tab = (typeof TABS)[number];

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "This org unit doesn't exist, or the Employee module isn't enabled.";
    if (err.status === 403) return "You don't have permission to view this.";
    return err.message;
  }
  return "Something went wrong.";
}

function statusBadgeClass(status: OrgUnitView["status"]): string {
  return status === "archived" ? "bg-black/10 text-label-tertiary" : "bg-success/15 text-green-700";
}

/**
 * Organization Management Phase 9 — the unified Organization workspace's
 * first detail page: a single Org Unit's full picture (its own record,
 * every Position/Employee currently sitting under it, its effective-dated
 * history, and any Reorganization still in flight that touches it) in one
 * place, instead of forcing HR to cross-reference the Hierarchy Explorer,
 * Position Workbench, Assignment Workbench, and Reorganizations screens by
 * hand for a single unit. Reached via the "View" link OrgHierarchyPage's
 * `UnitRow` now renders (ungated by `canManage`, since viewing is not a
 * management action).
 *
 * Every tab here is read-only and composed entirely from existing,
 * already-shipped endpoints — Positions/Employees tabs are just
 * `listPositions`/`listEmployeeOrgAssignments` filtered by `orgUnitId`
 * (both filters existed before this phase), History is the unit's own
 * `getOrgUnitHistory`, and Pending Changes is a client-side filter of
 * `listOrgChanges()` by `items[].orgUnitId` + the same in-flight status set
 * the Command Center panel uses — no new backend endpoint was needed for
 * any of the five tabs except the one `getOrgUnit(id)` single-record fetch
 * itself, which the backend route already supported but no client method
 * had ever called until now.
 */
export function OrgUnitDetailPage() {
  const { identity } = useAuth();
  // Same courtesy client-side mirror of the server's real `org_unit.manage.all`
  // gate that OrgHierarchyPage's own `canManage` already uses — the actual
  // enforcement lives in OrgUnitsService, this just decides whether to show
  // edit controls at all.
  const canManage = identity?.roleKeys.includes("hr_admin") ?? false;

  const { id } = useParams<{ id: string }>();
  const [unit, setUnit] = useState<OrgUnitView | null>(null);
  const [allUnits, setAllUnits] = useState<OrgUnitView[]>([]);
  const [positions, setPositions] = useState<PositionView[] | null>(null);
  const [assignments, setAssignments] = useState<EmployeeOrgAssignmentView[] | null>(null);
  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [history, setHistory] = useState<OrgUnitVersionView[] | null>(null);
  const [orgChanges, setOrgChanges] = useState<OrgChangeView[] | null>(null);
  const [costCenters, setCostCenters] = useState<CostCenterView[]>([]);
  const [relationships, setRelationships] = useState<OrgRelationshipView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");

  // "Head of Department" (kumail's own term, after SAP's Org and Staffing
  // "Chief Position") — editing state kept separate from `unit` itself so a
  // failed save doesn't clobber the last-known-good record on screen.
  const [editingHead, setEditingHead] = useState(false);
  const [headSelection, setHeadSelection] = useState("");
  const [savingHead, setSavingHead] = useState(false);
  const [headError, setHeadError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setUnit(null);
    setError(null);
    api.getOrgUnit(id).then(setUnit).catch((err) => setError(describeError(err)));
    api.listOrgUnits().then(setAllUnits).catch(() => undefined);
    api.listPositions({ orgUnitId: id }).then(setPositions).catch(() => undefined);
    api
      .listEmployeeOrgAssignments({ orgUnitId: id, status: "active" })
      .then(setAssignments)
      .catch(() => undefined);
    api.listEmployees().then(setEmployees).catch(() => undefined);
    api.getOrgUnitHistory(id).then(setHistory).catch(() => undefined);
    api.listOrgChanges().then(setOrgChanges).catch(() => undefined);
    api.listCostCenters().then(setCostCenters).catch(() => undefined);
    // Company-wide (no filter) — this unit's employees can be either side
    // of a relationship row with someone outside the unit entirely, so the
    // lookup below has to search the whole set, not just this unit's own.
    api.listOrgRelationships().then(setRelationships).catch(() => undefined);
  }, [id]);

  const parent = useMemo(() => allUnits.find((u) => u.id === unit?.parentId), [allUnits, unit]);
  const children = useMemo(() => allUnits.filter((u) => u.parentId === id), [allUnits, id]);
  const employeeById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);

  const headPosition = useMemo(
    () => (unit?.headPositionId ? positions?.find((p) => p.id === unit.headPositionId) : undefined),
    [positions, unit]
  );
  // Denormalized on EmployeeView the same way OrgHierarchyPage's own
  // `employeeByPositionId` map already relies on — no assignments lookup
  // needed just to find who currently holds a position.
  const headHolder = useMemo(
    () => (unit?.headPositionId ? employees.find((e) => e.positionId === unit.headPositionId) : undefined),
    [employees, unit]
  );

  // "Org unit's own cost center" (kumail's own request) — the reverse side
  // of the `cost_centers.org_unit_id` link Financial Centers already lets
  // an HR Admin set (ST-070, see shared-types). A plain filter, not a new
  // field or endpoint: a cost center already says which org unit it
  // belongs to, this just reads that back for THIS unit.
  const unitCostCenters = useMemo(() => costCenters.filter((cc) => cc.orgUnitId === id), [costCenters, id]);

  // Headcount / vacancy (kumail's own request) — computed client-side from
  // the same `positions` list the Positions tab already renders, exactly
  // the same "no new endpoint, just read what's already loaded" approach
  // `positionsByOrgUnit` etc. use on the Hierarchy tree. `abolished`
  // positions are excluded from "planned" the same way a cancelled
  // requisition wouldn't count toward a department's headcount plan.
  const headcount = useMemo(() => {
    const live = (positions ?? []).filter((p) => p.status !== "abolished");
    const filled = live.filter((p) => p.status === "filled");
    const vacant = live.filter((p) => p.status === "vacant");
    const frozen = live.filter((p) => p.status === "frozen");
    const plannedFte = live.reduce((sum, p) => sum + p.headcountFte, 0);
    const filledFte = filled.reduce((sum, p) => sum + p.headcountFte, 0);
    return { total: live.length, filled: filled.length, vacant: vacant.length, frozen: frozen.length, plannedFte, filledFte };
  }, [positions]);

  // Matrix/dotted-line reporting (kumail's own request) — grouped by the
  // report's employee id so the Employees tab can show each assignment's
  // OWN non-direct relationships inline, without a per-row fetch. `direct`
  // is left out here on purpose: that line is already what "reports to"
  // shows elsewhere (EmployeeDetailPage) — this surfaces the ADDITIONAL
  // matrix/dotted-line/temporary/acting lines a plain org-unit tree can't
  // otherwise show.
  const nonDirectRelationshipsByEmployeeId = useMemo(() => {
    const map = new Map<string, OrgRelationshipView[]>();
    for (const r of relationships) {
      if (r.status !== "active" || r.relationshipType === "direct") continue;
      const list = map.get(r.employeeId) ?? [];
      list.push(r);
      map.set(r.employeeId, list);
    }
    return map;
  }, [relationships]);

  function startEditingHead() {
    setHeadError(null);
    setHeadSelection(unit?.headPositionId ?? "");
    setEditingHead(true);
  }

  async function saveHead() {
    if (!id) return;
    setSavingHead(true);
    setHeadError(null);
    try {
      const updated = await api.setOrgUnitHeadPosition(id, { positionId: headSelection || null });
      setUnit(updated);
      setEditingHead(false);
    } catch (err) {
      setHeadError(describeError(err));
    } finally {
      setSavingHead(false);
    }
  }

  const pendingChanges = useMemo(() => {
    if (!orgChanges || !id) return [];
    return orgChanges
      .filter((c) => IN_FLIGHT_STATUSES.has(c.status))
      .filter((c) => c.items.some((item) => item.orgUnitId === id))
      .map((c) => ({ change: c, items: c.items.filter((item) => item.orgUnitId === id) }));
  }, [orgChanges, id]);

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!unit) return <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div>
      <Link to="/app/organization" className="text-xs font-medium text-label-tertiary hover:text-accent">
        ← Back to Hierarchy
      </Link>

      <div className="flex items-center gap-2 flex-wrap mt-2 mb-1">
        <h1 className="text-2xl font-bold tracking-tight">{unit.name}</h1>
        <span className="text-xs px-2 py-0.5 rounded-full bg-black/5 text-label-secondary">{UNIT_TYPE_LABELS[unit.unitType]}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusBadgeClass(unit.status)}`}>{unit.status}</span>
      </div>
      <p className="text-sm text-label-tertiary mb-6">
        {unit.code ? `${unit.code} · ` : ""}
        {parent ? (
          <>
            Under{" "}
            <Link to={`/app/organization/units/${parent.id}`} className="text-accent hover:underline">
              {parent.name}
            </Link>
          </>
        ) : (
          "Top-level unit"
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
            {t === "Pending Changes" && pendingChanges.length > 0 && (
              <span className="ml-1.5 text-xs bg-warning/15 text-warning rounded-full px-1.5 py-0.5">{pendingChanges.length}</span>
            )}
          </button>
        ))}
      </div>

      {tab === "Overview" && (
        <div className="bg-card rounded-card p-6 shadow-sm space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary mb-1">Type</div>
              <div>{UNIT_TYPE_LABELS[unit.unitType]}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary mb-1">Code</div>
              <div>{unit.code ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary mb-1">Status</div>
              <div>{unit.status}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary mb-1">Parent</div>
              <div>{parent ? parent.name : "— none, top level —"}</div>
            </div>
          </div>
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <div className="text-xs uppercase tracking-wide text-label-tertiary">Head of Department</div>
              <span className="text-[10px] font-mono text-label-tertiary/60">
                {ORG_STRUCTURE_RELATIONSHIP_CODES.org_unit_head_position.code}
              </span>
            </div>
            {!editingHead && (
              <div className="flex items-center gap-2 flex-wrap">
                {headPosition ? (
                  <>
                    <Link to={`/app/organization/positions/${headPosition.id}`} className="text-sm text-accent hover:underline font-medium">
                      {headPosition.positionTitle}
                    </Link>
                    <span className="text-sm text-label-tertiary">
                      {headHolder ? `— ${headHolder.firstName} ${headHolder.lastName}` : "— vacant"}
                    </span>
                  </>
                ) : (
                  <span className="text-sm text-label-tertiary">No head of department set.</span>
                )}
                {canManage && (
                  <button onClick={startEditingHead} className="text-xs font-medium text-accent hover:underline ml-1">
                    {headPosition ? "Change" : "Set head"}
                  </button>
                )}
              </div>
            )}
            {editingHead && (
              <div className="flex items-center gap-2 flex-wrap">
                <select
                  value={headSelection}
                  onChange={(e) => setHeadSelection(e.target.value)}
                  className="text-sm border border-black/10 rounded-md px-2 py-1"
                >
                  <option value="">— none —</option>
                  {(positions ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.positionTitle}
                      {p.positionCode ? ` (${p.positionCode})` : ""}
                    </option>
                  ))}
                </select>
                <button
                  onClick={saveHead}
                  disabled={savingHead}
                  className="text-xs font-medium text-accent hover:underline disabled:opacity-50"
                >
                  {savingHead ? "Saving…" : "Save"}
                </button>
                <button onClick={() => setEditingHead(false)} disabled={savingHead} className="text-xs text-label-tertiary hover:underline">
                  Cancel
                </button>
                {headError && <span className="text-xs text-danger">{headError}</span>}
              </div>
            )}
            {(positions ?? []).length === 0 && editingHead && (
              <div className="text-xs text-label-tertiary mt-1">This unit has no positions yet — create one first.</div>
            )}
          </div>

          <div>
            <div className="text-xs uppercase tracking-wide text-label-tertiary mb-1.5">Headcount</div>
            {positions === null ? (
              <div className="text-sm text-label-tertiary">Loading…</div>
            ) : headcount.total === 0 ? (
              <div className="text-sm text-label-tertiary">No positions in this unit yet.</div>
            ) : (
              <div className="flex items-center gap-4 flex-wrap text-sm">
                <span>
                  <span className="font-semibold">{headcount.filled}</span>
                  <span className="text-label-tertiary"> / {headcount.total} positions filled</span>
                </span>
                <span>
                  <span className="font-semibold">{headcount.filledFte.toFixed(1)}</span>
                  <span className="text-label-tertiary"> / {headcount.plannedFte.toFixed(1)} FTE filled</span>
                </span>
                {headcount.vacant > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-warning/15 text-warning font-medium">
                    {headcount.vacant} vacant
                  </span>
                )}
                {headcount.frozen > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-black/10 text-label-tertiary font-medium">
                    {headcount.frozen} frozen
                  </span>
                )}
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <div className="text-xs uppercase tracking-wide text-label-tertiary">Cost Centers</div>
              <span className="text-[10px] font-mono text-label-tertiary/60">
                {ORG_STRUCTURE_RELATIONSHIP_CODES.org_unit_cost_center.code}
              </span>
            </div>
            {unitCostCenters.length === 0 ? (
              <div className="text-sm text-label-tertiary">No cost center tagged to this unit.</div>
            ) : (
              <ul className="space-y-1">
                {unitCostCenters.map((cc) => (
                  <li key={cc.id} className="text-sm">
                    <span className="font-medium">{cc.name}</span>
                    {cc.code && <span className="text-xs font-mono text-label-tertiary ml-1.5">{cc.code}</span>}
                  </li>
                ))}
              </ul>
            )}
            <Link to="/app/organization/financial-centers" className="text-xs font-medium text-accent hover:underline">
              Manage cost centers →
            </Link>
          </div>

          <div>
            <div className="text-xs uppercase tracking-wide text-label-tertiary mb-1.5">Sub-units ({children.length})</div>
            {children.length === 0 ? (
              <div className="text-sm text-label-tertiary">No sub-units.</div>
            ) : (
              <ul className="space-y-1">
                {children.map((c) => (
                  <li key={c.id}>
                    <Link to={`/app/organization/units/${c.id}`} className="text-sm text-accent hover:underline">
                      {c.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {tab === "Positions" && (
        <div className="bg-card rounded-card shadow-sm px-4">
          <div className="flex justify-end pt-3">
            <Link to="/app/organization/positions" className="text-xs font-medium text-accent hover:underline">
              + New Position
            </Link>
          </div>
          {positions === null && <div className="text-sm text-label-tertiary py-4">Loading…</div>}
          {positions && positions.length === 0 && <div className="text-sm text-label-tertiary py-4">No positions in this unit.</div>}
          {positions &&
            positions.map((p) => (
              <div key={p.id} className="flex items-center gap-2 py-2.5 border-b border-black/5 last:border-0 flex-wrap">
                <Link to={`/app/organization/positions/${p.id}`} className="font-medium text-sm text-accent hover:underline">
                  {p.positionTitle}
                </Link>
                {p.positionCode && <span className="text-xs font-mono text-label-tertiary">{p.positionCode}</span>}
                <span className="text-xs px-2 py-0.5 rounded-full bg-black/5 text-label-secondary ml-auto">{p.status}</span>
              </div>
            ))}
        </div>
      )}

      {tab === "Employees" && (
        <div className="bg-card rounded-card shadow-sm px-4">
          <div className="flex justify-end pt-3">
            <Link to="/app/organization/assignments" className="text-xs font-medium text-accent hover:underline">
              + New Assignment
            </Link>
          </div>
          {assignments === null && <div className="text-sm text-label-tertiary py-4">Loading…</div>}
          {assignments && assignments.length === 0 && <div className="text-sm text-label-tertiary py-4">No active assignments to this unit.</div>}
          {assignments &&
            assignments.map((a) => {
              const employee = employeeById.get(a.employeeId);
              // Matrix/dotted-line reporting (kumail's own request) — this
              // employee's own additional (non-direct) relationship rows,
              // wherever they were set up (Relationship Explorer), surfaced
              // here so a unit's Employees tab shows the FULL reporting
              // picture, not just who's assigned to the unit.
              const extraRelationships = nonDirectRelationshipsByEmployeeId.get(a.employeeId) ?? [];
              return (
                <div key={a.id} className="py-2.5 border-b border-black/5 last:border-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link to={`/app/organization/assignments/${a.id}`} className="font-medium text-sm text-accent hover:underline">
                      {employee ? `${employee.firstName} ${employee.lastName}` : "Unknown employee"}
                    </Link>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-black/5 text-label-secondary">{a.assignmentType}</span>
                  </div>
                  {extraRelationships.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                      {extraRelationships.map((r) => {
                        const counterpart = employeeById.get(r.managerEmployeeId);
                        const { code, label } = ORG_REPORTING_RELATIONSHIP_CODES[r.relationshipType];
                        return (
                          <span
                            key={r.id}
                            className="text-xs px-2 py-0.5 rounded-full bg-accent/10 text-accent"
                            title={`${label} (${code})`}
                          >
                            {label}: {counterpart ? `${counterpart.firstName} ${counterpart.lastName}` : "Unknown"}
                          </span>
                        );
                      })}
                    </div>
                  )}
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
                  <span className="font-medium">{v.name}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-black/5 text-label-secondary">{UNIT_TYPE_LABELS[v.unitType]}</span>
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

      {tab === "Pending Changes" && (
        <div className="bg-card rounded-card shadow-sm px-4">
          {orgChanges === null && <div className="text-sm text-label-tertiary py-4">Loading…</div>}
          {orgChanges && pendingChanges.length === 0 && (
            <div className="text-sm text-label-tertiary py-4">No reorganization in flight touches this unit.</div>
          )}
          {pendingChanges.map(({ change, items }) => (
            <div key={change.id} className="py-2.5 border-b border-black/5 last:border-0">
              <Link to="/app/organization/reorganizations" className="font-medium text-sm text-accent hover:underline">
                {change.title}
              </Link>
              <div className="text-xs text-label-tertiary mt-0.5">
                {change.status} · Effective {change.effectiveDate} ·{" "}
                {items.map((i) => i.action).join(", ")}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
