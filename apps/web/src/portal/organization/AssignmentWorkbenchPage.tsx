import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { AssignmentType, EmployeeOrgAssignmentView, EmployeeView, OrgUnitView, PositionView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";

const TYPE_LABELS: Record<AssignmentType, string> = {
  primary: "Primary",
  secondary: "Secondary",
  concurrent: "Concurrent",
  temporary: "Temporary",
  acting: "Acting",
  secondment: "Secondment",
};
const ASSIGNMENT_TYPES = Object.keys(TYPE_LABELS) as AssignmentType[];

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Employee module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to manage this.";
    if (err.status === 409) return err.message || "That assignment isn't in a state that allows this action.";
    return err.message;
  }
  return "Something went wrong.";
}

function typeBadgeClass(type: AssignmentType): string {
  return type === "primary" ? "bg-accent/15 text-accent" : "bg-black/5 text-label-secondary";
}

type CreateFormValue = {
  assignmentType: AssignmentType;
  orgUnitId: string;
  positionId: string;
};

/** A tiny, self-contained create form, scoped to one already-chosen
 * employee — mirrors CreatePositionForm's shape (PositionWorkbenchPage.tsx):
 * org unit is required, position is optional (not every assignment slot
 * needs one — a `secondary`/`temporary` assignment can be to a unit alone). */
function CreateAssignmentForm({
  employeeName,
  orgUnits,
  positions,
  onCancel,
  onSaved,
}: {
  employeeId: string;
  employeeName: string;
  orgUnits: OrgUnitView[];
  positions: PositionView[];
  onCancel: () => void;
  onSaved: (input: { assignmentType: AssignmentType; orgUnitId: string; positionId?: string }) => Promise<void>;
}) {
  const [value, setValue] = useState<CreateFormValue>({
    assignmentType: "primary",
    orgUnitId: orgUnits[0]?.id ?? "",
    positionId: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onSaved({
        assignmentType: value.assignmentType,
        orgUnitId: value.orgUnitId,
        positionId: value.positionId || undefined,
      });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 bg-black/5 rounded-lg p-4">
      <div className="text-xs text-label-tertiary">New assignment slot for {employeeName}.</div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1">Type</label>
          <select
            value={value.assignmentType}
            onChange={(e) => setValue((v) => ({ ...v, assignmentType: e.target.value as AssignmentType }))}
            className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {ASSIGNMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Org Unit</label>
          <select
            required
            value={value.orgUnitId}
            onChange={(e) => setValue((v) => ({ ...v, orgUnitId: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {orgUnits.length === 0 && <option value="">No org units yet</option>}
            {orgUnits.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Position (optional)</label>
          <select
            value={value.positionId}
            onChange={(e) => setValue((v) => ({ ...v, positionId: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="">— No position —</option>
            {positions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.positionTitle}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting || !value.orgUnitId}
          className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
        >
          {submitting ? "Creating…" : "Create Assignment"}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function AssignmentRow({
  assignment,
  orgUnitName,
  positionTitle,
  canManage,
  onChanged,
}: {
  assignment: EmployeeOrgAssignmentView;
  orgUnitName: string;
  positionTitle: string | null;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleEnd() {
    setBusy(true);
    setError(null);
    try {
      await api.endEmployeeOrgAssignment(assignment.id);
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 py-2.5 border-b border-black/5 hover:bg-black/[0.02] flex-wrap">
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${typeBadgeClass(assignment.assignmentType)}`}>
          {TYPE_LABELS[assignment.assignmentType]}
        </span>
        <span className="font-medium text-sm">{orgUnitName}</span>
        {positionTitle && <span className="text-xs text-label-tertiary">{positionTitle}</span>}
        <span
          className={`text-xs px-2 py-0.5 rounded-full font-medium ${
            assignment.status === "active" ? "bg-success/15 text-green-700" : "bg-black/10 text-label-tertiary"
          }`}
        >
          {assignment.status}
        </span>

        <div className="ml-auto flex gap-3 shrink-0 text-xs">
          {/* Organization Management Phase 9 — the "View" link into
            AssignmentDetailPage, ungated by `canManage` for the same
            reason OrgHierarchyPage's/PositionWorkbenchPage's own "View"
            links are (see OrgHierarchyPage.tsx's comment). */}
          <Link to={`/app/organization/assignments/${assignment.id}`} className="font-medium text-label-secondary hover:underline">
            View
          </Link>
          {canManage && assignment.status === "active" && (
            <button onClick={handleEnd} disabled={busy} className="font-medium text-label-tertiary hover:text-danger disabled:opacity-50">
              End
            </button>
          )}
        </div>
      </div>
      {error && <div className="text-xs text-danger py-1">{error}</div>}
    </div>
  );
}

/**
 * Organization Management, Phase 3 — the Assignment Workbench: pick an
 * employee, see every assignment slot they hold (primary plus any
 * concurrently-open secondary/concurrent/temporary/acting/secondment
 * slots), create a new slot, and end an existing one. Every action here is
 * a thin wrapper over EmployeeOrgAssignmentsService's own methods, which
 * are the real gate (this page's `canManage` is a courtesy, same as every
 * other portal screen). Deliberately NOT registered in Configuration
 * Center — like Position, this is transactional/operational data, not
 * setup data (see PositionWorkbenchPage.tsx's own header comment for the
 * same reasoning applied here).
 *
 * A full org-chart-style Relationship Explorer visualization is this
 * phase's sibling page (RelationshipExplorerPage.tsx) rather than folded
 * in here — assignment slots (where someone sits) and reporting
 * relationships (who they report to) are two distinct canonical facts per
 * the master instruction's own Section 11/Section 12 split, so they get
 * two screens rather than one overloaded one.
 */
export function AssignmentWorkbenchPage() {
  const { identity } = useAuth();
  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [orgUnits, setOrgUnits] = useState<OrgUnitView[]>([]);
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>("");
  const [assignments, setAssignments] = useState<EmployeeOrgAssignmentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const canManage = identity?.roleKeys.includes("hr_admin") ?? false;

  useEffect(() => {
    api
      .listEmployees()
      .then((list) => {
        setEmployees(list);
        setSelectedEmployeeId((current) => current || list[0]?.id || "");
      })
      .catch((err) => setError(describeError(err)));
    api.listOrgUnits().then(setOrgUnits).catch(() => undefined);
    api.listPositions().then(setPositions).catch(() => undefined);
  }, []);

  function load() {
    if (!selectedEmployeeId) {
      setAssignments([]);
      return;
    }
    api
      .listEmployeeOrgAssignments({ employeeId: selectedEmployeeId })
      .then(setAssignments)
      .catch((err) => setError(describeError(err)));
  }

  useEffect(load, [selectedEmployeeId]);

  const orgUnitById = useMemo(() => new Map(orgUnits.map((u) => [u.id, u.name])), [orgUnits]);
  const positionById = useMemo(() => new Map(positions.map((p) => [p.id, p.positionTitle])), [positions]);
  const selectedEmployee = employees.find((e) => e.id === selectedEmployeeId);
  const selectedEmployeeName = selectedEmployee ? `${selectedEmployee.firstName} ${selectedEmployee.lastName}` : "";

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;

  return (
    <div>
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Assignment Workbench</h1>
          <p className="text-sm text-label-tertiary mt-1">
            Every org unit/position slot an employee holds — a person can have one primary assignment plus any number
            of secondary, concurrent, temporary, acting, or secondment ones at the same time.
          </p>
        </div>
      </div>

      <div className="flex gap-3 mb-4">
        <select
          value={selectedEmployeeId}
          onChange={(e) => setSelectedEmployeeId(e.target.value)}
          className="rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent min-w-[16rem]"
        >
          {employees.length === 0 && <option value="">No employees yet</option>}
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.firstName} {e.lastName} ({e.employeeNumber})
            </option>
          ))}
        </select>
        {canManage && selectedEmployeeId && !creating && (
          <button
            onClick={() => setCreating(true)}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold shrink-0"
          >
            New Assignment
          </button>
        )}
      </div>

      {creating && selectedEmployeeId && (
        <div className="mb-4">
          <CreateAssignmentForm
            employeeId={selectedEmployeeId}
            employeeName={selectedEmployeeName}
            orgUnits={orgUnits}
            positions={positions}
            onCancel={() => setCreating(false)}
            onSaved={async (input) => {
              await api.createEmployeeOrgAssignment({ employeeId: selectedEmployeeId, ...input });
              setCreating(false);
              load();
            }}
          />
        </div>
      )}

      {!assignments && <div className="text-label-tertiary text-sm">Loading…</div>}

      {assignments && assignments.length === 0 && !creating && (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
          {selectedEmployeeId
            ? "No assignment slots for this employee yet."
            : "Select an employee to see their assignments."}
        </div>
      )}

      {assignments && assignments.length > 0 && (
        <div className="bg-card rounded-card shadow-sm px-4">
          {assignments.map((a) => (
            <AssignmentRow
              key={a.id}
              assignment={a}
              orgUnitName={orgUnitById.get(a.orgUnitId) ?? "Unknown unit"}
              positionTitle={a.positionId ? positionById.get(a.positionId) ?? null : null}
              canManage={canManage}
              onChanged={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}
