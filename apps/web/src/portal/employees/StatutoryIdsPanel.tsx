import { FormEvent, useEffect, useState } from "react";
import type { EmployeeStatutoryIdsView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote } from "../shared/PageChrome";
import { formatDay } from "../shared/dates";

/**
 * BACKLOG49 - EOBI, PESSI / SESSI, provident fund, CNIC validity and visa / work permit. HR edits; an employee sees their own
 * (read-only). The numbers are encrypted at rest.
 */
type Field = { key: keyof EmployeeStatutoryIdsView; label: string; type: "text" | "date" | "scheme" };
const GROUPS: { title: string; fields: Field[] }[] = [
  {
    title: "EOBI",
    fields: [
      { key: "eobiNumber", label: "EOBI number", type: "text" },
      { key: "eobiRegistrationDate", label: "Registered on", type: "date" },
    ],
  },
  {
    title: "Provincial social security",
    fields: [
      { key: "socialSecurityScheme", label: "Scheme", type: "scheme" },
      { key: "socialSecurityNumber", label: "Registration number", type: "text" },
      { key: "socialSecurityRegistrationDate", label: "Registered on", type: "date" },
    ],
  },
  {
    title: "Provident fund",
    fields: [
      { key: "providentFundNumber", label: "Member number", type: "text" },
      { key: "providentFundMemberSince", label: "Member since", type: "date" },
    ],
  },
  {
    title: "CNIC validity",
    fields: [
      { key: "cnicIssueDate", label: "Issued on", type: "date" },
      { key: "cnicExpiryDate", label: "Expires on", type: "date" },
    ],
  },
  {
    title: "Visa and work permit (foreign nationals)",
    fields: [
      { key: "visaType", label: "Visa type", type: "text" },
      { key: "visaExpiryDate", label: "Visa expires on", type: "date" },
      { key: "workPermitNumber", label: "Work permit number", type: "text" },
      { key: "workPermitExpiryDate", label: "Work permit expires on", type: "date" },
    ],
  },
];
const SCHEMES = [
  { value: "", label: "—" },
  { value: "pessi", label: "PESSI (Punjab)" },
  { value: "sessi", label: "SESSI (Sindh)" },
  { value: "other", label: "Other" },
];

function display(view: EmployeeStatutoryIdsView, f: Field): string {
  const v = view[f.key];
  if (f.key === "cnicExpiryDate" && view.cnicLifetime) return "Lifetime";
  if (v === null || v === undefined || v === "") return "—";
  if (f.type === "date") return formatDay(String(v));
  if (f.type === "scheme") return SCHEMES.find((s) => s.value === v)?.label ?? String(v);
  return String(v);
}

export function StatutoryIdsPanel({ employeeId, canManage }: { employeeId: string; canManage: boolean }) {
  const [view, setView] = useState<EmployeeStatutoryIdsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setView(null);
    api.getEmployeeStatutoryIds(employeeId).then(setView).catch(() => setError("Could not load the statutory IDs."));
  }, [employeeId]);

  function startEdit() {
    if (!view) return;
    const init: Record<string, string | boolean> = {};
    for (const g of GROUPS) for (const f of g.fields) init[f.key] = (view[f.key] as string | null) ?? "";
    init.cnicLifetime = view.cnicLifetime;
    setValues(init);
    setError(null);
    setEditing(true);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!view) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { employeeId };
      for (const g of GROUPS) for (const f of g.fields) {
        const next = String(values[f.key] ?? "").trim();
        const before = String((view[f.key] as string | null) ?? "");
        if (next !== before) body[f.key] = next === "" ? null : next;
      }
      if (values.cnicLifetime !== view.cnicLifetime) body.cnicLifetime = values.cnicLifetime;
      if (Object.keys(body).length === 1) {
        setEditing(false);
        return;
      }
      setView(await api.saveEmployeeStatutoryIds(body as never));
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="bg-card rounded-card p-5 shadow-sm mb-6" aria-label="Statutory IDs">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">Statutory IDs</h2>
        {canManage && view && !editing && (
          <button onClick={startEdit} className="text-xs font-semibold text-accent hover:underline">Edit</button>
        )}
      </div>
      {error && <div className="text-danger text-xs mb-2" role="alert">{error}</div>}
      {!view && !error && <LoadingNote />}
      {view && !editing && (
        <div className="space-y-4">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <h3 className="text-xs font-medium text-label-secondary mb-1">{g.title}</h3>
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2">
                {g.fields.map((f) => (
                  <div key={f.key}>
                    <dt className="text-xs text-label-tertiary">{f.label}</dt>
                    <dd className="text-sm">{display(view, f)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
      {view && editing && (
        <form onSubmit={save} className="space-y-4">
          {GROUPS.map((g) => (
            <fieldset key={g.title}>
              <legend className="text-xs font-medium text-label-secondary mb-1">{g.title}</legend>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {g.fields.map((f) => (
                  <div key={f.key}>
                    <label htmlFor={`stat-${f.key}`} className="block text-xs font-medium mb-1">{f.label}</label>
                    {f.type === "scheme" ? (
                      <select id={`stat-${f.key}`} value={String(values[f.key] ?? "")} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm">
                        {SCHEMES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                      </select>
                    ) : (
                      <input
                        id={`stat-${f.key}`}
                        type={f.type === "date" ? "date" : "text"}
                        value={String(values[f.key] ?? "")}
                        disabled={f.key === "cnicExpiryDate" && values.cnicLifetime === true}
                        onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                        className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
                      />
                    )}
                  </div>
                ))}
                {g.title === "CNIC validity" && (
                  <label className="flex items-center gap-2 text-sm self-end pb-2">
                    <input type="checkbox" checked={values.cnicLifetime === true} onChange={(e) => setValues({ ...values, cnicLifetime: e.target.checked })} />
                    Lifetime CNIC
                  </label>
                )}
              </div>
            </fieldset>
          ))}
          <div className="flex gap-3">
            <button type="submit" disabled={saving} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">{saving ? "Saving…" : "Save"}</button>
            <button type="button" onClick={() => setEditing(false)} className="text-xs font-medium text-label-tertiary hover:text-label-primary">Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}
