import { FormEvent, useCallback, useEffect, useState } from "react";
import type { CompetencyView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { ErrorNote, Field, errorText, inputCls, primaryBtn } from "./perfUi";

/** HR: the competency library and the tenant-defined minimum number of raters before anonymous 360 input is shown. */
export function PerformanceSetupPanel() {
  const [competencies, setCompetencies] = useState<CompetencyView[]>([]);
  const [minRaters, setMinRaters] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState({ name: "", category: "", description: "" });

  const load = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([api.listCompetencies(true), api.getPerformanceSettings()]);
      setCompetencies(c);
      setMinRaters(s.minRatersForAnonymity === null ? "" : String(s.minRatersForAnonymity));
      setError(null);
      setLoaded(true);
    } catch (err) {
      setError(errorText(err, "Could not load the setup"));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function saveSettings(e: FormEvent) {
    e.preventDefault();
    try {
      await api.updatePerformanceSettings({ minRatersForAnonymity: minRaters === "" ? null : Number(minRaters) });
      setSaved("Saved");
      setError(null);
    } catch (err) {
      setSaved(null);
      setError(errorText(err, "Could not save the setting"));
    }
  }

  async function addCompetency(e: FormEvent) {
    e.preventDefault();
    try {
      await api.createCompetency({ name: form.name, category: form.category || undefined, description: form.description || undefined });
      setForm({ name: "", category: "", description: "" });
      await load();
    } catch (err) {
      setError(errorText(err, "Could not add the competency"));
    }
  }

  if (!loaded) return error ? <ErrorNote message={error} /> : <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div className="space-y-6">
      <ErrorNote message={error} />
      <section className="bg-card rounded-card shadow-sm p-4 space-y-3">
        <h3 className="font-semibold">Anonymity of multi-rater feedback</h3>
        <p className="text-sm text-label-secondary">
          Anonymous responses stay hidden from managers and employees until at least this many people from the same group (peers, direct reports, skip-level) have answered. Leave empty to show every response straight away. HR always sees everything.
        </p>
        <form onSubmit={saveSettings} className="flex items-end gap-3 flex-wrap">
          <Field label="Minimum raters (2 to 20)">
            <input type="number" min={2} max={20} className={inputCls} value={minRaters} onChange={(e) => { setMinRaters(e.target.value); setSaved(null); }} />
          </Field>
          <button type="submit" className={primaryBtn}>Save</button>
          {saved && <span className="text-sm text-green-700">{saved}</span>}
        </form>
      </section>

      <section className="bg-card rounded-card shadow-sm p-4 space-y-3">
        <h3 className="font-semibold">Competencies</h3>
        <ul className="divide-y divide-black/5 text-sm">
          {competencies.map((c) => (
            <li key={c.id} className="py-2 flex items-center justify-between gap-3">
              <span>
                <span className={c.isActive ? "font-medium" : "font-medium line-through text-label-tertiary"}>{c.name}</span>
                {c.category && <span className="text-xs text-label-tertiary"> · {c.category}</span>}
                {c.description && <div className="text-xs text-label-secondary">{c.description}</div>}
              </span>
              <button className="text-xs text-accent" onClick={() => api.updateCompetency(c.id, { name: c.name, isActive: !c.isActive }).then(load).catch((err) => setError(errorText(err, "Could not update")))}>
                {c.isActive ? "Retire" : "Restore"}
              </button>
            </li>
          ))}
          {competencies.length === 0 && <li className="py-2 text-label-tertiary">No competencies yet. Add the ones your reviews should rate.</li>}
        </ul>
        <form onSubmit={addCompetency} className="grid sm:grid-cols-[1fr_10rem_1fr_auto] gap-2 items-end">
          <Field label="Name"><input required className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Category"><input className={inputCls} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></Field>
          <Field label="Description"><input className={inputCls} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <button type="submit" className={primaryBtn}>Add</button>
        </form>
      </section>
    </div>
  );
}
