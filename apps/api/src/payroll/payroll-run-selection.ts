import { BadRequestException } from "@nestjs/common";
import type { PayrollRunSelectionInput } from "@aihxm/shared-types";

/** The choices of a run, cleaned: each list without duplicates, empty lists kept as empty (a dimension that was not chosen). */
export type RunSelectionInput = { employeeIds: string[]; payrollAreaIds: string[]; employeeGroupIds: string[] };
/** What is stored on payroll_runs.selection. */
export type StoredRunSelection = RunSelectionInput & { groupMemberIds: string[] };

export const MAX_SELECTED_EMPLOYEES = 1000;
export const MAX_SELECTED_AREAS = 50;
export const MAX_SELECTED_GROUPS = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uniqueIds(value: unknown, label: string, max: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && UUID_RE.test(v))) throw new BadRequestException(`selection.${label} must be a list of ids`);
  const ids = [...new Set((value as string[]).map((v) => v.toLowerCase()))];
  if (ids.length > max) throw new BadRequestException(`selection.${label} can hold at most ${max} values`);
  return ids;
}

/** null when nothing was chosen (the run pays everyone it covers). */
export function normalizeRunSelection(input: PayrollRunSelectionInput | undefined | null): RunSelectionInput | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new BadRequestException("selection must be an object");
  const sel = {
    employeeIds: uniqueIds(input.employeeIds, "employeeIds", MAX_SELECTED_EMPLOYEES),
    payrollAreaIds: uniqueIds(input.payrollAreaIds, "payrollAreaIds", MAX_SELECTED_AREAS),
    employeeGroupIds: uniqueIds(input.employeeGroupIds, "employeeGroupIds", MAX_SELECTED_GROUPS),
  };
  return sel.employeeIds.length + sel.payrollAreaIds.length + sel.employeeGroupIds.length === 0 ? null : sel;
}

/** The same choices always give the same text, whatever order they were sent in (used to recognise a repeated request). */
export function canonicalRunSelection(sel: unknown): string {
  const raw = (sel && typeof sel === "object" ? sel : {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()).sort() : []);
  return JSON.stringify({ e: list(raw.employeeIds), a: list(raw.payrollAreaIds), g: list(raw.employeeGroupIds) });
}
