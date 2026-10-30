import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { FormFieldSettingView, FormSettingHistoryView, FormSettingsView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { formatDateTime } from "../shared/dates";

const input = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm";
const btn = "px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50";
const quiet = "px-3 py-1.5 rounded-lg bg-black/5 text-sm font-medium disabled:opacity-50";

export function FieldEditor({ formKey, field, onSaved, onError }: { formKey: string; field: FormFieldSettingView; onSaved: (f: FormSettingsView) => void; onError: (m: string | null) => void }) {
  const [label, setLabel] = useState(field.label);
  const [help, setHelp] = useState(field.helpText ?? "");
  const [ph, setPh] = useState(field.placeholder ?? "");
  const [hidden, setHidden] = useState(field.hidden);
  const [required, setRequired] = useState(field.required);
  const [max, setMax] = useState(field.maxLength ? String(field.maxLength) : "");
  const fail = (e: unknown) => onError(e instanceof ApiError ? e.message : "That did not save.");
  const id = `${formKey}-${field.fieldKey}`;
  function save() {
    onError(null);
    const body = {
      label: label.trim() === field.defaultLabel ? null : label,
      helpText: help,
      placeholder: ph,
      ...(field.canHide ? { hidden } : {}),
      ...(field.canRequire ? { required: hidden ? null : required } : {}),
      ...(field.canSetMaxLength ? { maxLength: max.trim() ? Number(max) : null } : {}),
    };
    api.updateFormField(formKey, field.fieldKey, body).then(onSaved).catch(fail);
  }
  return (
    <div className="border-t border-black/5 py-3" data-testid={`fs-${formKey}-${field.fieldKey}`}>
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-sm font-semibold">{field.defaultLabel}</h3>
        {field.customised && <span className="text-[11px] rounded-full bg-accent/10 text-accent px-2 py-0.5">Changed</span>}
        {!field.canHide && !field.canRequire && <span className="text-[11px] text-label-tertiary">Always needed</span>}
      </div>
      <div className="grid sm:grid-cols-3 gap-3">
        <div><label htmlFor={`${id}-l`} className="block text-xs font-medium text-label-secondary mb-1">Label shown</label><input id={`${id}-l`} className={input} value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} /></div>
        <div><label htmlFor={`${id}-h`} className="block text-xs font-medium text-label-secondary mb-1">Help text</label><input id={`${id}-h`} className={input} value={help} maxLength={300} onChange={(e) => setHelp(e.target.value)} /></div>
        <div><label htmlFor={`${id}-p`} className="block text-xs font-medium text-label-secondary mb-1">Placeholder</label><input id={`${id}-p`} className={input} value={ph} maxLength={120} onChange={(e) => setPh(e.target.value)} /></div>
      </div>
      <div className="flex flex-wrap items-center gap-4 mt-2">
        {field.canRequire && <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={required && !hidden} disabled={hidden} onChange={(e) => setRequired(e.target.checked)} />Required</label>}
        {field.canHide && <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />Hide this field</label>}
        {field.canSetMaxLength && <label className="text-sm flex items-center gap-2" htmlFor={`${id}-m`}>Longest allowed<input id={`${id}-m`} className="w-24 rounded-lg border border-black/10 px-2 py-1 text-sm" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ""))} /></label>}
        <button type="button" className={btn} onClick={save}>Save {field.defaultLabel}</button>
        {field.customised && <button type="button" className={quiet} onClick={() => api.resetFormField(formKey, field.fieldKey).then(onSaved).catch(fail)}>Back to default</button>}
      </div>
    </div>
  );
}

/** Configuration Center > Form settings. What each person sees and must fill in on leave, expense and help desk forms. The server applies the same rules. */
export function FormSettingsPage() {
  const [forms, setForms] = useState<FormSettingsView[] | null>(null);
  const [history, setHistory] = useState<FormSettingHistoryView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const loadHistory = useCallback(() => { api.formSettingsHistory().then(setHistory).catch(() => setHistory([])); }, []);
  useEffect(() => { api.listFormSettings().then(setForms).catch((e) => { setForms([]); setError(e instanceof ApiError ? e.message : "Could not load form settings."); }); loadHistory(); }, [loadHistory]);
  const saved = (f: FormSettingsView) => { setForms((cur) => (cur ?? []).map((x) => (x.formKey === f.formKey ? f : x))); setNotice("Saved. The form now follows this setting."); setError(null); loadHistory(); };
  const title = (key: string) => forms?.find((f) => f.formKey === key)?.title ?? key;
  return (
    <div data-testid="form-settings">
      <p className="text-xs mb-2"><Link to="/app/configuration-center" className="text-accent">Configuration Center</Link></p>
      <PageHeader title="Form settings" subtitle="Rename a field, add help text, make it required, hide it or limit its length. The screen and the server both follow these settings. A field the business always needs can be renamed but not hidden." />
      {error && <p className="text-sm text-danger mb-3" role="alert">{error}</p>}
      {notice && <p className="text-sm text-accent mb-3" role="status">{notice}</p>}
      {forms === null ? <LoadingNote what="form settings" /> : (
        <div className="space-y-6 max-w-5xl">
          {forms.map((form) => (
            <section key={form.formKey} className="bg-card rounded-card p-4 shadow-sm" data-testid={`form-${form.formKey}`}>
              <h2 className="text-base font-bold mb-1">{form.title}</h2>
              {form.fields.map((f) => <FieldEditor key={`${f.fieldKey}-${f.customised}-${f.label}-${f.hidden}-${f.required}-${f.maxLength}`} formKey={form.formKey} field={f} onSaved={saved} onError={setError} />)}
            </section>
          ))}
          <section className="bg-card rounded-card p-4 shadow-sm" data-testid="fs-history">
            <h2 className="text-base font-bold mb-2">Changes</h2>
            {history.length === 0 ? <p className="text-sm text-label-tertiary">Nothing has been changed yet.</p> : (
              <ul className="text-sm divide-y divide-black/5">
                {history.slice(0, 20).map((h) => (
                  <li key={h.id} className="py-2 flex flex-wrap items-center gap-3">
                    <span className="flex-1 min-w-[12rem]">{title(h.formKey)} · {h.fieldKey} · {h.action === "change" ? "changed" : h.action === "reset" ? "set back to default" : "restored"}<span className="text-label-tertiary"> · {formatDateTime(h.changedAt)}</span></span>
                    <button type="button" className="text-xs text-accent" onClick={() => api.restoreFormSetting(h.id).then(saved).catch((e) => setError(e instanceof ApiError ? e.message : "Could not restore."))}>Undo this change</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
