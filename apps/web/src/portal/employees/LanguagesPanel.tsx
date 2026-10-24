import { FormEvent, useCallback, useEffect, useState } from "react";
import type { EmployeeLanguageView, LanguageLevel } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote } from "../shared/PageChrome";
import { LANGUAGE_LEVELS, levelLabel } from "./sensitiveRecords";

const field = "rounded-lg border border-black/10 px-3 py-2 text-sm";

/** BACKLOG54 - languages a person speaks and writes. HR (`canManage`) keeps the list; the employee sees their own. */
export function LanguagesPanel({ employeeId, canManage }: { employeeId: string; canManage: boolean }) {
  const [rows, setRows] = useState<EmployeeLanguageView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState("");
  const [spoken, setSpoken] = useState<LanguageLevel>("conversational");
  const [written, setWritten] = useState<LanguageLevel>("conversational");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.listEmployeeLanguages(employeeId).then(setRows).catch(() => setError("Could not load the languages."));
  }, [employeeId]);
  useEffect(load, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!language.trim()) return setError("Enter the language.");
    setBusy(true);
    setError(null);
    try {
      await api.createEmployeeLanguage({ employeeId, language: language.trim(), spokenLevel: spoken, writtenLevel: written });
      setLanguage("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add the language.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await api.removeEmployeeLanguage(id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove the language.");
    }
  }

  return (
    <section className="bg-card rounded-card p-5 shadow-sm mb-6" aria-label="Languages" data-testid="languages-panel">
      <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-3">Languages</h2>
      {error && <div className="text-danger text-xs mb-2" role="alert">{error}</div>}
      {!rows && !error && <LoadingNote />}
      {rows && rows.length === 0 && <p className="text-sm text-label-tertiary">No languages on file.</p>}
      {rows && rows.length > 0 && (
        <ul className="divide-y divide-black/5 mb-3">
          {rows.map((l) => (
            <li key={l.id} className="py-2 flex items-center justify-between gap-3 text-sm" data-testid="language-row">
              <span><span className="font-medium">{l.language}</span> <span className="text-label-tertiary">· speaks {levelLabel(l.spokenLevel).toLowerCase()}, writes {levelLabel(l.writtenLevel).toLowerCase()}</span></span>
              {canManage && <button type="button" onClick={() => remove(l.id)} className="text-xs font-medium text-danger hover:underline">Remove</button>}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <form onSubmit={add} className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="lang-name" className="block text-xs font-medium text-label-secondary mb-1">Language</label>
            <input id="lang-name" value={language} onChange={(e) => setLanguage(e.target.value)} maxLength={60} className={field} />
          </div>
          <div>
            <label htmlFor="lang-spoken" className="block text-xs font-medium text-label-secondary mb-1">Speaking</label>
            <select id="lang-spoken" value={spoken} onChange={(e) => setSpoken(e.target.value as LanguageLevel)} className={field}>
              {LANGUAGE_LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="lang-written" className="block text-xs font-medium text-label-secondary mb-1">Writing</label>
            <select id="lang-written" value={written} onChange={(e) => setWritten(e.target.value as LanguageLevel)} className={field}>
              {LANGUAGE_LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </div>
          <button type="submit" disabled={busy} className="bg-accent text-white rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-50">Add language</button>
        </form>
      )}
    </section>
  );
}
