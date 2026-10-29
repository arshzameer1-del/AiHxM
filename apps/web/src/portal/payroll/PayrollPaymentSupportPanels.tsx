import { LoadingNote } from "../shared/PageChrome";
import { useEffect, useState } from "react";
import { BANK_FORMAT_TEMPLATES } from "./bankFormatTemplates";
import type { BankFileDelimiter, BankFileFormatView, DisbursementFieldKey, PayrollReconciliationKind, PayrollReconciliationView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { pkr } from "./payrollLabels";
import { formatDateTime } from "../shared/dates";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const FIELD_LABELS: Record<DisbursementFieldKey, string> = {
  employeeNumber: "Employee number",
  employeeName: "Employee name",
  cnic: "CNIC",
  paymentMethod: "Payment method",
  bankName: "Bank name",
  accountTitle: "Account title",
  accountNumber: "Account number",
  iban: "IBAN",
  branchCode: "Branch code",
  bankAccountNumber: "Bank account number (legacy)",
  netPay: "Net pay",
};
const FIELD_KEYS = Object.keys(FIELD_LABELS) as DisbursementFieldKey[];
const DELIMITERS: Array<{ value: BankFileDelimiter; label: string }> = [
  { value: "comma", label: "Comma" },
  { value: "semicolon", label: "Semicolon" },
  { value: "pipe", label: "Pipe" },
  { value: "tab", label: "Tab" },
];

type Draft = {
  id: string | null;
  code: string;
  name: string;
  delimiter: BankFileDelimiter;
  includeHeader: boolean;
  columns: DisbursementFieldKey[];
  headerLabels: Record<string, string>;
  fileExtension: string;
  isDefault: boolean;
  isActive: boolean;
};

const emptyDraft = (): Draft => ({ id: null, code: "", name: "", delimiter: "comma", includeHeader: true, columns: ["employeeNumber", "netPay"], headerLabels: {}, fileExtension: "csv", isDefault: false, isActive: true });

/**
 * PAY-16 - the payment-file layouts a tenant's banks need. No bank's specification is built in: the tenant picks the
 * delimiter, the columns, their order and their header names, and may keep several layouts (one is the default).
 */
export function BankFileFormatsPanel() {
  const [formats, setFormats] = useState<BankFileFormatView[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    api.listBankFileFormats(true).then(setFormats).catch((err) => setError(errorMessage(err, "Could not load the payment file layouts.")));
  }
  useEffect(load, []);

  function edit(f: BankFileFormatView) {
    setError(null);
    setDraft({ id: f.id, code: f.code, name: f.name, delimiter: f.delimiter, includeHeader: f.includeHeader, columns: f.columns, headerLabels: f.headerLabels, fileExtension: f.fileExtension, isDefault: f.isDefault, isActive: f.isActive });
  }

  function toggleColumn(key: DisbursementFieldKey) {
    setDraft((d) => (d ? { ...d, columns: d.columns.includes(key) ? d.columns.filter((c) => c !== key) : [...d.columns, key] } : d));
  }

  function move(key: DisbursementFieldKey, delta: -1 | 1) {
    setDraft((d) => {
      if (!d) return d;
      const i = d.columns.indexOf(key);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= d.columns.length) return d;
      const next = d.columns.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return { ...d, columns: next };
    });
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    const labels = Object.fromEntries(Object.entries(draft.headerLabels).filter(([k, v]) => draft.columns.includes(k as DisbursementFieldKey) && v.trim()));
    try {
      if (draft.id) {
        await api.updateBankFileFormat(draft.id, { name: draft.name, delimiter: draft.delimiter, includeHeader: draft.includeHeader, columns: draft.columns, headerLabels: labels, fileExtension: draft.fileExtension, isDefault: draft.isDefault, isActive: draft.isActive });
      } else {
        await api.createBankFileFormat({ code: draft.code, name: draft.name, delimiter: draft.delimiter, includeHeader: draft.includeHeader, columns: draft.columns, headerLabels: labels, fileExtension: draft.fileExtension, isDefault: draft.isDefault, isActive: draft.isActive });
      }
      setDraft(null);
      load();
    } catch (err) {
      setError(errorMessage(err, "Could not save this layout."));
    } finally {
      setBusy(false);
    }
  }

  if (!formats) return error ? <p className="text-xs text-danger">{error}</p> : <LoadingNote />;

  return (
    <div className="space-y-3">
      <p className="text-xs text-label-tertiary">
        Define the file your bank expects: separator, header row and the columns in order. The default layout is used
        when a payment file is generated without choosing one.
      </p>
      {formats.length === 0 && !draft && <p className="text-xs text-label-tertiary">No layouts yet - payment files use the column settings above.</p>}
      <div className="bg-black/5 rounded-lg divide-y divide-black/10">
        {formats.map((f) => (
          <div key={f.id} className="flex items-center justify-between px-3 py-2 text-sm">
            <div>
              <span className="font-medium">{f.name}</span> <span className="font-mono text-xs text-label-tertiary">{f.code}.{f.fileExtension}</span>
              {f.isDefault && <span className="ml-2 text-xs font-semibold text-accent">Default</span>}
              {!f.isActive && <span className="ml-2 text-xs text-label-tertiary">Inactive</span>}
              <div className="text-xs text-label-tertiary">{f.columns.map((c) => f.headerLabels[c] ?? FIELD_LABELS[c]).join(" · ")}</div>
            </div>
            <button onClick={() => edit(f)} className="text-xs font-semibold text-accent hover:underline">Edit</button>
          </div>
        ))}
      </div>
      {!draft && (
        <div className="flex flex-wrap items-end gap-3">
          <button onClick={() => { setError(null); setDraft(emptyDraft()); }} className="text-sm font-semibold rounded-lg px-4 py-2 text-white bg-accent">
            Add a layout
          </button>
          <label className="text-xs">Or start from a template
            <select
              id="bank-format-template"
              value=""
              onChange={(e) => {
                const t = BANK_FORMAT_TEMPLATES.find((x) => x.key === e.target.value);
                if (!t) return;
                setError(null);
                setDraft({ id: null, code: t.code, name: t.name, delimiter: t.delimiter, includeHeader: t.includeHeader, columns: t.columns, headerLabels: Object.fromEntries(Object.entries(t.headerLabels)) as Record<string, string>, fileExtension: t.fileExtension, isDefault: false, isActive: true });
              }}
              className="mt-1 block rounded-lg border border-black/10 px-2 py-2 text-sm"
            >
              <option value="">Choose…</option>
              {BANK_FORMAT_TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
            </select>
          </label>
          <p className="text-[11px] text-label-tertiary basis-full">Templates are generic starting points, not any bank's own specification. Compare the result with the sample your bank gave you before sending a real file.</p>
        </div>
      )}
      {draft && (
        <div className="space-y-3 border border-black/10 rounded-lg p-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="text-xs">Name
              <input id="bank-format-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="mt-1 w-full rounded-lg border border-black/10 px-2 py-1 text-sm" />
            </label>
            <label className="text-xs">Code
              <input id="bank-format-code" value={draft.code} disabled={draft.id !== null} onChange={(e) => setDraft({ ...draft, code: e.target.value })} placeholder="lower_case_code" className="mt-1 w-full rounded-lg border border-black/10 px-2 py-1 text-sm font-mono disabled:opacity-60" />
            </label>
            <label className="text-xs">Separator
              <select id="bank-format-delimiter" value={draft.delimiter} onChange={(e) => setDraft({ ...draft, delimiter: e.target.value as BankFileDelimiter })} className="mt-1 w-full rounded-lg border border-black/10 px-2 py-1 text-sm">
                {DELIMITERS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
            </label>
            <label className="text-xs">File extension
              <input id="bank-format-ext" value={draft.fileExtension} onChange={(e) => setDraft({ ...draft, fileExtension: e.target.value.toLowerCase() })} className="mt-1 w-full rounded-lg border border-black/10 px-2 py-1 text-sm font-mono" />
            </label>
          </div>
          <div className="flex items-center gap-4 text-sm flex-wrap">
            <label className="flex items-center gap-2"><input type="checkbox" checked={draft.includeHeader} onChange={(e) => setDraft({ ...draft, includeHeader: e.target.checked })} /> Header row</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={draft.isDefault} onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })} /> Default layout</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} /> Active</label>
          </div>
          <div className="bg-black/5 rounded-lg divide-y divide-black/10">
            {FIELD_KEYS.map((key) => {
              const pos = draft.columns.indexOf(key);
              return (
                <div key={key} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <label className="flex items-center gap-2"><input type="checkbox" checked={pos >= 0} onChange={() => toggleColumn(key)} /> {FIELD_LABELS[key]}</label>
                  {pos >= 0 && (
                    <div className="flex items-center gap-2">
                      {draft.includeHeader && (
                        <input aria-label={`Header name for ${FIELD_LABELS[key]}`} placeholder="Header name" value={draft.headerLabels[key] ?? ""} onChange={(e) => setDraft({ ...draft, headerLabels: { ...draft.headerLabels, [key]: e.target.value } })} className="w-36 rounded border border-black/10 px-2 py-0.5 text-xs" />
                      )}
                      <span className="text-xs text-label-tertiary font-mono">{pos + 1}</span>
                      <button type="button" disabled={pos === 0} onClick={() => move(key, -1)} aria-label={`Move ${FIELD_LABELS[key]} earlier`} className="text-xs disabled:opacity-30">↑</button>
                      <button type="button" disabled={pos === draft.columns.length - 1} onClick={() => move(key, 1)} aria-label={`Move ${FIELD_LABELS[key]} later`} className="text-xs disabled:opacity-30">↓</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex items-center gap-3">
            <button onClick={save} disabled={busy || !draft.name.trim() || draft.columns.length === 0 || (!draft.id && !draft.code.trim())} className="text-sm font-semibold rounded-lg px-4 py-2 text-white bg-accent disabled:opacity-50">Save layout</button>
            <button onClick={() => { setDraft(null); setError(null); }} className="text-sm text-label-tertiary">Cancel</button>
          </div>
        </div>
      )}
      {!draft && error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

const KIND_LABELS: Record<PayrollReconciliationKind, string> = {
  calculation: "Calculation",
  payroll: "Payroll totals",
  tax: "Tax",
  payment: "Payments",
  bank: "Bank",
  accounting: "Accounting",
  costing: "Costing",
  reversal: "Reversal",
};
const STATUS_STYLE: Record<string, string> = {
  matched: "bg-success/15 text-green-700",
  variance: "bg-danger/15 text-red-700",
  pending: "bg-black/10 text-label-secondary",
  resolved: "bg-accent/15 text-accent",
};

/** PAY-18 - run the reconciliations of a payroll run, see each result with its differences, and resolve a variance with a note. */
export function ReconciliationPanel({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<PayrollReconciliationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const [note, setNote] = useState("");

  function load() {
    api.listPayrollReconciliations(runId).then(setRows).catch((err) => setError(errorMessage(err, "Could not load the reconciliations.")));
  }

  async function runAll() {
    setBusy(true);
    setError(null);
    try {
      await api.runPayrollReconciliations(runId);
      load();
    } catch (err) {
      setError(errorMessage(err, "Could not run the reconciliations."));
    } finally {
      setBusy(false);
    }
  }

  async function resolve(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.resolvePayrollReconciliation(id, note.trim());
      setResolving(null);
      setNote("");
      load();
    } catch (err) {
      setError(errorMessage(err, "Could not resolve this variance."));
    } finally {
      setBusy(false);
    }
  }

  // newest result of each kind
  const latest = rows ? Object.values(Object.fromEntries(rows.map((r) => [r.kind, rows.filter((x) => x.kind === r.kind).sort((a, b) => b.sequence - a.sequence)[0]]))) : [];

  return (
    <div className="mt-2 pt-2 border-t border-black/5 text-xs">
      <button
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next && !rows) load();
        }}
        className="font-semibold text-label-tertiary hover:text-label-primary"
      >
        {open ? "Hide reconciliations" : "Reconciliations"}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <button onClick={runAll} disabled={busy} className="font-semibold rounded-lg px-3 py-1.5 text-white bg-accent disabled:opacity-50">
            Run reconciliations
          </button>
          {error && <p className="text-danger">{error}</p>}
          {!rows ? (
            <p className="text-label-tertiary">Loading…</p>
          ) : latest.length === 0 ? (
            <p className="text-label-tertiary">Not run yet.</p>
          ) : (
            <div className="bg-black/5 rounded-lg divide-y divide-black/10">
              {latest.map((r) => (
                <div key={r.id} className="px-3 py-2 space-y-1">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div>
                      <span className="font-medium">{KIND_LABELS[r.kind]}</span>{" "}
                      <span className={`inline-block px-2 py-0.5 rounded-full font-semibold ${STATUS_STYLE[r.status]}`}>{r.status}</span>
                      <span className="text-label-tertiary"> · run {r.sequence} · {formatDateTime(r.runAt)}</span>
                    </div>
                    <div className="tabular-nums text-label-secondary">
                      expected {pkr.format(r.expectedAmount)} · actual {pkr.format(r.actualAmount)}
                      {r.variance !== 0 && <span className="text-danger"> · difference {pkr.format(r.variance)}</span>}
                    </div>
                  </div>
                  {typeof r.detail.note === "string" && <p className="text-label-tertiary">{r.detail.note}</p>}
                  {Array.isArray(r.detail.differences) && r.detail.differences.length > 0 && (
                    <ul className="list-disc pl-4 text-label-tertiary">
                      {(r.detail.differences as Array<Record<string, unknown>>).slice(0, 8).map((d, i) => (
                        <li key={i}>{Object.entries(d).map(([k, v]) => `${k}: ${String(v)}`).join(", ")}</li>
                      ))}
                      {r.detail.differences.length > 8 && <li>… and {r.detail.differences.length - 8} more</li>}
                    </ul>
                  )}
                  {r.status === "resolved" && <p className="text-label-tertiary">Resolved: {r.resolutionNote}</p>}
                  {r.status === "variance" && resolving !== r.id && (
                    <button onClick={() => { setResolving(r.id); setNote(""); }} className="font-semibold text-accent hover:underline">Resolve with a note</button>
                  )}
                  {resolving === r.id && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <input aria-label="Resolution note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why the difference is accepted" className="flex-1 min-w-48 rounded-lg border border-black/10 px-2 py-1" />
                      <button onClick={() => resolve(r.id)} disabled={busy || note.trim().length < 3} className="font-semibold rounded-lg px-3 py-1 text-white bg-accent disabled:opacity-50">Resolve</button>
                      <button onClick={() => setResolving(null)} className="text-label-tertiary">Cancel</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
