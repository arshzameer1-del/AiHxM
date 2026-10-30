import type { FormLayout, FormLayoutField } from "@aihxm/shared-types";

/** Pure edits of a layout, so the designer screen stays simple and each rule can be tested. Every function returns a new layout. */

const clone = (l: FormLayout): FormLayout => JSON.parse(JSON.stringify(l));

export function findField(l: FormLayout, key: string): { sectionIndex: number; index: number; field: FormLayoutField } | null {
  for (let si = 0; si < l.sections.length; si++) {
    const i = l.sections[si].fields.findIndex((f) => f.key === key);
    if (i >= 0) return { sectionIndex: si, index: i, field: l.sections[si].fields[i] };
  }
  return null;
}

export function placedKeys(l: FormLayout): Set<string> {
  return new Set(l.sections.flatMap((s) => s.fields.map((f) => f.key)));
}

/** Moves a field to a section at a position (position counted after the field has been taken out). */
export function moveField(l: FormLayout, key: string, toSectionKey: string, toIndex: number): FormLayout {
  const next = clone(l);
  const at = findField(next, key);
  const target = next.sections.find((s) => s.key === toSectionKey);
  if (!at || !target) return l;
  const [field] = next.sections[at.sectionIndex].fields.splice(at.index, 1);
  target.fields.splice(Math.max(0, Math.min(toIndex, target.fields.length)), 0, field);
  return next;
}

/** One step up or down inside a section; at the edge it moves into the neighbouring section. */
export function nudgeField(l: FormLayout, key: string, dir: -1 | 1): FormLayout {
  const at = findField(l, key);
  if (!at) return l;
  const sec = l.sections[at.sectionIndex];
  const ni = at.index + dir;
  if (ni >= 0 && ni < sec.fields.length) return moveField(l, key, sec.key, ni);
  const neighbour = l.sections[at.sectionIndex + dir];
  if (!neighbour) return l;
  return moveField(l, key, neighbour.key, dir === -1 ? neighbour.fields.length : 0);
}

export function removeField(l: FormLayout, key: string): FormLayout {
  const next = clone(l);
  for (const s of next.sections) s.fields = s.fields.filter((f) => f.key !== key);
  // A rule that looked at the removed field would point at nothing, so it goes too.
  for (const s of next.sections) for (const f of s.fields) {
    if (f.showWhen?.field === key) delete f.showWhen;
    if (f.requiredWhen?.field === key) delete f.requiredWhen;
  }
  return next;
}

export function addField(l: FormLayout, sectionKey: string, field: FormLayoutField): FormLayout {
  const next = clone(l);
  if (placedKeys(next).has(field.key)) return l;
  const sec = next.sections.find((s) => s.key === sectionKey) ?? next.sections[0];
  sec.fields.push(field);
  return next;
}

export function updateField(l: FormLayout, key: string, patch: Partial<FormLayoutField>): FormLayout {
  const next = clone(l);
  const at = findField(next, key);
  if (!at) return l;
  const merged: Record<string, unknown> = { ...at.field, ...patch };
  for (const k of Object.keys(merged)) if (merged[k] === undefined || merged[k] === false) delete merged[k];
  next.sections[at.sectionIndex].fields[at.index] = merged as unknown as FormLayoutField;
  return next;
}

export function addSection(l: FormLayout, title = "New section"): FormLayout {
  const next = clone(l);
  let n = next.sections.length + 1;
  while (next.sections.some((s) => s.key === `section_${n}`)) n += 1;
  next.sections.push({ key: `section_${n}`, title, fields: [] });
  return next;
}

export function updateSection(l: FormLayout, key: string, patch: { title?: string; description?: string }): FormLayout {
  const next = clone(l);
  const s = next.sections.find((x) => x.key === key);
  if (!s) return l;
  if (patch.title !== undefined) s.title = patch.title;
  if (patch.description !== undefined) { if (patch.description) s.description = patch.description; else delete s.description; }
  return next;
}

export function moveSection(l: FormLayout, key: string, dir: -1 | 1): FormLayout {
  const i = l.sections.findIndex((s) => s.key === key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= l.sections.length) return l;
  const next = clone(l);
  [next.sections[i], next.sections[j]] = [next.sections[j], next.sections[i]];
  return next;
}

/** Removes a section. Its fields go into the section above (or below when it is the first), so no field is lost by accident. */
export function removeSection(l: FormLayout, key: string): FormLayout {
  if (l.sections.length <= 1) return l;
  const i = l.sections.findIndex((s) => s.key === key);
  if (i < 0) return l;
  const next = clone(l);
  const [gone] = next.sections.splice(i, 1);
  next.sections[i > 0 ? i - 1 : 0].fields.push(...gone.fields);
  return next;
}

/** A key a custom field can have: lower-case letters, digits and underscores, unique among the keys given. */
export function slugKey(label: string, taken: Set<string>): string {
  let base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[^a-z]+/, "").slice(0, 50);
  if (!base) base = "field";
  let k = base;
  let n = 2;
  while (taken.has(k)) { k = `${base}_${n}`; n += 1; }
  return k;
}

/** Layouts compared by content, to know whether there is anything unsaved. */
export const sameLayout = (a: FormLayout, b: FormLayout) => JSON.stringify(a) === JSON.stringify(b);
