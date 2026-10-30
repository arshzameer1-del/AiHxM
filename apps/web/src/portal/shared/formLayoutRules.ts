import type { FormLayout, FormLayoutCondition } from "@aihxm/shared-types";

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

/** The same rule the server applies (form-layout.rules.ts): text is compared without case, empty means blank. */
export function conditionHolds(cond: FormLayoutCondition, values: Record<string, unknown>): boolean {
  const v = values[cond.field];
  switch (cond.op) {
    case "filled": return !isBlank(v);
    case "empty": return isBlank(v);
    case "equals": return !isBlank(v) && String(v).trim().toLowerCase() === String(cond.value ?? "").trim().toLowerCase();
    case "notEquals": return isBlank(v) || String(v).trim().toLowerCase() !== String(cond.value ?? "").trim().toLowerCase();
    default: return false;
  }
}

/** Fields that are on the form for these values: a field whose show condition fails (or depends on a hidden field) is not. */
export function visibleKeys(layout: FormLayout, values: Record<string, unknown>): Set<string> {
  const byKey = new Map<string, FormLayout["sections"][number]["fields"][number]>();
  for (const s of layout.sections) for (const f of s.fields) byKey.set(f.key, f);
  const memo = new Map<string, boolean>();
  const vis = (k: string, depth = 0): boolean => {
    if (memo.has(k)) return memo.get(k)!;
    const f = byKey.get(k);
    let r = !!f;
    if (f?.showWhen) r = depth < 30 && vis(f.showWhen.field, depth + 1) && conditionHolds(f.showWhen, values);
    memo.set(k, r);
    return r;
  };
  return new Set([...byKey.keys()].filter((k) => vis(k)));
}

/** Fields the layout makes required right now (only counts fields that are showing). */
export function requiredKeys(layout: FormLayout, values: Record<string, unknown>): Set<string> {
  const vis = visibleKeys(layout, values);
  const out = new Set<string>();
  for (const s of layout.sections) for (const f of s.fields) if (f.requiredWhen && vis.has(f.key) && conditionHolds(f.requiredWhen, values)) out.add(f.key);
  return out;
}

export function describeCondition(cond: FormLayoutCondition, labelOf: (key: string) => string): string {
  const f = labelOf(cond.field);
  if (cond.op === "filled") return `${f} is filled`;
  if (cond.op === "empty") return `${f} is empty`;
  return `${f} ${cond.op === "equals" ? "is" : "is not"} "${cond.value ?? ""}"`;
}
