import type { PayrollRunSelectionInput } from "@aihxm/shared-types";

export type SelectableEmployee = { id: string; employeeNumber: string };

/** Splits pasted text (commas, spaces, new lines, semicolons) into employee numbers and matches them, case-insensitively, to employees. */
export function matchPastedEmployeeNumbers(text: string, employees: SelectableEmployee[]): { matched: SelectableEmployee[]; unknown: string[] } {
  const byNumber = new Map(employees.map((e) => [e.employeeNumber.toLowerCase(), e]));
  const seen = new Set<string>();
  const matched: SelectableEmployee[] = [];
  const unknown: string[] = [];
  for (const token of text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)) {
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = byNumber.get(key);
    if (hit) matched.push(hit);
    else unknown.push(token);
  }
  return { matched, unknown };
}

/** The request body for a selection; undefined when nothing is chosen (the run pays everyone it covers). */
export function selectionRequest(value: Required<PayrollRunSelectionInput>): PayrollRunSelectionInput | undefined {
  if (value.employeeIds.length + value.payrollAreaIds.length + value.employeeGroupIds.length === 0) return undefined;
  return { employeeIds: value.employeeIds, payrollAreaIds: value.payrollAreaIds, employeeGroupIds: value.employeeGroupIds };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 employees, 2 payroll areas and 1 employee group" - what a selection narrows the run to. */
export function describeSelection(value: { employeeIds: string[]; payrollAreaIds: string[]; employeeGroupIds: string[] }): string {
  const parts: string[] = [];
  if (value.employeeIds.length) parts.push(plural(value.employeeIds.length, "chosen employee", "chosen employees"));
  if (value.payrollAreaIds.length) parts.push(plural(value.payrollAreaIds.length, "payroll area", "payroll areas"));
  if (value.employeeGroupIds.length) parts.push(plural(value.employeeGroupIds.length, "employee group", "employee groups"));
  if (parts.length === 0) return "Everyone the run covers";
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
