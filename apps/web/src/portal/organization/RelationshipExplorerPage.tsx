import { FormEvent, useEffect, useMemo, useState } from "react";
import type { EmployeeView, OrgRelationshipType, OrgRelationshipView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";

const TYPE_LABELS: Record<OrgRelationshipType, string> = {
  direct: "Direct (solid-line)",
  dotted_line: "Dotted-line",
  matrix: "Matrix",
  temporary: "Temporary",
  acting: "Acting",
};
const RELATIONSHIP_TYPES = Object.keys(TYPE_LABELS) as OrgRelationshipType[];

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Employee module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to manage this.";
    if (err.status === 409) return err.message || "That relationship isn't in a state that allows this action.";
    if (err.status === 400) return err.message || "That change isn't allowed.";
    return err.message;
  }
  return "Something went wrong.";
}

function typeBadgeClass(type: OrgRelationshipType): string {
  return type === "direct" ? "bg-accent/15 text-accent" : "bg-black/5 text-label-secondary";
}

type CreateFormValue = {
  relationshipType: OrgRelationshipType;
  managerEmployeeId: string;
};

/** A tiny, self-contained create form, scoped to one already-chosen
 * employee (the report) — picking a manager from the same employee list,
 * minus the employee themself (self-management is rejected server-side
 * too; this just avoids offering an option that would always fail). */
function CreateRelationshipForm({
  employeeId,
  employeeName,
  employees,
  onCancel,
  onSaved,
}: {
  employeeId: string;
  employeeName: string;
  employees: EmployeeView[];
  onCancel: () => void;
  onSaved: (input: { relationshipType: OrgRelationshipType; managerEmployeeId: string }) => Promise<void>;
}) {
  const candidates = employees.filter((e) => e.id !== employeeId);
  const [value, setValue] = useState<CreateFormValue>({
    relationshipType: "direct",
    managerEmployeeId: candidates[0]?.id ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onSaved(value);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 bg-black/5 rounded-lg p-4">
      <div className="text-xs text-label-tertiary">New reporting relationship for {employeeName}.</div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1">Type</label>
          <select
            value={value.relationshipType}
            onChange={(e) => setValue((v) => ({ ...v, relationshipType: e.target.value as OrgRelationshipType }))}
            className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {RELATIONSHIP_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Manager / counterpart</label>
          <select
            required
            value={value.managerEmployeeId}
            onChange={(e) => setValue((v) => ({ ...v, managerEmployeeId: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {candidates.length === 0 && <option value="">No other employees yet</option>}
            {candidates.map((e) => (
              <option key={e.id} value={e.id}>
                {e.firstName} {e.lastName} ({e.employeeNumber})
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting || !value.managerEmployeeId}
          className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
        >
          {submitting ? "Creating…" : "Create Relationship"}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function RelationshipRow({
  relationship,
  counterpartName,
  canManage,
  onChanged,
}: {
  relationship: OrgRelationshipView;
  counterpartName: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleEnd() {
    setBusy(true);
    setError(null);
    try {
      await api.endOrgRelationship(relationship.id);
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
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${typeBadgeClass(relationship.relationshipType)}`}>
          {TYPE_LABELS[relationship.relationshipType]}
        </span>
        <span className="font-medium text-sm">{counterpartName}</span>
        <span
          className={`text-xs px-2 py-0.5 rounded-full font-medium ${
            relationship.status === "active" ? "bg-success/15 text-green-700" : "bg-black/10 text-label-tertiary"
          }`}
        >
          {relationship.status}
        </span>

        {canManage && relationship.status === "active" && (
          <div className="ml-auto flex gap-3 shrink-0 text-xs">
            <button onClick={handleEnd} disabled={busy} className="font-medium text-label-tertiary hover:text-danger disabled:opacity-50">
              End
            </button>
          </div>
        )}
      </div>
      {error && <div className="text-xs text-danger py-1">{error}</div>}
    </div>
  );
}

/**
 * Organization Management, Phase 3 — the Relationship Explorer: pick an
 * employee, see who they report to (every typed relationship where they
 * are the report — one open `direct`, plus any concurrently-open
 * dotted_line/matrix/temporary/acting ones), create a new one, and end an
 * existing one. A simple list, not an org-chart visualization — the master
 * instruction's own Section 12 calls for the typed relationship data to
 * exist and be manageable; a graphical chart is explicitly named as a
 * later enhancement (Section 27's roadmap), not this phase's own scope.
 *
 * Every action here is a thin wrapper over OrgRelationshipsService's own
 * methods (cycle prevention + `employees.managerId` sync both happen
 * server-side — see that service's own class doc comment), which are the
 * real gate; this page's `canManage` is a courtesy, same as every other
 * portal screen. Deliberately NOT registered in Configuration Center —
 * like Position and Employee Org Assignment, this is transactional data,
 * not setup data.
 */
export function RelationshipExplorerPage() {
  const { identity } = useAuth();
  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>("");
  const [relationships, setRelationships] = useState<OrgRelationshipView[] | null>(null);
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
  }, []);

  function load() {
    if (!selectedEmployeeId) {
      setRelationships([]);
      return;
    }
    api
      .listOrgRelationships({ employeeId: selectedEmployeeId })
      .then(setRelationships)
      .catch((err) => setError(describeError(err)));
  }

  useEffect(load, [selectedEmployeeId]);

  const employeeById = useMemo(() => new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`])), [employees]);
  const selectedEmployee = employees.find((e) => e.id === selectedEmployeeId);
  const selectedEmployeeName = selectedEmployee ? `${selectedEmployee.firstName} ${selectedEmployee.lastName}` : "";

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;

  return (
    <div>
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Relationship Explorer</h1>
          <p className="text-sm text-label-tertiary mt-1">
            Who an employee reports to — one direct (solid-line) manager at a time, plus any dotted-line, matrix,
            temporary, or acting relationships alongside it.
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
            New Relationship
          </button>
        )}
      </div>

      {creating && selectedEmployeeId && (
        <div className="mb-4">
          <CreateRelationshipForm
            employeeId={selectedEmployeeId}
            employeeName={selectedEmployeeName}
            employees={employees}
            onCancel={() => setCreating(false)}
            onSaved={async (input) => {
              await api.createOrgRelationship({ employeeId: selectedEmployeeId, ...input });
              setCreating(false);
              load();
            }}
          />
        </div>
      )}

      {!relationships && <div className="text-label-tertiary text-sm">Loading…</div>}

      {relationships && relationships.length === 0 && !creating && (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
          {selectedEmployeeId
            ? "No reporting relationships for this employee yet."
            : "Select an employee to see their reporting relationships."}
        </div>
      )}

      {relationships && relationships.length > 0 && (
        <div className="bg-card rounded-card shadow-sm px-4">
          {relationships.map((r) => (
            <RelationshipRow
              key={r.id}
              relationship={r}
              counterpartName={employeeById.get(r.managerEmployeeId) ?? "Unknown employee"}
              canManage={canManage}
              onChanged={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}
