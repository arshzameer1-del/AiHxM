import { formatPeriod } from "../shared/dates";
import { useCallback, useEffect, useState } from "react";
import type { PayrollRetroResultView, PayrollRunView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

const pkr = new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", maximumFractionDigits: 0 });

function describe(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

const STATUS_STYLE: Record<PayrollRetroResultView["status"], string> = {
  detected: "bg-amber-100 text-amber-800",
  included: "bg-blue-100 text-blue-800",
  paid: "bg-green-100 text-green-800",
  dismissed: "bg-black/10 text-label-secondary",
  superseded: "bg-black/10 text-label-secondary",
};

/**
 * Step 9E (PAY-12). Differences in pay that earlier, already paid periods now need (a salary change back-dated into
 * them, unpaid leave decided afterwards). "Look for differences" compares what was paid with what those periods would
 * pay today; HR then includes the ones to pay in THIS run (they become arrears lines on the payslip, taxed this
 * period) or dismisses them with a reason. A line is paid once, when the run is finalised, and is given back if the
 * run is reversed or cancelled.
 */
export function PayrollRetroPanel({ run, canPrepare, onRunChanged }: { run: PayrollRunView; canPrepare: boolean; onRunChanged: (updated: PayrollRunView) => void }) {
  const [items, setItems] = useState<PayrollRetroResultView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dismissFor, setDismissFor] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const eligible = run.runType === "regular" && !run.isSimulation;
  const editable = canPrepare && eligible && ["draft", "pre_validated", "calculated", "validated"].includes(run.status);

  const load = useCallback(async () => {
    try {
      setItems(await api.listPayrollRetro(run.id));
    } catch (err) {
      setError(describe(err, "Could not load the arrears."));
    }
  }, [run.id]);

  useEffect(() => {
    if (eligible) void load();
  }, [eligible, load, run.status, run.calculationSequence]);

  if (!eligible) return null;
  const visible = items.filter((i) => i.status === "detected" || i.status === "included" || i.status === "paid");
  if (!editable && visible.length === 0) return null;

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      await load();
      onRunChanged(await api.getPayrollRun(run.id));
    } catch (err) {
      setError(describe(err, "That did not work."));
    } finally {
      setBusy(false);
    }
  }

  const detected = visible.filter((i) => i.status === "detected");
  const included = visible.filter((i) => i.status === "included");
  const includedTotal = included.reduce((a, i) => a + i.delta, 0);

  return (
    <div className="border-t border-black/10 px-4 py-3 space-y-2" aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold">Arrears and recoveries from earlier periods</div>
        {editable && (
          <div className="flex gap-3 text-xs">
            <button
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const res = await api.detectPayrollRetro(run.id, {});
                  setNotice(`${res.detected} new, ${res.superseded} cleared, ${res.unchanged} unchanged${res.failures?.length ? `, ${res.failures.length} could not be checked` : ""}.`);
                }, "")
              }
              className="font-semibold text-accent hover:underline disabled:opacity-50"
            >
              Look for differences
            </button>
            {detected.length > 0 && (
              <button disabled={busy} onClick={() => act(() => api.includePayrollRetro(run.id, {}), "All found differences are included in this run.")} className="font-semibold text-accent hover:underline disabled:opacity-50">
                Include all
              </button>
            )}
          </div>
        )}
      </div>

      {visible.length === 0 && <div className="text-xs text-label-tertiary">No differences found yet.</div>}

      {visible.length > 0 && (
        <ul className="space-y-1.5">
          {visible.map((i) => (
            <li key={i.id} className="text-xs rounded-lg border border-black/10 p-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="font-mono">{i.employeeNumber}</span>
                  {i.employeeName ? <span className="text-label-secondary"> · {i.employeeName}</span> : null}
                  <span className={`ml-2 inline-block px-1.5 rounded ${STATUS_STYLE[i.status]}`}>{i.status}</span>
                  <div className="text-label-secondary mt-0.5">
                    {i.componentLabel} · {formatPeriod(i.affectedPeriodStart, i.affectedPeriodEnd)}: paid {pkr.format(i.originalAmount)}, should be {pkr.format(i.recalculatedAmount)}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className={`font-mono font-semibold ${i.delta < 0 ? "text-danger" : ""}`}>{i.delta < 0 ? "−" : "+"}{pkr.format(Math.abs(i.delta))}</div>
                  {editable && i.status === "detected" && (
                    <div className="flex gap-2 justify-end mt-0.5">
                      <button disabled={busy} onClick={() => act(() => api.includePayrollRetro(run.id, { retroResultIds: [i.id] }), "Included in this run.")} className="font-semibold text-accent hover:underline disabled:opacity-50">
                        Include
                      </button>
                      <button disabled={busy} onClick={() => setDismissFor(dismissFor === i.id ? null : i.id)} className="text-label-secondary hover:underline disabled:opacity-50">
                        Dismiss
                      </button>
                    </div>
                  )}
                  {editable && i.status === "included" && (
                    <button disabled={busy} onClick={() => act(() => api.excludePayrollRetro(run.id, { retroResultIds: [i.id] }), "Taken out of this run.")} className="text-label-secondary hover:underline disabled:opacity-50">
                      Take out
                    </button>
                  )}
                </div>
              </div>
              {dismissFor === i.id && (
                <div className="mt-2 flex gap-2">
                  <input
                    id={`retro-dismiss-${i.id}`}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Why is this difference not paid?"
                    className="flex-1 border border-black/10 rounded-lg px-2 py-1.5 text-xs bg-card"
                  />
                  <button
                    disabled={busy || note.trim().length < 5}
                    onClick={() =>
                      act(async () => {
                        await api.dismissPayrollRetro(i.id, note.trim());
                        setDismissFor(null);
                        setNote("");
                      }, "Dismissed.")
                    }
                    className="px-3 py-1.5 rounded-lg bg-accent text-white font-semibold disabled:opacity-50"
                  >
                    Confirm
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {included.length > 0 && (
        <div className="text-xs text-label-secondary">
          {included.length} included in this run, {includedTotal < 0 ? "a net recovery of " : "net "}
          {pkr.format(Math.abs(includedTotal))}. {run.status === "calculated" || run.status === "validated" ? "Calculate the run again so the payslips include them." : "They are added when the run is calculated."}
        </div>
      )}
      {notice && <div className="text-xs text-label-secondary">{notice}</div>}
      {error && <div className="text-xs text-danger">{error}</div>}
    </div>
  );
}
