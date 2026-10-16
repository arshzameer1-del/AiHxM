import { useMemo, useState } from "react";
import type { EmployeeGroupView, PayrollAreaView } from "@aihxm/shared-types";
import { describeSelection, matchPastedEmployeeNumbers, type SelectableEmployee } from "./runSelection";

export type RunSelectionValue = { employeeIds: string[]; payrollAreaIds: string[]; employeeGroupIds: string[] };
export const EMPTY_RUN_SELECTION: RunSelectionValue = { employeeIds: [], payrollAreaIds: [], employeeGroupIds: [] };

const box = "border border-black/10 rounded-lg bg-white/60";
const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

/**
 * The payroll run's "Selection" block (the SAP payroll driver's Personnel Number / Payroll area selection, with several values
 * per field and employee groups added). Each field narrows the run; leave all of them empty to pay everyone the run covers.
 */
export function RunSelectionPicker({
  employees,
  employeesLoaded = true,
  areas,
  groups,
  value,
  onChange,
}: {
  employees: Array<SelectableEmployee & { firstName?: string; lastName?: string }>;
  /** False while the employee list is still being fetched: pasting is held back so a number is never reported "not found" just because the list has not arrived. */
  employeesLoaded?: boolean;
  areas: PayrollAreaView[];
  groups: EmployeeGroupView[];
  value: RunSelectionValue;
  onChange: (next: RunSelectionValue) => void;
}) {
  const [search, setSearch] = useState("");
  const [paste, setPaste] = useState("");
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const byId = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const q = search.trim().toLowerCase();
  const shown = useMemo(
    () => employees.filter((e) => !q || `${e.employeeNumber} ${e.firstName ?? ""} ${e.lastName ?? ""}`.toLowerCase().includes(q)).slice(0, 100),
    [employees, q]
  );
  const hasAny = value.employeeIds.length + value.payrollAreaIds.length + value.employeeGroupIds.length > 0;

  function addPasted() {
    const { matched, unknown } = matchPastedEmployeeNumbers(paste, employees);
    const ids = [...new Set([...value.employeeIds, ...matched.map((m) => m.id)])];
    onChange({ ...value, employeeIds: ids });
    setPasteNote(`${matched.length} added${unknown.length ? `; not found: ${unknown.slice(0, 8).join(", ")}${unknown.length > 8 ? ` and ${unknown.length - 8} more` : ""}` : ""}.`);
    if (unknown.length === 0) setPaste("");
  }

  return (
    <fieldset className="space-y-3" data-testid="run-selection">
      <legend className="text-xs font-semibold uppercase tracking-wide text-label-tertiary">Selection (optional)</legend>
      <p className="text-xs text-label-tertiary">
        Pay only some of the employees. Pick as many employees, payroll areas and employee groups as you need; each one you fill in narrows the run. Leave everything empty to pay everyone the run covers.
      </p>

      <div className="space-y-1.5">
        <label htmlFor="sel-search" className="text-sm font-medium">
          Employee numbers {value.employeeIds.length > 0 && <span className="text-label-tertiary font-normal">· {value.employeeIds.length} chosen</span>}
        </label>
        {value.employeeIds.length > 0 && (
          <div className="flex flex-wrap gap-1.5" data-testid="selected-employees">
            {value.employeeIds.map((id) => (
              <button key={id} type="button" onClick={() => onChange({ ...value, employeeIds: value.employeeIds.filter((x) => x !== id) })} className="text-xs rounded-full bg-accent/10 text-accent px-2 py-0.5" aria-label={`Remove ${byId.get(id)?.employeeNumber ?? id}`}>
                {byId.get(id)?.employeeNumber ?? "Unknown"} ✕
              </button>
            ))}
            <button type="button" onClick={() => onChange({ ...value, employeeIds: [] })} className="text-xs text-label-secondary underline">
              Clear
            </button>
          </div>
        )}
        <input id="sel-search" className={`${box} px-3 py-2 text-sm w-full`} placeholder="Search by number or name" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className={`${box} max-h-40 overflow-auto divide-y divide-black/5`} role="group" aria-label="Employees">
          {shown.length === 0 ? (
            <p className="text-xs text-label-tertiary p-2">{employeesLoaded ? "No employee matches." : "Loading employees…"}</p>
          ) : (
            shown.map((e) => (
              <label key={e.id} className="flex items-center gap-2 px-2 py-1 text-sm cursor-pointer hover:bg-black/5">
                <input type="checkbox" checked={value.employeeIds.includes(e.id)} onChange={() => onChange({ ...value, employeeIds: toggle(value.employeeIds, e.id) })} />
                <span className="font-mono text-xs tabular-nums">{e.employeeNumber}</span>
                <span className="truncate">{[e.firstName, e.lastName].filter(Boolean).join(" ")}</span>
              </label>
            ))
          )}
        </div>
        {employees.length > shown.length && !q && <p className="text-xs text-label-tertiary">Showing the first {shown.length} of {employees.length}. Search, or paste numbers below.</p>}
        <label htmlFor="sel-paste" className="text-xs text-label-secondary block pt-1">
          Or paste employee numbers (separated by commas, spaces or new lines)
        </label>
        <div className="flex gap-2">
          <textarea id="sel-paste" rows={2} className={`${box} px-3 py-2 text-xs font-mono flex-1`} value={paste} onChange={(e) => setPaste(e.target.value)} />
          <button type="button" onClick={addPasted} disabled={!paste.trim() || !employeesLoaded} className="self-start rounded-lg border border-black/10 px-3 py-2 text-sm font-semibold text-accent disabled:opacity-40">
            {employeesLoaded ? "Add" : "Loading…"}
          </button>
        </div>
        {pasteNote && <p role="status" className="text-xs text-label-secondary">{pasteNote}</p>}
      </div>

      {areas.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-sm font-medium">Payroll areas</div>
          <div className={`${box} max-h-32 overflow-auto divide-y divide-black/5`} role="group" aria-label="Payroll areas">
            {areas.map((a) => (
              <label key={a.id} className="flex items-center gap-2 px-2 py-1 text-sm cursor-pointer hover:bg-black/5">
                <input type="checkbox" checked={value.payrollAreaIds.includes(a.id)} onChange={() => onChange({ ...value, payrollAreaIds: toggle(value.payrollAreaIds, a.id) })} />
                <span>
                  {a.name} <span className="text-label-tertiary">({a.code})</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {groups.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-sm font-medium">Employee groups</div>
          <div className={`${box} max-h-32 overflow-auto divide-y divide-black/5`} role="group" aria-label="Employee groups">
            {groups.map((g) => (
              <label key={g.id} className="flex items-center gap-2 px-2 py-1 text-sm cursor-pointer hover:bg-black/5">
                <input type="checkbox" checked={value.employeeGroupIds.includes(g.id)} onChange={() => onChange({ ...value, employeeGroupIds: toggle(value.employeeGroupIds, g.id) })} />
                <span>{g.name}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-label-tertiary">A group pays the active employees who belong to it when the run is created.</p>
        </div>
      )}

      <p className="text-xs font-medium" data-testid="selection-summary">
        {hasAny ? `This run pays only: ${describeSelection(value)}.` : "This run pays everyone it covers."}
      </p>
    </fieldset>
  );
}
