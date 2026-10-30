import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { CustomFieldType, FormDesignerView, FormFieldSettingView, FormLayout, FormLayoutCondition, FormLayoutHistoryView, FormSettingsView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { formatDateTime } from "../shared/dates";
import { FieldEditor } from "./FormSettingsPage";
import { addField, addSection, moveField, moveSection, nudgeField, placedKeys, removeField, removeSection, sameLayout, slugKey, updateField, updateSection } from "./formDesignerOps";

const input = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm";
const btn = "px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50";
const quiet = "px-3 py-1.5 rounded-lg bg-black/5 text-sm font-medium disabled:opacity-50";
const small = "px-2 py-1 rounded-md bg-black/5 text-xs font-medium disabled:opacity-40";

const OPS: Array<{ value: FormLayoutCondition["op"]; label: string }> = [
  { value: "equals", label: "is" },
  { value: "notEquals", label: "is not" },
  { value: "filled", label: "is filled in" },
  { value: "empty", label: "is empty" },
];
const TYPES: Array<{ value: CustomFieldType; label: string }> = [
  { value: "text", label: "Text" }, { value: "number", label: "Number" }, { value: "date", label: "Date" }, { value: "boolean", label: "Yes / no" }, { value: "select", label: "Choice from a list" },
];

type Meta = { label: string; custom: boolean; alwaysNeeded: boolean; canRequire: boolean };

function ConditionEditor({ id, title, value, options, onChange, disabled, note }: { id: string; title: string; value: FormLayoutCondition | undefined; options: Array<{ key: string; label: string }>; onChange: (c: FormLayoutCondition | undefined) => void; disabled?: boolean; note?: string }) {
  const needsValue = value && (value.op === "equals" || value.op === "notEquals");
  return (
    <fieldset className="border border-black/5 rounded-lg p-2" disabled={disabled}>
      <legend className="text-xs font-medium text-label-secondary px-1">{title}</legend>
      {disabled ? <p className="text-xs text-label-tertiary">{note}</p> : !value ? (
        <button type="button" className={small} onClick={() => options[0] && onChange({ field: options[0].key, op: "filled" })} disabled={options.length === 0}>Add a condition</button>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`${id}-f`} className="sr-only">{title}: field</label>
          <select id={`${id}-f`} className="rounded-lg border border-black/10 px-2 py-1 text-sm" value={value.field} onChange={(e) => onChange({ ...value, field: e.target.value })}>
            {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
          <label htmlFor={`${id}-o`} className="sr-only">{title}: test</label>
          <select id={`${id}-o`} className="rounded-lg border border-black/10 px-2 py-1 text-sm" value={value.op} onChange={(e) => { const op = e.target.value as FormLayoutCondition["op"]; onChange({ field: value.field, op, ...(op === "equals" || op === "notEquals" ? { value: value.value ?? "" } : {}) }); }}>
            {OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {needsValue && (<><label htmlFor={`${id}-v`} className="sr-only">{title}: value</label><input id={`${id}-v`} className="rounded-lg border border-black/10 px-2 py-1 text-sm w-40" value={value.value ?? ""} maxLength={100} onChange={(e) => onChange({ ...value, value: e.target.value })} /></>)}
          <button type="button" className={small} onClick={() => onChange(undefined)}>Remove condition</button>
        </div>
      )}
    </fieldset>
  );
}

function describe(c: FormLayoutCondition, label: (k: string) => string) {
  return c.op === "filled" ? `${label(c.field)} is filled in` : c.op === "empty" ? `${label(c.field)} is empty` : `${label(c.field)} ${c.op === "equals" ? "is" : "is not"} “${c.value ?? ""}”`;
}

export function FormDesignerPage() {
  const [params, setParams] = useSearchParams();
  const [forms, setForms] = useState<FormSettingsView[]>([]);
  const formKey = params.get("form") ?? "employee_profile";
  const [view, setView] = useState<FormDesignerView | null>(null);
  const [layout, setLayout] = useState<FormLayout | null>(null);
  const [saved, setSaved] = useState<FormLayout | null>(null);
  const [history, setHistory] = useState<FormLayoutHistoryView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [newField, setNewField] = useState({ label: "", type: "text" as CustomFieldType, options: "", required: false });
  const [addTo, setAddTo] = useState<string>("");

  const fail = (e: unknown) => { setError(e instanceof ApiError ? e.message : "That did not work. Try again."); setNotice(null); };
  const apply = useCallback((v: FormDesignerView) => { setView(v); setLayout(v.layout); setSaved(v.layout); }, []);
  const loadHistory = useCallback((k: string) => { api.formLayoutHistory(k).then(setHistory).catch(() => setHistory([])); }, []);

  useEffect(() => { api.listFormSettings().then(setForms).catch(() => setForms([])); }, []);
  useEffect(() => {
    setView(null); setError(null); setNotice(null); setConfirmReset(false);
    api.getFormDesigner(formKey).then((v) => { apply(v); setAddTo(v.layout.sections[0]?.key ?? ""); }).catch(fail);
    loadHistory(formKey);
  }, [formKey, apply, loadHistory]);

  const meta = useMemo(() => {
    const m = new Map<string, Meta>();
    for (const f of view?.settings.fields ?? []) m.set(f.fieldKey, { label: f.label, custom: false, alwaysNeeded: !f.canHide, canRequire: f.canRequire });
    for (const c of view?.customFields ?? []) m.set(c.key, { label: c.label, custom: true, alwaysNeeded: false, canRequire: true });
    return m;
  }, [view]);
  const labelOf = (k: string) => meta.get(k)?.label ?? k;
  const settingsOf = (k: string): FormFieldSettingView | undefined => view?.settings.fields.find((f) => f.fieldKey === k);
  const dirty = !!layout && !!saved && !sameLayout(layout, saved);

  const edit = (next: FormLayout) => { setLayout(next); setNotice(null); };

  async function persist(thenPublish: boolean) {
    if (!layout) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      let v = dirty || !view?.hasDraft ? await api.saveFormLayoutDraft(formKey, layout) : view;
      if (thenPublish) v = await api.publishFormLayout(formKey);
      apply(v); loadHistory(formKey);
      setNotice(thenPublish ? "Published. The form now follows this layout." : "Draft saved. It is not live until you publish.");
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function discard() {
    setBusy(true); setError(null);
    try { apply(view?.hasDraft ? await api.discardFormLayoutDraft(formKey) : await api.getFormDesigner(formKey)); setNotice("Changes discarded."); } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function resetAll() {
    setBusy(true); setError(null);
    try { apply(await api.resetFormLayout(formKey)); loadHistory(formKey); setConfirmReset(false); setNotice("Back to the form's default layout."); } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function createField() {
    if (!view?.customObjectKey || !layout) return;
    const label = newField.label.trim();
    if (!label) { setError("Give the new field a name."); return; }
    const opts = newField.options.split(",").map((o) => o.trim()).filter(Boolean);
    if (newField.type === "select" && opts.length === 0) { setError("Type the choices, separated by commas."); return; }
    setBusy(true); setError(null);
    try {
      const key = slugKey(label, new Set([...meta.keys()]));
      await api.defineCustomField({ objectKey: view.customObjectKey, fieldKey: key, label, fieldType: newField.type, ...(newField.type === "select" ? { options: opts } : {}), isRequired: newField.required });
      const fresh = await api.getFormDesigner(formKey);
      setView({ ...fresh, layout: view.layout });
      setLayout(addField(layout, addTo || layout.sections[0].key, { key, custom: true }));
      setNewField({ label: "", type: "text", options: "", required: false });
      setNotice(`“${label}” was created and added to the form. Save and publish to make it live.`);
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  if (error && !view) return <div><p className="text-xs mb-2"><Link to="/app/configuration-center" className="text-accent">Configuration Center</Link></p><p className="text-sm text-danger" role="alert">{error}</p></div>;
  if (!view || !layout) return <LoadingNote what="the form designer" />;

  const placed = placedKeys(layout);
  const tray: Array<{ key: string; label: string; custom: boolean }> = [
    ...view.settings.fields.filter((f) => f.canHide && !placed.has(f.fieldKey)).map((f) => ({ key: f.fieldKey, label: f.label, custom: false })),
    ...view.customFields.filter((c) => !placed.has(c.key)).map((c) => ({ key: c.key, label: c.label, custom: true })),
  ];
  const conditionOptions = (self: string) => [...placed].filter((k) => k !== self).map((k) => ({ key: k, label: labelOf(k) }));
  const onDrop = (sectionKey: string, index: number) => { if (dragKey) edit(moveField(layout, dragKey, sectionKey, index)); setDragKey(null); };
  const usingSingleSection = layout.sections.length === 1 && !layout.sections[0].title;

  return (
    <div data-testid="form-designer">
      <p className="text-xs mb-2"><Link to="/app/configuration-center" className="text-accent">Configuration Center</Link></p>
      <PageHeader title="Form designer" subtitle="Arrange a form into sections, choose and order its fields, add your own fields, and say when a field shows or is required. Nothing changes for your people until you publish. The server applies the same rules." />

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <label htmlFor="fd-form" className="text-sm font-medium">Form</label>
        <select id="fd-form" className="rounded-lg border border-black/10 px-3 py-2 text-sm" value={formKey} onChange={(e) => setParams({ form: e.target.value })}>
          {(forms.length ? forms : [{ formKey, title: view.title, fields: [] }]).map((f) => <option key={f.formKey} value={f.formKey}>{f.title}</option>)}
        </select>
        <span className="text-xs rounded-full px-2 py-0.5 bg-black/5" data-testid="fd-status">
          {dirty ? "Unsaved changes" : view.hasDraft ? "Draft saved, not live" : view.livePublished ? `Live, version ${view.version}${view.publishedAt ? ` · ${formatDateTime(view.publishedAt)}` : ""}` : "Not published yet · your people still see the default form"}
        </span>
        <Link to="/app/configuration-center/form-settings" className="text-xs text-accent ml-auto">Simple list of every form's field settings</Link>
      </div>

      {error && <p className="text-sm text-danger mb-3" role="alert">{error}</p>}
      {notice && <p className="text-sm text-accent mb-3" role="status">{notice}</p>}

      {!view.designable ? (
        <div className="max-w-5xl space-y-3">
          <p className="text-sm bg-card rounded-card p-4 shadow-sm">The layout of this form cannot be designed yet. You can still rename its fields, add help text, make them required, hide them or limit their length.</p>
          <section className="bg-card rounded-card p-4 shadow-sm" data-testid="fd-settings-only">
            {view.settings.fields.map((f) => <FieldEditor key={`${f.fieldKey}-${f.customised}-${f.label}-${f.hidden}-${f.required}-${f.maxLength}`} formKey={formKey} field={f} onSaved={(s) => setView({ ...view, settings: s })} onError={setError} />)}
          </section>
        </div>
      ) : (
        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4">
            <div className="flex flex-wrap gap-2 sticky top-0 z-10 bg-surface py-2" role="toolbar" aria-label="Layout actions">
              <button type="button" className={quiet} disabled={busy || !dirty} onClick={() => persist(false)}>Save draft</button>
              <button type="button" className={btn} disabled={busy || (!dirty && !view.hasDraft && view.livePublished)} onClick={() => persist(true)}>Publish</button>
              <button type="button" className={quiet} disabled={busy || (!dirty && !view.hasDraft)} onClick={discard}>Discard changes</button>
              {usingSingleSection && view.suggestedLayout && <button type="button" className={quiet} onClick={() => edit(view.suggestedLayout!)}>Group into suggested sections</button>}
              <button type="button" className={quiet} onClick={() => edit(addSection(layout))}>Add section</button>
              {view.livePublished && !confirmReset && <button type="button" className={`${quiet} ml-auto`} onClick={() => setConfirmReset(true)}>Reset to default</button>}
              {confirmReset && <span className="ml-auto flex items-center gap-2 text-sm">Put the form back to its default for everyone? <button type="button" className={btn} onClick={resetAll} disabled={busy}>Yes, reset</button><button type="button" className={quiet} onClick={() => setConfirmReset(false)}>Cancel</button></span>}
            </div>

            {layout.sections.map((sec, si) => (
              <section key={sec.key} className="bg-card rounded-card p-4 shadow-sm" data-testid={`fd-section-${sec.key}`} aria-label={sec.title || "Form fields"}
                onDragOver={(e) => { if (dragKey) e.preventDefault(); }} onDrop={() => onDrop(sec.key, sec.fields.length)}>
                <div className="flex flex-wrap items-end gap-2 mb-3">
                  <div className="flex-1 min-w-[12rem]">
                    <label htmlFor={`fd-t-${sec.key}`} className="block text-xs font-medium text-label-secondary mb-1">Section title</label>
                    <input id={`fd-t-${sec.key}`} className={input} value={sec.title} maxLength={80} placeholder={layout.sections.length > 1 ? "Required" : "Optional when there is one section"} onChange={(e) => edit(updateSection(layout, sec.key, { title: e.target.value }))} />
                  </div>
                  <div className="flex-1 min-w-[12rem]">
                    <label htmlFor={`fd-d-${sec.key}`} className="block text-xs font-medium text-label-secondary mb-1">Short explanation (optional)</label>
                    <input id={`fd-d-${sec.key}`} className={input} value={sec.description ?? ""} maxLength={300} onChange={(e) => edit(updateSection(layout, sec.key, { description: e.target.value }))} />
                  </div>
                  <button type="button" className={small} disabled={si === 0} onClick={() => edit(moveSection(layout, sec.key, -1))} aria-label={`Move section ${sec.title || si + 1} up`}>Up</button>
                  <button type="button" className={small} disabled={si === layout.sections.length - 1} onClick={() => edit(moveSection(layout, sec.key, 1))} aria-label={`Move section ${sec.title || si + 1} down`}>Down</button>
                  <button type="button" className={small} disabled={layout.sections.length <= 1} onClick={() => edit(removeSection(layout, sec.key))} aria-label={`Remove section ${sec.title || si + 1}; its fields move to a neighbouring section`}>Remove section</button>
                </div>
                {sec.fields.length === 0 && <p className="text-sm text-label-tertiary border border-dashed border-black/10 rounded-lg p-3">No fields here yet. Drag a field into this section, or use “Move to” on a field.</p>}
                <ul className="space-y-2">
                  {sec.fields.map((f, fi) => {
                    const m = meta.get(f.key);
                    const st = settingsOf(f.key);
                    return (
                      <li key={f.key} draggable onDragStart={() => setDragKey(f.key)} onDragEnd={() => setDragKey(null)} onDragOver={(e) => { if (dragKey) e.preventDefault(); }} onDrop={(e) => { e.stopPropagation(); onDrop(sec.key, fi); }}
                        className={`border rounded-lg p-3 ${dragKey === f.key ? "opacity-50 border-accent" : "border-black/10"}`} data-testid={`fd-field-${f.key}`}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span aria-hidden="true" className="cursor-grab text-label-tertiary select-none">⠿</span>
                          <span className="font-medium text-sm">{m?.label ?? f.key}</span>
                          {m?.custom && <span className="text-[11px] rounded-full bg-accent/10 text-accent px-2 py-0.5">Your field</span>}
                          {m?.alwaysNeeded && <span className="text-[11px] text-label-tertiary">Always needed</span>}
                          {f.readOnly && <span className="text-[11px] rounded-full bg-black/5 px-2 py-0.5">Read-only</span>}
                          {f.showWhen && <span className="text-[11px] rounded-full bg-black/5 px-2 py-0.5">Shows when {describe(f.showWhen, labelOf)}</span>}
                          {f.requiredWhen && <span className="text-[11px] rounded-full bg-black/5 px-2 py-0.5">Required when {describe(f.requiredWhen, labelOf)}</span>}
                          <span className="ml-auto flex flex-wrap items-center gap-1">
                            <button type="button" className={small} aria-label={`Move ${m?.label ?? f.key} up`} onClick={() => edit(nudgeField(layout, f.key, -1))}>Up</button>
                            <button type="button" className={small} aria-label={`Move ${m?.label ?? f.key} down`} onClick={() => edit(nudgeField(layout, f.key, 1))}>Down</button>
                            <label className="sr-only" htmlFor={`fd-mv-${f.key}`}>Move {m?.label ?? f.key} to section</label>
                            <select id={`fd-mv-${f.key}`} className="rounded-md border border-black/10 px-1 py-1 text-xs" value={sec.key} onChange={(e) => edit(moveField(layout, f.key, e.target.value, 9999))}>
                              {layout.sections.map((s, i) => <option key={s.key} value={s.key}>{s.title || `Section ${i + 1}`}</option>)}
                            </select>
                            <button type="button" className={small} disabled={m?.alwaysNeeded} title={m?.alwaysNeeded ? "This field is always needed" : undefined} aria-label={`Remove ${m?.label ?? f.key} from the form`} onClick={() => edit(removeField(layout, f.key))}>Remove</button>
                          </span>
                        </div>
                        <details className="mt-2">
                          <summary className="text-xs text-accent cursor-pointer">Rules and wording</summary>
                          <div className="mt-2 space-y-3">
                            <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={f.readOnly === true} onChange={(e) => edit(updateField(layout, f.key, { readOnly: e.target.checked }))} />Read-only (shown, but nobody can change it on this form)</label>
                            <ConditionEditor id={`fd-sw-${f.key}`} title="Show this field only when" value={f.showWhen} options={conditionOptions(f.key)} onChange={(c) => edit(updateField(layout, f.key, { showWhen: c }))} disabled={m?.alwaysNeeded} note="This field is always needed, so it always shows." />
                            <ConditionEditor id={`fd-rq-${f.key}`} title="Make this field required when" value={f.requiredWhen} options={conditionOptions(f.key)} onChange={(c) => edit(updateField(layout, f.key, { requiredWhen: c }))} disabled={!m?.canRequire} note="This field is already always required, or cannot be made required." />
                            {st ? (
                              <FieldEditor key={`${st.fieldKey}-${st.customised}-${st.label}-${st.hidden}-${st.required}-${st.maxLength}`} formKey={formKey} field={st} onSaved={(s) => setView((cur) => (cur ? { ...cur, settings: s } : cur))} onError={setError} />
                            ) : <p className="text-xs text-label-tertiary">Name, type and choices of your own fields are set when the field is created.</p>}
                          </div>
                        </details>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}

            <section className="bg-card rounded-card p-4 shadow-sm" data-testid="fd-tray">
              <h2 className="text-base font-bold mb-2">Fields not on the form</h2>
              {tray.length === 0 ? <p className="text-sm text-label-tertiary">Every available field is on the form.</p> : (
                <ul className="flex flex-wrap gap-2">
                  {tray.map((t) => (
                    <li key={t.key} className="flex items-center gap-2 border border-black/10 rounded-lg px-2 py-1 text-sm">
                      {t.label}{t.custom && <span className="text-[11px] text-accent">Your field</span>}
                      <button type="button" className={small} onClick={() => edit(addField(layout, addTo || layout.sections[0].key, { key: t.key, ...(t.custom ? { custom: true } : {}) }))} aria-label={`Add ${t.label} to the form`}>Add</button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2 flex items-center gap-2 text-sm"><label htmlFor="fd-addto">Add to section</label>
                <select id="fd-addto" className="rounded-lg border border-black/10 px-2 py-1 text-sm" value={addTo} onChange={(e) => setAddTo(e.target.value)}>
                  {layout.sections.map((s, i) => <option key={s.key} value={s.key}>{s.title || `Section ${i + 1}`}</option>)}
                </select>
              </div>
            </section>

            {view.customObjectKey && (
              <section className="bg-card rounded-card p-4 shadow-sm" data-testid="fd-newfield">
                <h2 className="text-base font-bold mb-1">Create your own field</h2>
                <p className="text-xs text-label-tertiary mb-3">For example “Medical insurance number”. It is added to the form and saved with each employee, with no change to the software.</p>
                <div className="grid sm:grid-cols-4 gap-3 items-end">
                  <div className="sm:col-span-2"><label htmlFor="fd-nf-l" className="block text-xs font-medium text-label-secondary mb-1">Field name</label><input id="fd-nf-l" className={input} value={newField.label} maxLength={80} onChange={(e) => setNewField({ ...newField, label: e.target.value })} /></div>
                  <div><label htmlFor="fd-nf-t" className="block text-xs font-medium text-label-secondary mb-1">Type</label>
                    <select id="fd-nf-t" className={input} value={newField.type} onChange={(e) => setNewField({ ...newField, type: e.target.value as CustomFieldType })}>{TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></div>
                  <label className="text-sm flex items-center gap-2 pb-2"><input type="checkbox" checked={newField.required} onChange={(e) => setNewField({ ...newField, required: e.target.checked })} />Always required</label>
                  {newField.type === "select" && <div className="sm:col-span-4"><label htmlFor="fd-nf-o" className="block text-xs font-medium text-label-secondary mb-1">Choices, separated by commas</label><input id="fd-nf-o" className={input} value={newField.options} onChange={(e) => setNewField({ ...newField, options: e.target.value })} /></div>}
                </div>
                <button type="button" className={`${btn} mt-3`} disabled={busy} onClick={createField}>Create field and add it to the form</button>
              </section>
            )}
          </div>

          <aside className="space-y-4" aria-label="Preview and history">
            <section className="bg-card rounded-card p-4 shadow-sm lg:sticky lg:top-14" data-testid="fd-preview">
              <h2 className="text-base font-bold mb-2">Preview</h2>
              <p className="text-xs text-label-tertiary mb-3">How the form is arranged. Fields with a condition show only when it holds.</p>
              {layout.sections.map((sec) => (
                <div key={sec.key} className="mb-4">
                  {sec.title && <h3 className="text-sm font-semibold">{sec.title}</h3>}
                  {sec.description && <p className="text-xs text-label-tertiary mb-1">{sec.description}</p>}
                  <div className="grid grid-cols-2 gap-2 mt-1">
                    {sec.fields.map((f) => (
                      <div key={f.key} className="text-xs">
                        <div className="font-medium">{labelOf(f.key)}{(settingsOf(f.key)?.required || f.requiredWhen || meta.get(f.key)?.custom && view.customFields.find((c) => c.key === f.key)?.isRequired) ? " *" : ""}</div>
                        <div className={`rounded-md border border-black/10 h-7 ${f.readOnly ? "bg-black/5" : ""}`} aria-hidden="true" />
                        {(f.showWhen || f.readOnly) && <div className="text-[10px] text-label-tertiary">{f.readOnly ? "read-only " : ""}{f.showWhen ? `· when ${describe(f.showWhen, labelOf)}` : ""}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </section>
            <section className="bg-card rounded-card p-4 shadow-sm" data-testid="fd-history">
              <h2 className="text-base font-bold mb-2">Versions</h2>
              {history.length === 0 ? <p className="text-sm text-label-tertiary">Nothing has been published yet.</p> : (
                <ul className="text-sm divide-y divide-black/5">
                  {history.slice(0, 10).map((h) => (
                    <li key={h.id} className="py-2 flex items-center gap-2">
                      <span className="flex-1">{h.action === "publish" ? `Version ${h.version}` : "Reset to default"}<span className="text-label-tertiary block text-xs">{formatDateTime(h.changedAt)}</span></span>
                      {h.action === "publish" && <button type="button" className={small} onClick={() => api.loadFormLayoutVersion(formKey, h.id).then((v) => { setView(v); setLayout(v.layout); setSaved(saved); setNotice("Loaded as a draft. Review it, then publish."); }).catch(fail)}>Load as draft</button>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}
