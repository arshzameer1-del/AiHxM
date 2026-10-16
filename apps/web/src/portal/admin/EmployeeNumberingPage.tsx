import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { EmployeeNumberGenerationTiming, EmployeeNumberLedgerView, EmployeeNumberPolicyView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote } from "../shared/PageChrome";
import { formatDateTime } from "../shared/dates";

const TIMING_LABEL: Record<EmployeeNumberGenerationTiming, string> = {
  hire: "When the employee is hired (default)",
  draft: "As soon as a hire draft is started",
  save: "When the hire form is first saved",
  approval: "When the hire is approved",
};
const STATE_LABEL: Record<EmployeeNumberLedgerView["state"], string> = { reserved: "Reserved", issued: "Issued", void: "Voided" };
const SOURCE_LABEL: Record<EmployeeNumberLedgerView["source"], string> = { generated: "Generated", manual: "Typed in", imported: "Imported", backfill: "Existing employee" };

function describe(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Try again.";
}

/**
 * Configuration Center > Employee numbering. The rules (when a number is produced, whether the series restarts
 * every year, whether HR may type one in) and the ledger of every number ever reserved, issued or voided.
 * The prefix and digits come from the company settings and are not changed here.
 */
export function EmployeeNumberingPage() {
  const [policy, setPolicy] = useState<EmployeeNumberPolicyView | null>(null);
  const [draft, setDraft] = useState<EmployeeNumberPolicyView | null>(null);
  const [ledger, setLedger] = useState<EmployeeNumberLedgerView[]>([]);
  const [stateFilter, setStateFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api
      .getEmployeeNumberPolicy()
      .then((p) => {
        setPolicy(p);
        setDraft(p);
      })
      .catch((e) => setError(describe(e)));
  }, []);

  useEffect(() => {
    api
      .listEmployeeNumbers(stateFilter || undefined)
      .then(setLedger)
      .catch(() => setLedger([]));
  }, [stateFilter, policy]);

  if (error && !policy) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!policy || !draft) return <LoadingNote />;

  const patternOk = (() => {
    try {
      new RegExp(draft.manualPattern);
      return true;
    } catch {
      return false;
    }
  })();
  const changed =
    draft.generationTiming !== policy.generationTiming ||
    draft.resetPolicy !== policy.resetPolicy ||
    draft.allowManual !== policy.allowManual ||
    draft.manualPattern !== policy.manualPattern;

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await api.updateEmployeeNumberPolicy({
        generationTiming: draft.generationTiming,
        resetPolicy: draft.resetPolicy,
        allowManual: draft.allowManual,
        manualPattern: draft.manualPattern,
      });
      setPolicy(saved);
      setDraft(saved);
      setMessage("Saved. New hires follow these rules from now on.");
    } catch (e) {
      setError(describe(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-testid="employee-numbering">
      <Link to="/app/configuration-center" className="text-xs font-semibold text-accent">
        ← Configuration Center
      </Link>
      <h1 className="text-2xl font-bold tracking-tight mt-2 mb-1">Employee numbering</h1>
      <p className="text-label-tertiary text-sm mb-6">
        When an employee number is produced, whether the series restarts every year, and whether HR may type a number in. A number that was issued or voided is never used again.
      </p>

      <section aria-labelledby="numbering-rules" className="bg-card rounded-card p-5 shadow-sm mb-6 max-w-2xl">
        <h2 id="numbering-rules" className="font-semibold text-sm mb-4">
          Rules
        </h2>
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm" htmlFor="numbering-timing">
            <span className="font-medium">Produce the number</span>
            <select id="numbering-timing" className="border border-black/10 rounded-lg px-3 py-2 bg-transparent" value={draft.generationTiming} onChange={(e) => setDraft({ ...draft, generationTiming: e.target.value as EmployeeNumberGenerationTiming })}>
              {(Object.keys(TIMING_LABEL) as EmployeeNumberGenerationTiming[]).map((k) => (
                <option key={k} value={k}>
                  {TIMING_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm" htmlFor="numbering-reset">
            <span className="font-medium">Series</span>
            <select id="numbering-reset" className="border border-black/10 rounded-lg px-3 py-2 bg-transparent" value={draft.resetPolicy} onChange={(e) => setDraft({ ...draft, resetPolicy: e.target.value as "never" | "yearly" })}>
              <option value="never">One running series, never restarts</option>
              <option value="yearly">Restart at the first number every year</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm" htmlFor="numbering-manual">
            <input id="numbering-manual" type="checkbox" checked={draft.allowManual} onChange={(e) => setDraft({ ...draft, allowManual: e.target.checked })} />
            <span className="font-medium">HR may type an employee number instead of generating one</span>
          </label>
          <label className="flex flex-col gap-1 text-sm" htmlFor="numbering-pattern">
            <span className="font-medium">Typed numbers must match this pattern</span>
            <input id="numbering-pattern" className="border border-black/10 rounded-lg px-3 py-2 bg-transparent font-mono text-xs disabled:opacity-50" value={draft.manualPattern} disabled={!draft.allowManual} onChange={(e) => setDraft({ ...draft, manualPattern: e.target.value })} />
            {!patternOk && <span className="text-xs text-red-700">This is not a valid pattern.</span>}
          </label>
        </div>
        <div className="flex items-center gap-3 mt-5">
          <button type="button" onClick={save} disabled={!changed || !patternOk || saving} className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-semibold disabled:opacity-40">
            {saving ? "Saving…" : "Save rules"}
          </button>
          {changed && (
            <button type="button" onClick={() => setDraft(policy)} className="text-sm font-semibold text-label-secondary">
              Discard changes
            </button>
          )}
          {policy.updatedAt && <span className="text-xs text-label-tertiary">Last changed {formatDateTime(policy.updatedAt)}</span>}
        </div>
        {message && (
          <p role="status" className="text-sm text-green-800 mt-3">
            {message}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-700 mt-3">
            {error}
          </p>
        )}
      </section>

      <section aria-labelledby="numbering-ledger" className="bg-card rounded-card p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <h2 id="numbering-ledger" className="font-semibold text-sm">
            Issued numbers
          </h2>
          <label className="text-xs flex items-center gap-2" htmlFor="numbering-state">
            <span className="text-label-tertiary">Show</span>
            <select id="numbering-state" className="border border-black/10 rounded-lg px-2 py-1 bg-transparent" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
              <option value="">All</option>
              <option value="issued">Issued</option>
              <option value="reserved">Reserved</option>
              <option value="void">Voided</option>
            </select>
          </label>
        </div>
        {ledger.length === 0 ? (
          <p className="text-sm text-label-tertiary">No numbers yet. The first one is produced when you hire an employee.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-label-tertiary">
                  <th className="py-2 pr-4 font-medium">Number</th>
                  <th className="py-2 pr-4 font-medium">State</th>
                  <th className="py-2 pr-4 font-medium">Source</th>
                  <th className="py-2 pr-4 font-medium">Created</th>
                  <th className="py-2 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((row) => (
                  <tr key={row.id} className="border-t border-black/5">
                    <td className="py-2 pr-4 font-mono tabular-nums">{row.employeeNumber}</td>
                    <td className="py-2 pr-4">{STATE_LABEL[row.state]}</td>
                    <td className="py-2 pr-4">{SOURCE_LABEL[row.source]}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatDateTime(row.createdAt)}</td>
                    <td className="py-2 text-label-tertiary">{row.voidReason ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
