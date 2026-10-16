import { LoadingNote } from "../shared/PageChrome";
import { useEffect, useState } from "react";
import type {
  PayrollAccountingPreviewView,
  PayrollCostingSummaryView,
  PayrollGlMappingView,
  PayrollGlMatchType,
  PayrollJournalTypeView,
  PayrollJournalView,
} from "@aihxm/shared-types";
import { api } from "../../api/client";
import { ReasonModal } from "../../components/ReasonModal";
import { Field, Notice, Pill, RunPicker, buttonClass, errorMessage, inputClass, quietButtonClass } from "./PayrollPanelKit";
import { pkr } from "./payrollLabels";
import { formatDay } from "../shared/dates";

const money = (n: number) => pkr.format(n);

const MATCH_LABEL: Record<PayrollGlMatchType, string> = {
  component_key: "Pay component",
  category: "Component category",
  special: "Special line",
};
const SPECIAL_HINT = "net_pay_payable is the account employees' net pay is owed from.";

/**
 * PAY-17 - the tenant's chart-of-accounts mapping. Account codes are whatever the tenant's ledger uses: none is
 * shipped, so a journal cannot be built until every pay component it touches is mapped.
 */
export function GlMappingsPanel({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<PayrollGlMappingView[] | null>(null);
  const [types, setTypes] = useState<PayrollJournalTypeView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [form, setForm] = useState({ matchType: "component_key" as PayrollGlMatchType, matchValue: "", debitAccountCode: "", creditAccountCode: "" });

  const load = () => {
    api.listGlMappings().then(setRows).catch((e) => setError(errorMessage(e, "Could not load the GL mappings.")));
    api.listJournalTypes().then(setTypes).catch(() => undefined);
  };
  useEffect(load, []);

  async function save() {
    setError(null);
    setSaved(null);
    try {
      await api.upsertGlMapping({
        matchType: form.matchType,
        matchValue: form.matchValue.trim(),
        debitAccountCode: form.debitAccountCode.trim() || null,
        creditAccountCode: form.creditAccountCode.trim() || null,
      });
      setForm({ ...form, matchValue: "", debitAccountCode: "", creditAccountCode: "" });
      setSaved("Mapping saved.");
      load();
    } catch (e) {
      setError(errorMessage(e, "Could not save the mapping."));
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await api.deleteGlMapping(id);
      load();
    } catch (e) {
      setError(errorMessage(e, "Could not remove the mapping."));
    }
  }

  async function renamePrefix(t: PayrollJournalTypeView, numberPrefix: string) {
    setError(null);
    try {
      await api.updateJournalType(t.id, { numberPrefix });
      load();
    } catch (e) {
      setError(errorMessage(e, "Could not change the journal number prefix."));
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-xs text-label-tertiary">
        Map each pay component (or a whole category) to the debit and credit accounts of your own ledger. No account codes are assumed.
        {" "}{SPECIAL_HINT}
      </p>
      <Notice error={error} saved={saved} />
      {!rows ? (
        <LoadingNote />
      ) : rows.length === 0 ? (
        <p className="text-sm text-label-tertiary">Nothing is mapped yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-label-tertiary">
              <tr><th className="py-1 pr-3">Applies to</th><th className="pr-3">Match</th><th className="pr-3">Debit account</th><th className="pr-3">Credit account</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className="border-t border-black/5">
                  <td className="py-1 pr-3">{MATCH_LABEL[m.matchType]}</td>
                  <td className="pr-3 font-mono text-xs">{m.matchValue}</td>
                  <td className="pr-3 font-mono text-xs">{m.debitAccountCode ?? "-"}</td>
                  <td className="pr-3 font-mono text-xs">{m.creditAccountCode ?? "-"}</td>
                  <td className="text-right">{canManage && <button type="button" className="text-xs text-danger" onClick={() => remove(m.id)}>Remove</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canManage && (
        <div className="grid gap-2 sm:grid-cols-5 items-end">
          <Field label="Applies to">
            <select id="gl-match-type" className={inputClass} value={form.matchType} onChange={(e) => setForm({ ...form, matchType: e.target.value as PayrollGlMatchType })}>
              {(Object.keys(MATCH_LABEL) as PayrollGlMatchType[]).map((k) => <option key={k} value={k}>{MATCH_LABEL[k]}</option>)}
            </select>
          </Field>
          <Field label="Component key / category / line"><input id="gl-match-value" className={inputClass} value={form.matchValue} onChange={(e) => setForm({ ...form, matchValue: e.target.value })} placeholder="basic_salary" /></Field>
          <Field label="Debit account"><input id="gl-debit" className={inputClass} value={form.debitAccountCode} onChange={(e) => setForm({ ...form, debitAccountCode: e.target.value })} /></Field>
          <Field label="Credit account"><input id="gl-credit" className={inputClass} value={form.creditAccountCode} onChange={(e) => setForm({ ...form, creditAccountCode: e.target.value })} /></Field>
          <button type="button" className={buttonClass} onClick={save} disabled={!form.matchValue.trim()}>Save mapping</button>
        </div>
      )}
      {types.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Journal numbering</h3>
          <div className="grid gap-2 sm:grid-cols-3">
            {types.map((t) => (
              <div key={t.id} className="bg-black/5 rounded-lg p-3 text-sm">
                <div className="font-medium">{t.name}</div>
                <div className="text-xs text-label-tertiary mb-2">Next number {t.nextNumber}</div>
                <input
                  id={`journal-prefix-${t.code}`}
                  aria-label={`${t.name} number prefix`}
                  className={inputClass}
                  defaultValue={t.numberPrefix}
                  disabled={!canManage}
                  maxLength={12}
                  onBlur={(e) => e.target.value !== t.numberPrefix && e.target.value.trim() && renamePrefix(t, e.target.value.trim())}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const JOURNAL_TONE = { draft: "warn", posted: "good", reversed: "neutral", discarded: "neutral" } as const;

/** PAY-17 - build, check, post and reverse the journal of one finalised run, and see its cost-centre costing. */
export function RunAccountingPanel({ canPost }: { canPost: boolean }) {
  const [runId, setRunId] = useState("");
  const [preview, setPreview] = useState<PayrollAccountingPreviewView | null>(null);
  const [journals, setJournals] = useState<PayrollJournalView[]>([]);
  const [open, setOpen] = useState<PayrollJournalView | null>(null);
  const [costing, setCosting] = useState<PayrollCostingSummaryView | null>(null);
  const [postingDate, setPostingDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reversing, setReversing] = useState<PayrollJournalView | null>(null);

  const load = async (id: string) => {
    setError(null);
    setOpen(null);
    if (!id) {
      setPreview(null);
      setJournals([]);
      setCosting(null);
      return;
    }
    try {
      const [p, j, c] = await Promise.all([api.previewRunAccounting(id), api.listRunJournals(id), api.getRunCosting(id)]);
      setPreview(p);
      setJournals(j);
      setCosting(c);
    } catch (e) {
      setError(errorMessage(e, "Could not load the accounting view of this run."));
    }
  };
  useEffect(() => {
    void load(runId);
  }, [runId]);

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await fn();
      setSaved(label);
      await load(runId);
    } catch (e) {
      setError(errorMessage(e, "That did not work."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="max-w-md">
        <Field label="Payroll run">
          <RunPicker value={runId} onChange={setRunId} statuses={["finalized", "accounting", "payment_released", "reconciled", "closed", "reopened", "reversed"]} />
        </Field>
      </div>
      <Notice error={error} saved={saved} />
      {runId && preview && (
        <>
          <div className="bg-black/5 rounded-lg p-3 text-sm space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">Ready to post?</span>
              {preview.ready ? <Pill tone="good">Yes</Pill> : <Pill tone="warn">Not yet</Pill>}
            </div>
            {preview.unmappedKeys.length > 0 && (
              <p className="text-xs text-red-700">No account for: {preview.unmappedKeys.map((u) => u.label || u.key).join(", ")}. Add them under GL mappings.</p>
            )}
            {preview.missingSpecial.length > 0 && <p className="text-xs text-red-700">Missing special mapping: {preview.missingSpecial.join(", ")}.</p>}
            {preview.unallocatedEmployees > 0 && (
              <p className="text-xs text-label-tertiary">{preview.unallocatedEmployees} employee(s) have no cost-centre allocation; their cost shows as unallocated.</p>
            )}
            <p className="text-xs text-label-tertiary">Debits {money(preview.totalDebit)} · Credits {money(preview.totalCredit)}</p>
          </div>

          {canPost && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Posting date (optional)"><input id="journal-posting-date" type="date" className={inputClass} value={postingDate} onChange={(e) => setPostingDate(e.target.value)} /></Field>
              <button type="button" className={buttonClass} disabled={busy || !preview.ready} onClick={() => act("Journal generated.", () => api.generateRunJournal(runId, postingDate ? { postingDate } : {}))}>
                Generate journal
              </button>
              <button type="button" className={quietButtonClass} disabled={busy} onClick={() => act("Costing generated.", () => api.generateRunCosting(runId))}>
                Generate costing
              </button>
            </div>
          )}

          {journals.length > 0 && (
            <div className="space-y-2">
              {journals.map((j) => (
                <div key={j.id} className="bg-black/5 rounded-lg">
                  <button type="button" className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm" onClick={async () => setOpen(open?.id === j.id ? null : await api.getPayrollJournal(j.id))}>
                    <span>
                      <span className="font-medium">{j.journalNumber ?? "Draft journal"}</span>
                      <span className="text-xs text-label-tertiary"> · {j.journalKind === "reversal" ? "Reversal" : "Payroll"} · {formatDay(j.postingDate)} · {money(j.totalDebit)}</span>
                    </span>
                    <Pill tone={JOURNAL_TONE[j.status]}>{j.status}</Pill>
                  </button>
                  {open?.id === j.id && (
                    <div className="px-3 pb-3 space-y-2">
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead className="text-left text-label-tertiary"><tr><th className="pr-2">Account</th><th className="pr-2">Description</th><th className="pr-2">Cost centre</th><th className="text-right pr-2">Debit</th><th className="text-right">Credit</th></tr></thead>
                          <tbody>
                            {(open.lines ?? []).map((l) => (
                              <tr key={l.lineNo} className="border-t border-black/5">
                                <td className="font-mono pr-2">{l.accountCode}</td>
                                <td className="pr-2">{l.description ?? l.componentKey}</td>
                                <td className="pr-2">{l.costCenterCode ?? "-"}</td>
                                <td className="text-right pr-2">{l.debit ? money(l.debit) : ""}</td>
                                <td className="text-right">{l.credit ? money(l.credit) : ""}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" className={quietButtonClass} onClick={() => api.downloadPayrollText(`/payroll/journals/${j.id}/csv`, `${j.journalNumber ?? "journal-draft"}.csv`).catch((e) => setError(errorMessage(e, "Could not download the journal.")))}>Download CSV</button>
                        {canPost && j.status === "draft" && (
                          <>
                            <button type="button" className={buttonClass} disabled={busy} onClick={() => act("Journal posted.", () => api.postPayrollJournal(j.id))}>Post journal</button>
                            <button type="button" className={quietButtonClass} disabled={busy} onClick={() => act("Draft discarded.", () => api.discardPayrollJournal(j.id))}>Discard draft</button>
                          </>
                        )}
                        {canPost && j.status === "posted" && j.journalKind === "run" && (
                          <button type="button" className={quietButtonClass} onClick={() => setReversing(j)}>Reverse posting</button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {costing && costing.byCostCenter.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-2">Costing by cost centre</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-label-tertiary"><tr><th className="pr-3">Cost centre</th><th className="pr-3 text-right">Employees</th><th className="pr-3 text-right">Gross</th><th className="pr-3 text-right">Employer cost</th><th className="text-right">Total</th></tr></thead>
                  <tbody>
                    {costing.byCostCenter.map((c) => (
                      <tr key={c.costCenterId ?? "none"} className="border-t border-black/5">
                        <td className="pr-3">{c.costCenterCode ?? <span className="text-label-tertiary">Unallocated</span>}</td>
                        <td className="pr-3 text-right">{c.employees}</td>
                        <td className="pr-3 text-right">{money(c.grossCost)}</td>
                        <td className="pr-3 text-right">{money(c.employerCost)}</td>
                        <td className="text-right font-medium">{money(c.totalCost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
      {reversing && (
        <ReasonModal
          title="Reverse this posting"
          description="A mirror journal is created; the original stays on record."
          confirmLabel="Reverse posting"
          danger
          onCancel={() => setReversing(null)}
          onConfirm={async (reason) => {
            await api.reversePayrollJournal(reversing.id, reason);
            setReversing(null);
            setSaved("Posting reversed.");
            await load(runId);
          }}
        />
      )}
    </div>
  );
}
