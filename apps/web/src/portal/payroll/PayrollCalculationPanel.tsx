import { useCallback, useEffect, useState } from "react";
import type { PayrollCalculationProgressView, PayrollExceptionView, PayrollRunView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

const CLASS_LABELS: Record<PayrollExceptionView["exceptionClass"], string> = {
  calculation: "Could not calculate",
  data: "Missing data",
  duplicate_payment: "Already paid elsewhere",
  rule_change: "Rules changed",
  system: "System problem",
};

/** How many exceptions are listed before "Show all": a run with a hundred identical problems stays readable. */
const EXCEPTIONS_SHOWN = 10;

/** The distinct problems with how many employees each affects, largest first. */
function summarizeExceptions(items: PayrollExceptionView[]): Array<{ message: string; count: number }> {
  const counts = new Map<string, number>();
  for (const ex of items) counts.set(ex.message, (counts.get(ex.message) ?? 0) + 1);
  return [...counts.entries()].map(([message, count]) => ({ message, count })).sort((a, b) => b.count - a.count);
}

function describe(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Step 9D (PAY-06). Shows a background calculation while it runs (partitions done, progress, retries) and, once a
 * run has employees it could not calculate, the queue of those employees with what went wrong. An employee can be
 * retried on their own after the data is fixed, or knowingly left out with a written reason - everyone else's
 * payslip stays exactly as calculated.
 */
export function PayrollCalculationPanel({
  run,
  canPrepare,
  onRunChanged,
}: {
  run: PayrollRunView;
  canPrepare: boolean;
  onRunChanged: (updated: PayrollRunView) => void;
}) {
  const [progress, setProgress] = useState<PayrollCalculationProgressView | null>(null);
  const [exceptions, setExceptions] = useState<PayrollExceptionView[]>([]);
  const [showAllExceptions, setShowAllExceptions] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [waiveFor, setWaiveFor] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const calculating = run.status === "calculating";
  const interesting = calculating || run.failedCount > 0 || run.calculationMode === "async";
  const canResolve = canPrepare && (run.status === "calculated" || run.status === "validated");

  const load = useCallback(async () => {
    try {
      const [p, ex] = await Promise.all([api.getPayrollCalculationProgress(run.id), api.listPayrollExceptions(run.id, "open")]);
      setProgress(p);
      setExceptions(ex);
      if (calculating && p.status !== "calculating") onRunChanged(await api.getPayrollRun(run.id));
    } catch (err) {
      setError(describe(err, "Could not load the calculation status."));
    }
  }, [run.id, calculating, onRunChanged]);

  useEffect(() => {
    if (!interesting) return;
    void load();
    if (!calculating) return;
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [interesting, calculating, load, run.calculationSequence, run.failedCount]);

  if (!interesting) return null;

  async function retry(ex: PayrollExceptionView) {
    setBusyId(ex.id);
    setError(null);
    setNotice(null);
    try {
      const res = await api.retryPayrollException(run.id, ex.id);
      setNotice(res.resolved ? `${ex.employeeNumber ?? "Employee"} calculated.` : `Still failing: ${res.message}`);
      onRunChanged(await api.getPayrollRun(run.id));
      await load();
    } catch (err) {
      setError(describe(err, "Could not retry this employee."));
    } finally {
      setBusyId(null);
    }
  }

  async function waive(ex: PayrollExceptionView) {
    setBusyId(ex.id);
    setError(null);
    setNotice(null);
    try {
      await api.waivePayrollException(run.id, ex.id, note.trim());
      setWaiveFor(null);
      setNote("");
      onRunChanged(await api.getPayrollRun(run.id));
      await load();
    } catch (err) {
      setError(describe(err, "Could not leave this employee out."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="border-t border-black/10 px-4 py-3 space-y-3" aria-live="polite">
      {calculating && (
        <div>
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold">Calculating in the background…</span>
            <span className="text-label-tertiary">
              {progress ? `${progress.partitionsCompleted} of ${progress.partitionCount} batches` : ""}
              {progress && progress.attempts > 1 ? ` · attempt ${progress.attempts} of ${progress.maxAttempts}` : ""}
            </span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-black/10 overflow-hidden" role="progressbar" aria-valuenow={progress?.progressPercent ?? 0} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-accent transition-all" style={{ width: `${progress?.progressPercent ?? 0}%` }} />
          </div>
          {progress?.progressNote && <div className="mt-1 text-[11px] text-label-tertiary">{progress.progressNote}</div>}
          {progress?.lastError && <div className="mt-1 text-[11px] text-amber-800">Last attempt failed: {progress.lastError}</div>}
        </div>
      )}

      {!calculating && run.status === "draft" && progress?.lastError && (
        <div className="text-xs text-danger">The background calculation stopped: {progress.lastError}. Nothing was approved; fix the cause and calculate again.</div>
      )}

      {exceptions.length > 0 && (
        <div>
          <div className="text-xs font-semibold mb-1">
            {exceptions.length} employee{exceptions.length === 1 ? "" : "s"} need attention
          </div>
          {exceptions.length > EXCEPTIONS_SHOWN && (
            <ul className="mb-2 text-xs text-label-secondary space-y-0.5" data-testid="exception-summary">
              {summarizeExceptions(exceptions).map((g) => (
                <li key={g.message}>
                  <span className="font-semibold tabular-nums">{g.count}</span> × {g.message}
                </li>
              ))}
            </ul>
          )}
          <ul className="space-y-2">
            {(showAllExceptions ? exceptions : exceptions.slice(0, EXCEPTIONS_SHOWN)).map((ex) => (
              <li key={ex.id} className="text-xs rounded-lg border border-black/10 p-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="font-mono">{ex.employeeNumber ?? "Run"}</span>
                    {ex.employeeName ? <span className="text-label-secondary"> · {ex.employeeName}</span> : null}
                    <span className="ml-2 inline-block px-1.5 rounded bg-amber-100 text-amber-800">{CLASS_LABELS[ex.exceptionClass]}</span>
                    <div className="text-label-secondary mt-0.5">{ex.message}</div>
                    {ex.retryCount > 0 && <div className="text-label-tertiary">Retried {ex.retryCount} time{ex.retryCount === 1 ? "" : "s"}</div>}
                  </div>
                  {canResolve && ex.employeeId && (
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => retry(ex)} disabled={busyId === ex.id} className="font-semibold text-accent hover:underline disabled:opacity-50">
                        Retry
                      </button>
                      <button onClick={() => setWaiveFor(waiveFor === ex.id ? null : ex.id)} disabled={busyId === ex.id} className="text-label-secondary hover:underline disabled:opacity-50">
                        Leave out
                      </button>
                    </div>
                  )}
                </div>
                {waiveFor === ex.id && (
                  <div className="mt-2 flex gap-2">
                    <input
                      id={`waive-note-${ex.id}`}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Why is this employee left out of this run?"
                      className="flex-1 border border-black/10 rounded-lg px-2 py-1.5 text-xs bg-card"
                    />
                    <button
                      onClick={() => waive(ex)}
                      disabled={busyId === ex.id || note.trim().length < 5}
                      className="px-3 py-1.5 rounded-lg bg-accent text-white font-semibold disabled:opacity-50"
                    >
                      Confirm
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {exceptions.length > EXCEPTIONS_SHOWN && (
            <button type="button" onClick={() => setShowAllExceptions((v) => !v)} className="mt-2 text-xs font-semibold text-accent hover:underline">
              {showAllExceptions ? "Show fewer" : `Show all ${exceptions.length}`}
            </button>
          )}
        </div>
      )}

      {notice && <div className="text-xs text-label-secondary">{notice}</div>}
      {error && <div className="text-xs text-danger">{error}</div>}
    </div>
  );
}
