import { BadRequestException } from "@nestjs/common";
import type { FormLayout, FormLayoutCondition, FormLayoutField } from "@aihxm/shared-types";
import type { CatalogForm } from "./form-catalog";

export const MAX_SECTIONS = 20;
export const MAX_FIELDS_PER_SECTION = 60;
export const MAX_FIELDS_TOTAL = 120;

const SECTION_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const OPS = ["equals", "notEquals", "filled", "empty"] as const;

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

/** True when the condition holds for these values. A value that is a boolean or number is compared as text. */
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

export function describeCondition(cond: FormLayoutCondition, labelOf: (key: string) => string): string {
  const f = labelOf(cond.field);
  if (cond.op === "filled") return `${f} is filled`;
  if (cond.op === "empty") return `${f} is empty`;
  return `${f} ${cond.op === "equals" ? "is" : "is not"} "${cond.value ?? ""}"`;
}

function bad(message: string, field?: string): never {
  throw new BadRequestException(field ? { message, field } : message);
}

/** Everything a saved layout must satisfy. Throws a 400 that names what is wrong. */
export function validateLayout(input: unknown, form: CatalogForm, customKeys: Set<string>): FormLayout {
  if (!input || typeof input !== "object" || !Array.isArray((input as FormLayout).sections)) bad("A layout needs a list of sections");
  const sections = (input as FormLayout).sections;
  if (sections.length < 1) bad("A layout needs at least one section");
  if (sections.length > MAX_SECTIONS) bad(`A form can have at most ${MAX_SECTIONS} sections`);

  const catalog = new Map(form.fields.map((f) => [f.key, f]));
  const placed = new Map<string, FormLayoutField>();
  const sectionKeys = new Set<string>();
  const clean: FormLayout = { sections: [] };
  let total = 0;

  for (const sec of sections) {
    if (!sec || typeof sec !== "object") bad("Each section must be an object");
    const key = String(sec.key ?? "");
    if (!SECTION_KEY.test(key)) bad(`Section key "${key}" is not valid: use lower-case letters, digits and underscores, starting with a letter`);
    if (sectionKeys.has(key)) bad(`Two sections have the key "${key}"`);
    sectionKeys.add(key);
    const title = String(sec.title ?? "").trim();
    if (sections.length > 1 && title === "") bad("Every section needs a title when a form has more than one section");
    if (title.length > 80) bad("A section title can be at most 80 characters");
    const description = sec.description === undefined || sec.description === null ? undefined : String(sec.description).trim();
    if (description && description.length > 300) bad("A section description can be at most 300 characters");
    if (!Array.isArray(sec.fields)) bad(`Section "${title || key}" needs a list of fields`);
    if (sec.fields.length > MAX_FIELDS_PER_SECTION) bad(`A section can hold at most ${MAX_FIELDS_PER_SECTION} fields`);
    const outFields: FormLayoutField[] = [];
    for (const f of sec.fields) {
      const fk = String(f?.key ?? "");
      const custom = f?.custom === true;
      if (custom ? !customKeys.has(fk) : !catalog.has(fk)) bad(custom ? `"${fk}" is not one of your custom fields` : `"${fk}" is not a field of this form`, fk);
      if (placed.has(fk)) bad(`"${fk}" is placed twice`, fk);
      total += 1;
      if (total > MAX_FIELDS_TOTAL) bad(`A form can have at most ${MAX_FIELDS_TOTAL} fields`);
      const out: FormLayoutField = { key: fk };
      if (custom) out.custom = true;
      if (f.readOnly === true) out.readOnly = true;
      if (f.showWhen) out.showWhen = f.showWhen;
      if (f.requiredWhen) out.requiredWhen = f.requiredWhen;
      placed.set(fk, out);
      outFields.push(out);
    }
    clean.sections.push({ key, title, ...(description ? { description } : {}), fields: outFields });
  }

  // A field the business always needs must be on the form, and must always show.
  for (const f of form.fields) {
    if (!f.canHide) {
      const p = placed.get(f.key);
      if (!p) bad(`"${f.label}" is always needed and cannot be removed from the form`, f.key);
      if (p.showWhen) bad(`"${f.label}" is always needed and cannot be shown only sometimes`, f.key);
    }
  }

  const checkCond = (owner: string, kind: string, c: FormLayoutCondition | undefined) => {
    if (!c) return;
    if (!c || typeof c !== "object" || !(OPS as readonly string[]).includes(c.op)) bad(`The ${kind} condition on "${owner}" has an unknown operator`, owner);
    if (!placed.has(c.field)) bad(`The ${kind} condition on "${owner}" looks at "${c.field}", which is not on the form`, owner);
    if (c.field === owner) bad(`"${owner}" cannot depend on itself`, owner);
    if ((c.op === "equals" || c.op === "notEquals") && (c.value === undefined || c.value === null || String(c.value).trim() === "")) bad(`The ${kind} condition on "${owner}" needs a value to compare with`, owner);
    if (c.value !== undefined && String(c.value).length > 100) bad("A condition value can be at most 100 characters", owner);
  };
  for (const [k, f] of placed) {
    checkCond(k, "show", f.showWhen);
    checkCond(k, "required", f.requiredWhen);
    if (f.requiredWhen && !f.custom && !catalog.get(k)?.canRequire) bad(`"${catalog.get(k)?.label ?? k}" is always required or cannot be made required`, k);
  }
  // Show conditions must not loop (A shows when B, B shows when A).
  const visiting = new Set<string>();
  const done = new Set<string>();
  const walk = (k: string) => {
    if (done.has(k)) return;
    if (visiting.has(k)) bad(`The show conditions loop back to "${k}"`, k);
    visiting.add(k);
    const dep = placed.get(k)?.showWhen?.field;
    if (dep) walk(dep);
    visiting.delete(k);
    done.add(k);
  };
  for (const k of placed.keys()) walk(k);
  return clean;
}

/** Visible fields of a layout for these values (a field whose show condition fails is not on the form). */
export function visibleKeys(layout: FormLayout, values: Record<string, unknown>): Set<string> {
  const byKey = new Map<string, FormLayoutField>();
  for (const s of layout.sections) for (const f of s.fields) byKey.set(f.key, f);
  const memo = new Map<string, boolean>();
  const vis = (k: string): boolean => {
    if (memo.has(k)) return memo.get(k)!;
    const f = byKey.get(k);
    let r = !!f;
    if (f?.showWhen) r = vis(f.showWhen.field) && conditionHolds(f.showWhen, values);
    memo.set(k, r);
    return r;
  };
  return new Set([...byKey.keys()].filter(vis));
}
