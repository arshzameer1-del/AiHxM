import { FormEvent, useCallback, useEffect, useState } from "react";
import type { BloodGroup, EmployeeMedicalInfoView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { formatDay } from "../shared/dates";
import { LoadingNote } from "../shared/PageChrome";
import { BLOOD_GROUPS, medicalIsEmpty } from "./sensitiveRecords";

const field = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm";
const label = "block text-xs font-medium text-label-secondary mb-1";

const TEXT_FIELDS = [
  ["allergies", "Allergies"],
  ["chronicConditions", "Long-term conditions"],
  ["disabilityNote", "Disability or special needs"],
  ["emergencyMedicalNote", "What to tell a doctor in an emergency"],
] as const;

/**
 * BACKLOG54 - medical information. Private: only the person and HR can read it (line managers cannot). The person keeps
 * their own up to date; HR can edit too. If the viewer is refused, a plain notice is shown instead of an error.
 */
export function MedicalInfoPanel({ employeeId }: { employeeId: string }) {
  const [view, setView] = useState<EmployeeMedicalInfoView | null>(null);
  const [refused, setRefused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [blood, setBlood] = useState("");
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setView(null);
    api.getEmployeeMedicalInfo(employeeId).then(setView).catch((err) => {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) setRefused(true);
      else setError("Could not load the medical information.");
    });
  }, [employeeId]);
  useEffect(load, [load]);

  function startEdit() {
    if (!view) return;
    setBlood(view.bloodGroup ?? "");
    setTexts({ allergies: view.allergies ?? "", chronicConditions: view.chronicConditions ?? "", disabilityNote: view.disabilityNote ?? "", emergencyMedicalNote: view.emergencyMedicalNote ?? "" });
    setError(null);
    setEditing(true);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!view) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { employeeId };
      if (blood !== (view.bloodGroup ?? "")) body.bloodGroup = (blood || null) as BloodGroup | null;
      for (const [k] of TEXT_FIELDS) if ((texts[k] ?? "").trim() !== (view[k] ?? "")) body[k] = (texts[k] ?? "").trim() || null;
      if (Object.keys(body).length > 1) setView(await api.saveEmployeeMedicalInfo(body as never));
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  if (refused) return null;
  return (
    <section className="bg-card rounded-card p-5 shadow-sm mb-6" aria-label="Medical information" data-testid="medical-panel">
      <div className="flex items-center justify-between mb-1">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">Medical information</h2>
        {view && !editing && <button type="button" onClick={startEdit} className="text-xs font-semibold text-accent hover:underline">{medicalIsEmpty(view) ? "Add" : "Edit"}</button>}
      </div>
      <p className="text-xs text-label-tertiary mb-3">Private. Only {view?.isOwn ? "you and HR" : "the employee and HR"} can see this. It is stored encrypted.</p>
      {error && <div className="text-danger text-xs mb-2" role="alert">{error}</div>}
      {!view && !error && <LoadingNote />}
      {view && !editing && (
        medicalIsEmpty(view) ? (
          <p className="text-sm text-label-tertiary">Nothing has been added yet.</p>
        ) : (
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3" data-testid="medical-summary">
            <div><dt className="text-xs text-label-tertiary">Blood group</dt><dd className="text-sm">{view.bloodGroup ?? "—"}</dd></div>
            {TEXT_FIELDS.map(([k, l]) => (
              <div key={k}><dt className="text-xs text-label-tertiary">{l}</dt><dd className="text-sm whitespace-pre-wrap">{view[k] ?? "—"}</dd></div>
            ))}
            {view.updatedAt && <div><dt className="text-xs text-label-tertiary">Last updated</dt><dd className="text-sm">{formatDay(view.updatedAt.slice(0, 10))}</dd></div>}
          </dl>
        )
      )}
      {view && editing && (
        <form onSubmit={save} className="space-y-3">
          <div className="max-w-[10rem]">
            <label htmlFor="med-blood" className={label}>Blood group</label>
            <select id="med-blood" value={blood} onChange={(e) => setBlood(e.target.value)} className={field}>
              <option value="">Not set</option>
              {BLOOD_GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
          {TEXT_FIELDS.map(([k, l]) => (
            <div key={k}>
              <label htmlFor={`med-${k}`} className={label}>{l}</label>
              <textarea id={`med-${k}`} rows={2} maxLength={1000} value={texts[k] ?? ""} onChange={(e) => setTexts({ ...texts, [k]: e.target.value })} className={field} />
            </div>
          ))}
          <div className="flex gap-3">
            <button type="submit" disabled={busy} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
            <button type="button" onClick={() => setEditing(false)} className="text-xs font-medium text-label-tertiary hover:text-label-primary">Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}
