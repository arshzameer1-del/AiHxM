import { LoadingNote } from "../shared/PageChrome";
import { useEffect, useRef, useState } from "react";
import type { PayrollDashboardRunView, PayrollDashboardView, PayrollEventCatalogEntry, PayrollInputBatchView, PayrollInputImportType, PayrollInputRowView, PayrollInputTemplateView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { Field, Notice, Pill, buttonClass, errorMessage, inputClass, quietButtonClass } from "./PayrollPanelKit";
import { RUN_STATUS_LABELS, pkr } from "./payrollLabels";

function eta(seconds: number | null): string {
  if (seconds === null) return "";
  if (seconds < 90) return `about ${seconds}s left`;
  return `about ${Math.round(seconds / 60)} min left`;
}

function RunRow({ r }: { r: PayrollDashboardRunView }) {
  return (
    <div className="bg-black/5 rounded-lg px-3 py-2 text-sm space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{r.periodStart} to {r.periodEnd}{r.runType !== "regular" ? ` · ${r.runType.replace("_", " ")}` : ""}</span>
        <span className="flex gap-1">
          <Pill tone="accent">{RUN_STATUS_LABELS[r.status] ?? r.status}</Pill>
          {r.paymentStatus && <Pill tone="neutral">payment {r.paymentStatus}</Pill>}
          {r.postingStatus && <Pill tone={r.postingStatus === "posted" ? "good" : "warn"}>journal {r.postingStatus}</Pill>}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-black/10 overflow-hidden" role="progressbar" aria-valuenow={r.progressPercent} aria-valuemin={0} aria-valuemax={100} aria-label="Calculation progress">
        <div className="h-full bg-accent" style={{ width: `${r.progressPercent}%` }} />
      </div>
      <div className="text-xs text-label-tertiary flex flex-wrap gap-x-4">
        <span>{r.calculatedCount}/{r.populationCount} calculated{r.failedCount ? ` · ${r.failedCount} failed` : ""}</span>
        {r.partitions.total > 0 && <span>{r.partitions.total} partitions ({Object.entries(r.partitions.byState).map(([k, v]) => `${v} ${k}`).join(", ")})</span>}
        {r.throughputPerMinute !== null && <span>{r.throughputPerMinute}/min</span>}
        {r.estimatedSecondsRemaining !== null && <span>{eta(r.estimatedSecondsRemaining)}</span>}
        {r.openExceptions > 0 && <span className="text-amber-800">{r.openExceptions} open exception(s)</span>}
        {r.totalNet !== null && <span>Net {pkr.format(r.totalNet)}</span>}
        {r.totalEmployerCost !== null && <span>Employer cost {pkr.format(r.totalEmployerCost)}</span>}
      </div>
    </div>
  );
}

/** PAY-25 - where every run stands, and what needs someone's attention. */
export function PayrollDashboardPanel() {
  const [d, setD] = useState<PayrollDashboardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const pull = () => api.getPayrollDashboard().then((v) => alive && setD(v)).catch((e) => alive && setError(errorMessage(e, "Could not load the dashboard.")));
    void pull();
    const t = setInterval(pull, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (error) return <p className="text-xs text-danger">{error}</p>;
  if (!d) return <LoadingNote />;
  return (
    <div className="space-y-4">
      {d.attention.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-1" role="status">
          <div className="text-sm font-semibold text-amber-900">Needs attention</div>
          {d.attention.map((a, i) => <p key={i} className="text-xs text-amber-900">{a.message}</p>)}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {Object.entries(d.runsByStatus).map(([k, v]) => <Pill key={k} tone="neutral">{RUN_STATUS_LABELS[k as keyof typeof RUN_STATUS_LABELS] ?? k}: {v}</Pill>)}
      </div>
      <div>
        <h3 className="text-sm font-semibold mb-2">In progress</h3>
        {d.active.length === 0 ? <p className="text-sm text-label-tertiary">No run is in progress.</p> : <div className="space-y-2">{d.active.map((r) => <RunRow key={r.runId} r={r} />)}</div>}
      </div>
      <div>
        <h3 className="text-sm font-semibold mb-2">Recently finished</h3>
        {d.recent.length === 0 ? <p className="text-sm text-label-tertiary">Nothing finished recently.</p> : <div className="space-y-2">{d.recent.map((r) => <RunRow key={r.runId} r={r} />)}</div>}
      </div>
    </div>
  );
}

/** PAY-27 - the versioned events payroll publishes, for integration owners. No individual's pay is ever in one. */
export function PayrollEventCatalogPanel() {
  const [rows, setRows] = useState<PayrollEventCatalogEntry[] | null>(null);
  useEffect(() => {
    api.getPayrollEventCatalog().then(setRows).catch(() => setRows([]));
  }, []);
  if (!rows) return <LoadingNote />;
  return (
    <div className="space-y-3">
      <p className="text-xs text-label-tertiary">Subscribe to these through webhooks or the event feed. Payloads carry identifiers and run totals only, never an individual's pay.</p>
      {rows.map((e) => (
        <div key={e.eventType} className="bg-black/5 rounded-lg p-3 text-sm">
          <div className="flex items-center justify-between"><span className="font-mono text-xs">{e.eventType}</span><Pill tone="neutral">v{e.schemaVersion}</Pill></div>
          <p className="text-xs text-label-secondary mt-1">{e.description}</p>
          <p className="text-xs text-label-tertiary mt-1 font-mono">{e.fields.join(", ")}</p>
        </div>
      ))}
    </div>
  );
}

const IMPORT_LABEL: Record<PayrollInputImportType, string> = { payroll_components: "Recurring pay components", payroll_payments: "One-time earnings and deductions" };
const BATCH_TONE = (s: string): "good" | "warn" | "bad" | "neutral" | "accent" =>
  s === "completed" ? "good" : s === "completed_with_errors" ? "warn" : s === "failed" || s === "cancelled" ? "bad" : s === "running" || s === "queued" ? "accent" : "neutral";

/** PAY-26 - bulk pay inputs from a CSV: check every row first, then apply the valid ones in the background. */
export function PayrollInputImportPanel() {
  const [templates, setTemplates] = useState<PayrollInputTemplateView[]>([]);
  const [batches, setBatches] = useState<PayrollInputBatchView[]>([]);
  const [type, setType] = useState<PayrollInputImportType>("payroll_components");
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | undefined>();
  const [allowPartial, setAllowPartial] = useState(false);
  const [current, setCurrent] = useState<PayrollInputBatchView | null>(null);
  const [rows, setRows] = useState<PayrollInputRowView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadBatches = () => api.listPayrollInputImports().then(setBatches).catch(() => undefined);
  useEffect(() => {
    api.listPayrollInputTemplates().then(setTemplates).catch(() => undefined);
    void loadBatches();
  }, []);
  // follow a running batch
  useEffect(() => {
    if (!current || !["queued", "running"].includes(current.status)) return;
    const t = setInterval(async () => {
      try {
        const b = await api.getPayrollInputImport(current.id);
        setCurrent(b);
        if (!["queued", "running"].includes(b.status)) {
          void loadBatches();
          setRows(await api.listPayrollInputImportRows(b.id));
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [current]);

  const template = templates.find((t) => t.importType === type);

  async function act(label: string, fn: () => Promise<PayrollInputBatchView>) {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const b = await fn();
      setCurrent(b);
      setRows(await api.listPayrollInputImportRows(b.id));
      setSaved(label);
      void loadBatches();
    } catch (e) {
      setError(errorMessage(e, "That did not work."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <Notice error={error} saved={saved} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="What are you importing?">
          <select id="input-import-type" className={inputClass} value={type} onChange={(e) => setType(e.target.value as PayrollInputImportType)}>
            {(Object.keys(IMPORT_LABEL) as PayrollInputImportType[]).map((k) => <option key={k} value={k}>{IMPORT_LABEL[k]}</option>)}
          </select>
        </Field>
        <Field label="CSV file">
          <input
            id="input-import-file"
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="text-sm"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setFileName(f.name);
              setCsv(await f.text());
            }}
          />
        </Field>
      </div>
      {template && (
        <div className="text-xs text-label-tertiary space-y-1">
          <div>Columns: {template.columns.map((c) => `${c.name}${c.required ? "*" : ""}`).join(", ")} (* required)</div>
          <button type="button" className="text-accent" onClick={() => setCsv(template.example)}>Use the example</button>
        </div>
      )}
      <Field label="CSV">
        <textarea id="input-import-csv" className={`${inputClass} font-mono h-36`} value={csv} onChange={(e) => setCsv(e.target.value)} spellCheck={false} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input id="input-import-partial" type="checkbox" checked={allowPartial} onChange={(e) => setAllowPartial(e.target.checked)} />
        Apply the valid rows even if some rows are invalid
      </label>
      <button type="button" className={buttonClass} disabled={busy || !csv.trim()} onClick={() => act("Rows checked. Nothing has been applied yet.", () => api.dryRunPayrollInputImport({ importType: type, csv, fileName, allowPartial }))}>
        Check rows
      </button>

      {current && (
        <div className="bg-black/5 rounded-lg p-3 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-medium">{current.fileName ?? "Pasted CSV"} · {IMPORT_LABEL[current.importType]}</span>
            <Pill tone={BATCH_TONE(current.status)}>{current.status.replace(/_/g, " ")}</Pill>
          </div>
          <div className="text-xs text-label-secondary">
            {current.totalRows} rows · {current.validRows} valid · {current.invalidRows} invalid
            {current.importedRows > 0 || current.failedRows > 0 ? ` · ${current.importedRows} applied · ${current.failedRows} failed` : ""}
          </div>
          {current.lastError && <p className="text-xs text-danger">{current.lastError}</p>}
          <div className="flex flex-wrap gap-2">
            {current.status === "dry_run_complete" && (
              <button type="button" className={buttonClass} disabled={busy || current.validRows === 0 || (current.invalidRows > 0 && !current.allowPartial)} onClick={() => act("Import queued.", () => api.executePayrollInputImport(current.id))}>
                Apply {current.validRows} valid row(s)
              </button>
            )}
            {current.failedRows > 0 && ["completed_with_errors", "failed"].includes(current.status) && (
              <button type="button" className={quietButtonClass} disabled={busy} onClick={() => act("Retrying the failed rows.", () => api.retryPayrollInputImport(current.id))}>Retry failed rows</button>
            )}
            {["dry_run_complete", "queued", "running"].includes(current.status) && (
              <button type="button" className={quietButtonClass} disabled={busy} onClick={() => act("Import cancelled.", () => api.cancelPayrollInputImport(current.id))}>Cancel</button>
            )}
            {(current.invalidRows > 0 || current.failedRows > 0) && (
              <button type="button" className={quietButtonClass} onClick={() => api.downloadPayrollText(`/payroll/input-imports/${current.id}/error-report`, "payroll-input-errors.csv").catch((e) => setError(errorMessage(e, "Could not download the error report.")))}>Download error report</button>
            )}
          </div>
          {current.invalidRows > 0 && current.status === "dry_run_complete" && !current.allowPartial && <p className="text-xs text-amber-800">Fix the invalid rows and check again, or tick "apply the valid rows" above.</p>}
          {rows.filter((r) => r.status === "invalid" || r.status === "failed").length > 0 && (
            <ul className="text-xs space-y-1">
              {rows.filter((r) => r.status === "invalid" || r.status === "failed").slice(0, 20).map((r) => (
                <li key={r.rowNumber} className="text-red-700">Row {r.rowNumber}: {r.errors.map((e) => e.message).join("; ")}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {batches.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Earlier imports</h3>
          <ul className="divide-y divide-black/5 text-sm">
            {batches.slice(0, 10).map((b) => (
              <li key={b.id} className="py-1.5 flex items-center justify-between gap-2">
                <button type="button" className="text-left" onClick={async () => { setCurrent(b); setRows(await api.listPayrollInputImportRows(b.id)); }}>
                  {b.fileName ?? "Pasted CSV"} <span className="text-xs text-label-tertiary">· {IMPORT_LABEL[b.importType]} · {b.createdAt.slice(0, 10)}</span>
                </button>
                <Pill tone={BATCH_TONE(b.status)}>{b.status.replace(/_/g, " ")}</Pill>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
