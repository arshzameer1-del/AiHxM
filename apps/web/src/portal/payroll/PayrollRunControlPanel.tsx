import { useCallback, useEffect, useState } from "react";
import type {
  PayrollOverridableField,
  PayrollOverrideView,
  PayrollRunEventView,
  PayrollRunPopulationView,
  PayrollRunValidationView,
  PayrollRunView,
  PayslipView,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { RUN_STATUS_LABELS, isPostFinalRunStatus, pkr } from "./payrollLabels";
import { formatDateTime } from "../shared/dates";
import { PayrollVariancePanel } from "./PayrollVariancePanel";

const OVERRIDE_FIELD_LABELS: Record<PayrollOverridableField, string> = {
  incomeTaxMonthly: "Income tax (monthly)",
  eobiEmployeeContribution: "EOBI — employee share",
  eobiEmployerContribution: "EOBI — employer share",
  socialSecurityEmployerContribution: "Social security — employer share",
};

const SEVERITY_STYLES = {
  error: "bg-danger/15 text-red-700",
  warning: "bg-amber-100 text-amber-800",
  info: "bg-black/5 text-label-secondary",
} as const;

const ACTION_LABELS: Record<string, string> = {
  create: "Created",
  backfill: "Recorded",
  calculate: "Calculated",
  pre_validate: "Pre-validated",
  validate: "Validated",
  submit: "Submitted for approval",
  approve: "Approved",
  reject: "Rejected",
  decide_step: "Approval step decided",
  finalize: "Finalized",
  close: "Closed",
  reopen: "Reopened",
  cancel: "Cancelled",
  reverse: "Reversed",
  override: "Value overridden",
  calculate_start: "Background calculation started",
  calculate_failed: "Background calculation failed",
  approval_invalidated: "Approval withdrawn by recalculation",
  retry_employee: "Employee recalculated",
};

function describe(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Step 9A (PAY-01, PAY-02, PAY-19, PAY-23). Everything an HR preparer needs to
 * steer one payroll run through its lifecycle beyond calculate/approve/finalize:
 * pre-validation and validation findings, close / reopen / cancel with a reason,
 * manual overrides on a calculated payslip, and the append-only timeline.
 * The buttons only mirror the server's own checks — the API enforces the rules.
 */
export function PayrollRunControlPanel({
  run,
  canPrepare,
  onRunChanged,
}: {
  run: PayrollRunView;
  canPrepare: boolean;
  onRunChanged: (updated: PayrollRunView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<PayrollRunEventView[] | null>(null);
  const [overrides, setOverrides] = useState<PayrollOverrideView[]>([]);
  const [payslips, setPayslips] = useState<PayslipView[]>([]);
  const [population, setPopulation] = useState<PayrollRunPopulationView[]>([]);
  const [findings, setFindings] = useState<PayrollRunValidationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<"reopen" | "cancel" | null>(null);
  const [reason, setReason] = useState("");
  const [noticeResult, setNoticeResult] = useState<string | null>(null);
  const [ovEmployee, setOvEmployee] = useState("");
  const [ovField, setOvField] = useState<PayrollOverridableField>("incomeTaxMonthly");
  const [ovValue, setOvValue] = useState("");
  const [ovReason, setOvReason] = useState("");

  const canOverride = canPrepare && !run.isSimulation && (run.status === "calculated" || run.status === "validated");
  const canPreValidate = canPrepare && (run.status === "draft" || run.status === "pre_validated");
  const canValidate = canPrepare && (run.status === "calculated" || run.status === "validated");
  const canClose = canPrepare && run.status === "finalized";
  const canNotify = canPrepare && !run.isSimulation && isPostFinalRunStatus(run.status);
  const canReopen = canPrepare && run.status === "closed";
  const canCancel = canPrepare && !isPostFinalRunStatus(run.status) && run.status !== "cancelled" && run.status !== "reversed" && run.status !== "calculating";

  const refresh = useCallback(async () => {
    try {
      const [ev, ov, slips, pop] = await Promise.all([
        api.listPayrollRunEvents(run.id),
        api.listPayrollOverrides(run.id).catch(() => [] as PayrollOverrideView[]),
        run.status === "draft" ? Promise.resolve([] as PayslipView[]) : api.listPayslips({ payrollRunId: run.id }),
        api.listPayrollRunPopulation(run.id).catch(() => [] as PayrollRunPopulationView[]),
      ]);
      setPopulation(pop);
      setEvents(ev);
      setOverrides(ov);
      setPayslips(slips);
    } catch (err) {
      setError(describe(err, "Could not load this run's history."));
    }
  }, [run.id, run.status]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh, run.calculationSequence]);

  async function act(fn: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(describe(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  const runValidation = (stage: "pre" | "post") =>
    act(async () => {
      const res = await (stage === "pre" ? api.preValidatePayrollRun(run.id) : api.validatePayrollRun(run.id));
      setFindings(res);
      onRunChanged(res.run);
      setOpen(true);
    }, "Could not validate this run.");

  const submitReason = () =>
    act(async () => {
      if (!reasonFor) return;
      const updated =
        reasonFor === "reopen"
          ? await api.reopenPayrollRun(run.id, { reason: reason.trim() })
          : await api.cancelPayrollRun(run.id, { reason: reason.trim() });
      setReasonFor(null);
      setReason("");
      onRunChanged(updated);
      await refresh();
    }, reasonFor === "reopen" ? "Could not reopen this run." : "Could not cancel this run.");

  const addOverride = () =>
    act(async () => {
      await api.applyPayrollOverride(run.id, {
        employeeId: ovEmployee,
        field: ovField,
        value: Number(ovValue),
        reason: ovReason.trim(),
      });
      setOvValue("");
      setOvReason("");
      await refresh();
      const updated = await api.getPayrollRun(run.id);
      onRunChanged(updated);
    }, "Could not apply this override.");

  const withdraw = (id: string) =>
    act(async () => {
      await api.withdrawPayrollOverride(run.id, id);
      await refresh();
      onRunChanged(await api.getPayrollRun(run.id));
    }, "Could not withdraw this override.");

  const nameOf = (employeeId: string) => {
    const s = payslips.find((p) => p.employeeId === employeeId);
    return s ? s.employeeNumber : employeeId.slice(0, 8);
  };

  const t = run.totals;
  const hasActions = canPreValidate || canValidate || canClose || canReopen || canCancel;

  return (
    <div className="mt-3 border-t border-black/5 pt-3">
      <div className="flex items-center gap-3 flex-wrap text-xs">
        <button onClick={() => setOpen((o) => !o)} className="font-semibold text-accent hover:underline">
          {open ? "Hide run control" : "Run control & history"}
        </button>
        {run.isSimulation && (
          <span className="px-2 py-0.5 rounded-full bg-accent/10 text-accent font-semibold">Simulation — nothing is consumed or paid</span>
        )}
        {run.calculationSequence > 0 && <span className="text-label-tertiary">Calculation #{run.calculationSequence}</span>}
        {run.warningCount > 0 && <span className="text-amber-800">{run.warningCount} warning(s)</span>}
        {run.failedCount > 0 && <span className="text-danger">{run.failedCount} employee(s) failed</span>}
        {canPreValidate && (
          <button onClick={() => runValidation("pre")} disabled={busy} className="font-semibold text-accent hover:underline disabled:opacity-50">
            Pre-validate
          </button>
        )}
        {canValidate && (
          <button onClick={() => runValidation("post")} disabled={busy} className="font-semibold text-accent hover:underline disabled:opacity-50">
            Validate
          </button>
        )}
        {canNotify && (
          <button
            onClick={() =>
              act(async () => {
                if (!window.confirm("Email every employee on this run that their payslip is ready? The email has no pay details, and each person is told only once.")) return;
                const r = await api.notifyPayrollPayslips(run.id);
                const parts = [`${r.sent} emailed`];
                if (r.alreadySent) parts.push(`${r.alreadySent} already told`);
                if (r.notPublished) parts.push(`${r.notPublished} not published yet`);
                if (r.noEmail.length) parts.push(`no email address: ${r.noEmail.join(", ")}`);
                if (r.failed.length) parts.push(`could not be delivered: ${r.failed.join(", ")}`);
                setNoticeResult(parts.join(" · "));
              }, "Could not send the payslip emails.")
            }
            disabled={busy}
            className="font-semibold text-accent hover:underline disabled:opacity-50"
          >
            Email payslip notices
          </button>
        )}
        {canClose && (
          <button
            onClick={() =>
              act(async () => {
                if (!window.confirm("Close this run? It stays readable but can only be changed after a reopen with a reason.")) return;
                onRunChanged(await api.closePayrollRun(run.id));
                await refresh();
              }, "Could not close this run.")
            }
            disabled={busy}
            className="font-semibold text-success hover:underline disabled:opacity-50"
          >
            Close run
          </button>
        )}
        {canReopen && (
          <button onClick={() => setReasonFor("reopen")} disabled={busy} className="font-semibold text-amber-800 hover:underline disabled:opacity-50">
            Reopen…
          </button>
        )}
        {canCancel && hasActions && (
          <button onClick={() => setReasonFor("cancel")} disabled={busy} className="font-semibold text-danger hover:underline disabled:opacity-50">
            Cancel run…
          </button>
        )}
      </div>

      {reasonFor && (
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <input
            id={`run-${run.id}-reason`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={reasonFor === "reopen" ? "Why is this closed run being reopened? (min 5 characters)" : "Why is this run being cancelled? (min 5 characters)"}
            className="flex-1 min-w-[16rem] border border-black/10 rounded-lg px-3 py-1.5 text-sm bg-card"
          />
          <button
            onClick={submitReason}
            disabled={busy || reason.trim().length < 5}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-accent text-white disabled:opacity-50"
          >
            Confirm {reasonFor}
          </button>
          <button onClick={() => { setReasonFor(null); setReason(""); }} className="text-xs text-label-tertiary">
            Back
          </button>
        </div>
      )}

      {error && <p className="text-xs text-danger mt-2">{error}</p>}
      {noticeResult && <p className="text-xs text-success mt-2" role="status">Payslip notices: {noticeResult}</p>}

      {findings && (
        <div className="mt-2 rounded-lg bg-black/5 p-3 text-xs space-y-1">
          <div className="font-semibold">
            {findings.stage === "pre_validation" ? "Pre-validation" : "Validation"}{" "}
            {findings.passed ? "passed" : `found ${findings.errorCount} problem(s)`}
            {findings.warningCount > 0 ? ` and ${findings.warningCount} warning(s)` : ""}
          </div>
          {findings.findings.map((f, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className={`px-1.5 py-0.5 rounded-full font-semibold uppercase text-[10px] ${SEVERITY_STYLES[f.severity]}`}>{f.severity}</span>
              <span>
                {f.employeeNumber ? <span className="font-mono">{f.employeeNumber} · </span> : null}
                {f.message}
              </span>
            </div>
          ))}
        </div>
      )}

      {open && run.status !== "draft" && run.status !== "pre_validated" && run.status !== "cancelled" && (
        <PayrollVariancePanel runId={run.id} calculationSequence={run.calculationSequence} />
      )}

      {open && (
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <div className="space-y-3">
            {t && (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <dt className="text-label-tertiary">Gross</dt>
                <dd className="font-mono text-right">{pkr.format(t.gross)}</dd>
                <dt className="text-label-tertiary">Income tax</dt>
                <dd className="font-mono text-right">{pkr.format(t.incomeTax)}</dd>
                <dt className="text-label-tertiary">Employee deductions</dt>
                <dd className="font-mono text-right">{pkr.format(t.employeeDeductions)}</dd>
                <dt className="text-label-tertiary">Net pay</dt>
                <dd className="font-mono text-right font-semibold">{pkr.format(t.net)}</dd>
                <dt className="text-label-tertiary">Employer contributions</dt>
                <dd className="font-mono text-right">{pkr.format(t.employerContributions)}</dd>
                <dt className="text-label-tertiary">Employer cost</dt>
                <dd className="font-mono text-right">{pkr.format(t.employerCost)}</dd>
              </dl>
            )}
            <div className="text-xs text-label-tertiary">
              {run.populationCount} in scope · {run.calculatedCount} calculated · {run.failedCount} failed · {run.currencyCode}, rounded to {run.roundingPrecision} decimals
            </div>

            {population.length > 0 && (
              <div>
                <div className="text-xs font-semibold mb-1">Who this calculation covered</div>
                <div className="text-xs text-label-secondary">
                  {population.length} employee(s) · {population[0].inclusionReason.replace("_", " ")}
                  {population.some((p) => p.status === "failed") ? ` · ${population.filter((p) => p.status === "failed").length} could not be calculated` : ""}
                </div>
                <ul className="mt-1 space-y-0.5">
                  {population
                    .filter((p) => p.status === "failed" || p.status === "excluded")
                    .map((p) => (
                      <li key={p.id} className="text-xs">
                        <span className="font-mono">{p.employeeNumber}</span> <span className="text-danger">{p.status}</span>
                        {p.exclusionReason ? <span className="text-label-tertiary"> — {p.exclusionReason}</span> : null}
                      </li>
                    ))}
                </ul>
              </div>
            )}

            <div>
              <div className="text-xs font-semibold mb-1">Manual overrides</div>
              {overrides.length === 0 ? (
                <div className="text-xs text-label-tertiary">None on this run.</div>
              ) : (
                <ul className="space-y-1">
                  {overrides.map((o) => (
                    <li key={o.id} className="text-xs flex items-start justify-between gap-2">
                      <span className={o.status === "withdrawn" ? "line-through text-label-tertiary" : ""}>
                        {nameOf(o.employeeId)} · {OVERRIDE_FIELD_LABELS[o.field]}: {o.oldValue !== null ? pkr.format(o.oldValue) : "—"} → {pkr.format(o.newValue)}
                        <span className="text-label-tertiary"> — {o.reason}</span>
                        {o.approvedAt ? <span className="text-success"> · approved</span> : null}
                      </span>
                      {canOverride && o.status === "applied" && (
                        <button onClick={() => withdraw(o.id)} disabled={busy} className="text-danger hover:underline shrink-0">
                          Withdraw
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {canOverride && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <select id={`ov-emp-${run.id}`} value={ovEmployee} onChange={(e) => setOvEmployee(e.target.value)} className="border border-black/10 rounded-lg px-2 py-1.5 text-xs bg-card col-span-2">
                    <option value="">Employee…</option>
                    {payslips.map((p) => (
                      <option key={p.employeeId} value={p.employeeId}>
                        {p.employeeNumber}
                      </option>
                    ))}
                  </select>
                  <select id={`ov-field-${run.id}`} value={ovField} onChange={(e) => setOvField(e.target.value as PayrollOverridableField)} className="border border-black/10 rounded-lg px-2 py-1.5 text-xs bg-card">
                    {(Object.keys(OVERRIDE_FIELD_LABELS) as PayrollOverridableField[]).map((f) => (
                      <option key={f} value={f}>
                        {OVERRIDE_FIELD_LABELS[f]}
                      </option>
                    ))}
                  </select>
                  <input id={`ov-val-${run.id}`} type="number" min={0} step="0.01" value={ovValue} onChange={(e) => setOvValue(e.target.value)} placeholder="New amount" className="border border-black/10 rounded-lg px-2 py-1.5 text-xs bg-card" />
                  <input id={`ov-why-${run.id}`} value={ovReason} onChange={(e) => setOvReason(e.target.value)} placeholder="Reason (required)" className="border border-black/10 rounded-lg px-2 py-1.5 text-xs bg-card col-span-2" />
                  <button
                    onClick={addOverride}
                    disabled={busy || !ovEmployee || ovValue === "" || ovReason.trim().length < 3}
                    className="col-span-2 text-xs font-semibold px-3 py-1.5 rounded-lg bg-accent text-white disabled:opacity-50"
                  >
                    Apply override
                  </button>
                </div>
              )}
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold mb-1">Timeline</div>
            {!events ? (
              <div className="text-xs text-label-tertiary">Loading…</div>
            ) : (
              <ol className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                {events.map((e) => (
                  <li key={e.id} className="text-xs">
                    <span className="font-semibold">{ACTION_LABELS[e.action] ?? e.action}</span>
                    <span className="text-label-tertiary">
                      {" "}
                      · {e.fromStatus ? `${RUN_STATUS_LABELS[e.fromStatus]} → ` : ""}
                      {RUN_STATUS_LABELS[e.toStatus]} · {formatDateTime(e.createdAt)}
                    </span>
                    {e.reason && <div className="text-label-secondary">“{e.reason}”</div>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
