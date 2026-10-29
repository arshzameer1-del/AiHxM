import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { SmartCheckFinding, SmartCheckReport } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { formatDateTime } from "../shared/dates";

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const field = "w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-accent";

type Dismissed = Awaited<ReturnType<typeof api.listDismissedSmartChecks>>;

function Finding({ f, onDismiss }: { f: SmartCheckFinding; onDismiss: (ruleKey: string, subjectKey: string, reason: string) => Promise<void> }) {
  const [open, setOpen] = useState(f.severity === "high" && f.count > 0);
  const [target, setTarget] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!target) return;
    setBusy(true);
    setErr(null);
    try {
      await onDismiss(f.ruleKey, target, reason);
      setTarget(null);
      setReason("");
    } catch (x) {
      setErr(errText(x, "Could not save."));
    } finally {
      setBusy(false);
    }
  }

  const tone = f.count === 0 ? "bg-green-100 text-green-700" : f.severity === "high" ? "bg-danger/15 text-red-700" : "bg-amber-100 text-amber-800";
  return (
    <section className="bg-card rounded-card shadow-sm p-4" aria-label={f.title}>
      <button className="w-full flex items-start justify-between gap-3 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span>
          <span className="block font-medium text-sm">{f.title}</span>
          <span className="block text-xs text-label-tertiary mt-0.5">{f.why}</span>
        </span>
        <span className={`shrink-0 px-2.5 py-0.5 rounded-full text-xs font-semibold tabular-nums ${tone}`}>
          {f.count === 0 ? "Clear" : `${f.count} to look at`}
        </span>
      </button>
      {open && f.count > 0 && (
        <ul className="mt-3 divide-y divide-black/5">
          {f.samples.map((s) => (
            <li key={s.subjectKey} className="py-2 flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="text-sm">{s.label}</div>
                <div className="text-xs text-label-secondary">{s.detail}</div>
              </div>
              <span className="flex items-center gap-3 shrink-0 text-xs font-semibold">
                {f.link && s.employeeId && <Link className="text-accent hover:underline" to={`/app/employees/${s.employeeId}`}>Open</Link>}
                <button className="text-label-tertiary hover:text-accent" onClick={() => { setTarget(s.subjectKey); setReason(""); }}>Looked, it's fine</button>
              </span>
              {target === s.subjectKey && (
                <form onSubmit={submit} className="basis-full flex gap-2 items-end" aria-label="Mark as reviewed">
                  <div className="flex-1">
                    <label htmlFor={`why-${s.subjectKey}`} className="block text-xs font-medium text-label-secondary mb-1">Why is it fine?</label>
                    <input id={`why-${s.subjectKey}`} required minLength={3} maxLength={500} className={field} value={reason} onChange={(e) => setReason(e.target.value)} />
                  </div>
                  <button type="submit" disabled={busy} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">Save</button>
                  <button type="button" onClick={() => setTarget(null)} className="text-xs font-medium text-label-secondary">Cancel</button>
                </form>
              )}
            </li>
          ))}
          {f.count > f.samples.length && <li className="py-2 text-xs text-label-tertiary">Showing the first {f.samples.length} of {f.count}.</li>}
        </ul>
      )}
      {err && <p className="text-xs text-danger mt-2" role="alert">{err}</p>}
      {f.dismissedCount > 0 && <p className="text-xs text-label-tertiary mt-2">{f.dismissedCount} marked as fine.</p>}
    </section>
  );
}

/** Rule-based scans of HR and payroll data. Not a prediction: each finding says which rule matched and why it deserves a look. */
export function SmartChecksPage() {
  const [report, setReport] = useState<SmartCheckReport | null>(null);
  const [dismissed, setDismissed] = useState<Dismissed>([]);
  const [error, setError] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, d] = await Promise.all([api.runSmartChecks(), api.listDismissedSmartChecks()]);
      setReport(r);
      setDismissed(d);
      setError(null);
    } catch (e) {
      setError(errText(e, "Could not run the checks."));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function dismiss(ruleKey: string, subjectKey: string, reason: string) {
    await api.dismissSmartCheck({ ruleKey, subjectKey, reason });
    await load();
  }
  async function restore(id: string) {
    try { await api.restoreSmartCheck(id); await load(); } catch (e) { setError(errText(e, "Could not restore.")); }
  }

  if (error && !report) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!report) return <LoadingNote />;
  return (
    <div className="space-y-4">
      <PageHeader
        title="Smart Checks"
        subtitle="Plain rules run over your HR and payroll data to surface things worth a second look. Nothing is changed for you."
        actions={<button onClick={() => void load()} className="rounded-lg px-3 py-1.5 text-sm font-semibold bg-accent text-white">Run again</button>}
      />
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      <p className="text-sm" role="status">
        {report.totalOpen === 0 ? "Nothing to look at right now." : (
          <><span className="font-semibold tabular-nums">{report.totalOpen}</span> to look at — {report.high} high priority, {report.medium} medium.</>
        )}{" "}
        <span className="text-label-tertiary">Checked {formatDateTime(report.ranAt)}.</span>
      </p>
      <div className="space-y-3">
        {report.findings.map((f) => <Finding key={f.ruleKey} f={f} onDismiss={dismiss} />)}
      </div>
      {dismissed.length > 0 && (
        <div>
          <button className="text-xs font-semibold text-accent" onClick={() => setShowDismissed((s) => !s)}>
            {showDismissed ? "Hide" : "Show"} findings marked as fine ({dismissed.length})
          </button>
          {showDismissed && (
            <ul className="mt-2 divide-y divide-black/5 bg-card rounded-card shadow-sm px-4">
              {dismissed.map((d) => (
                <li key={d.id} className="py-2 flex items-start justify-between gap-3 text-sm">
                  <span><span className="font-medium">{d.ruleTitle}</span><span className="block text-xs text-label-secondary">{d.reason} · {formatDateTime(d.dismissedAt)}</span></span>
                  <button className="text-xs font-semibold text-accent shrink-0" onClick={() => void restore(d.id)}>Check again</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
