import { FormEvent, useEffect, useMemo, useState } from "react";
import type { EmployeeView, OrgStructureNode, OrgUnitType, OrgUnitView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { describeError } from "../shared/describeError";
import { unitChoices, unitSubtreeIds } from "./orgStructure";

/**
 * The small forms that open above the structure table when a toolbar action needs input: create or change a unit,
 * move a unit or position, assign a holder. Each one calls the same endpoints the hierarchy editor always used; the
 * server decides whether the caller may do it.
 */

export const UNIT_TYPE_LABELS: Record<OrgUnitType, string> = {
  department: "Department",
  division: "Division",
  business_unit: "Business Unit",
  function: "Function",
};
const UNIT_TYPES = Object.keys(UNIT_TYPE_LABELS) as OrgUnitType[];

const field = "w-full rounded border border-black/25 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent";

function PanelShell({ title, children, error, onSubmit, submitLabel, busy, onCancel }: { title: string; children: React.ReactNode; error: string | null; onSubmit: (e: FormEvent) => void; submitLabel: string; busy: boolean; onCancel: () => void }) {
  return (
    <form onSubmit={onSubmit} aria-label={title} className="bg-amber-50/60 border border-black/10 border-b-0 px-3 py-3 space-y-3" data-testid="structure-panel">
      <div className="text-sm font-bold">{title}</div>
      {children}
      {error && <div role="alert" className="text-danger text-xs">{error}</div>}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy} className="bg-accent text-white rounded px-3 py-1.5 text-sm font-semibold disabled:opacity-50">
          {busy ? "Saving…" : submitLabel}
        </button>
        <button type="button" onClick={onCancel} className="border border-accent text-accent rounded px-3 py-1.5 text-sm font-semibold">
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Create a unit (under `parent`, or a root when there is none) or change an existing one. */
export function UnitPanel({ unit, parent, onDone, onCancel }: { unit?: OrgStructureNode; parent: { id: string; name: string } | null; onDone: (u: OrgUnitView) => void; onCancel: () => void }) {
  const editing = Boolean(unit);
  const [name, setName] = useState(unit?.name ?? "");
  const [unitType, setUnitType] = useState<OrgUnitType>(unit?.unitType ?? "department");
  const [code, setCode] = useState(unit?.code ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Enter a name.");
    setBusy(true);
    setError(null);
    try {
      const saved = unit
        ? await api.updateOrgUnit(unit.id, { name: name.trim(), unitType, code: code.trim() || undefined })
        : await api.createOrgUnit({ name: name.trim(), unitType, code: code.trim() || undefined, parentId: parent?.id });
      onDone(saved);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const title = editing ? `Change "${unit!.name}"` : parent ? `New organizational unit under "${parent.name}"` : "New root organizational unit";
  return (
    <PanelShell title={title} error={error} onSubmit={submit} submitLabel={editing ? "Save changes" : "Create"} busy={busy} onCancel={onCancel}>
      <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr_1fr] gap-3">
        <div>
          <label htmlFor="unit-name" className="block text-xs font-medium mb-1">Name</label>
          <input id="unit-name" autoFocus required value={name} onChange={(e) => setName(e.target.value)} className={field} />
        </div>
        <div>
          <label htmlFor="unit-type" className="block text-xs font-medium mb-1">Type</label>
          <select id="unit-type" value={unitType} onChange={(e) => setUnitType(e.target.value as OrgUnitType)} className={field}>
            {UNIT_TYPES.map((t) => (
              <option key={t} value={t}>{UNIT_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="unit-code" className="block text-xs font-medium mb-1">Code (optional)</label>
          <input id="unit-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. ENG" className={field} />
        </div>
      </div>
    </PanelShell>
  );
}

/** Move a unit under another unit (or make it a root), or move a position into another unit. */
export function MovePanel({ node, roots, onDone, onCancel }: { node: OrgStructureNode; roots: OrgStructureNode[]; onDone: () => void; onCancel: () => void }) {
  const isUnit = node.kind === "unit";
  const excluded = useMemo(() => (isUnit ? unitSubtreeIds(roots, node.id) : new Set<string>()), [roots, node, isUnit]);
  const current = isUnit ? node.parentId ?? "" : node.orgUnitId ?? "";
  const options = useMemo(() => unitChoices(roots).filter((u) => !excluded.has(u.id)), [roots, excluded]);
  const [target, setTarget] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (target === current) return setError(isUnit ? "It is already there." : "The position is already in that unit.");
    if (!isUnit && !target) return setError("Choose the unit the position moves to.");
    setBusy(true);
    setError(null);
    try {
      if (isUnit) await api.moveOrgUnit(node.id, { parentId: target || null });
      else await api.updatePosition(node.id, { orgUnitId: target });
      onDone();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PanelShell title={`Move "${node.name}"`} error={error} onSubmit={submit} submitLabel="Move here" busy={busy} onCancel={onCancel}>
      <div className="max-w-md">
        <label htmlFor="move-target" className="block text-xs font-medium mb-1">{isUnit ? "New parent unit" : "New unit"}</label>
        <select id="move-target" value={target} onChange={(e) => setTarget(e.target.value)} className={field}>
          {isUnit && <option value="">— Make it a root unit —</option>}
          {!isUnit && <option value="">Select…</option>}
          {options.map((u) => (
            <option key={u.id} value={u.id}>{`${"— ".repeat(u.depth)}${u.name}`}</option>
          ))}
        </select>
      </div>
    </PanelShell>
  );
}

/** Put an employee into a vacant position. */
export function AssignPanel({ position, onDone, onCancel }: { position: OrgStructureNode; onDone: () => void; onCancel: () => void }) {
  const [employees, setEmployees] = useState<EmployeeView[] | null>(null);
  const [filter, setFilter] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [from, setFrom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listEmployees().then(setEmployees).catch((err) => {
      setEmployees([]);
      setError(describeError(err));
    });
  }, []);

  const needle = filter.trim().toLowerCase();
  const matches = (employees ?? []).filter((e) => (needle === "" ? true : `${e.firstName} ${e.lastName} ${e.employeeNumber}`.toLowerCase().includes(needle))).slice(0, 200);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!employeeId) return setError("Choose an employee.");
    setBusy(true);
    setError(null);
    try {
      await api.assignPosition(position.id, { employeeId, effectiveFrom: from || undefined });
      onDone();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PanelShell title={`Assign a holder to "${position.name}"`} error={error} onSubmit={submit} submitLabel="Assign" busy={busy} onCancel={onCancel}>
      <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr] gap-3 max-w-2xl">
        <div>
          <label htmlFor="assign-search" className="block text-xs font-medium mb-1">Employee</label>
          <input id="assign-search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search by name or number" className={`${field} mb-1.5`} />
          <select id="assign-employee" aria-label="Employee" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} size={5} className={field}>
            {employees === null && <option disabled>Loading…</option>}
            {matches.map((e) => (
              <option key={e.id} value={e.id}>{`${e.firstName} ${e.lastName} (${e.employeeNumber})`}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="assign-from" className="block text-xs font-medium mb-1">Valid from (optional)</label>
          <input id="assign-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={field} />
        </div>
      </div>
    </PanelShell>
  );
}
