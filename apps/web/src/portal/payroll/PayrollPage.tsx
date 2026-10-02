import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type {
  EmployeeView,
  PayrollAreaView,
  PayrollRunView,
  PayrollSettingsView,
  PayslipView,
  TaxSlabSetView,
  TaxSlabView,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { CreateRunForm, OFF_CYCLE_REASON_LABELS, OffCyclePaymentsPanel, PayrollSettingsForm, TaxSlabsForm } from "./PayrollAdminForms";
import { CostCenterBreakdownPanel, DisbursementPanel, DisbursementSettingsForm } from "./PayrollDisbursementPanels";
import { PayrollAreasSection } from "./PayrollAreasSection";
import { RUN_STATUS_LABELS, RUN_STATUS_STYLES, pkr } from "./payrollLabels";

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Payroll module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to view this.";
    return err.message;
  }
  return "Something went wrong loading this.";
}

/** One payslip's full breakdown, expanded inline — the direct UI for
 * this phase's own exit criterion that every intermediate figure in a
 * payslip be inspectable (`PayslipView.calculationBreakdown`), not just
 * the final net figure. */
function PayslipDetail({ payslip }: { payslip: PayslipView }) {
  return (
    <div className="bg-black/5 rounded-lg p-4 mt-2 space-y-3">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
        <span className="text-label-tertiary">Days in period</span>
        <span className="text-right font-mono">{payslip.daysInPeriod}</span>
        <span className="text-label-tertiary">Paid days</span>
        <span className="text-right font-mono">{payslip.paidDays}</span>
        <span className="text-label-tertiary">Unpaid leave days</span>
        <span className="text-right font-mono">{payslip.unpaidLeaveDays}</span>
      </div>
      <div className="border-t border-black/10 pt-3 space-y-1">
        {payslip.calculationBreakdown.map((step, i) => (
          <div key={i} className="flex justify-between text-xs">
            <span className="text-label-tertiary">{step.label}</span>
            <span className="font-mono">{typeof step.value === "number" ? pkr.format(step.value) : step.value}</span>
          </div>
        ))}
      </div>
      <div className="border-t border-black/10 pt-3 flex justify-between text-sm font-semibold">
        <span>Net pay</span>
        <span className="font-mono">{pkr.format(payslip.netPay)}</span>
      </div>
    </div>
  );
}

function PayslipRow({ payslip }: { payslip: PayslipView }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="bg-card rounded-lg px-4 py-3 shadow-sm border border-black/5">
      <button className="w-full flex items-center justify-between text-left" onClick={() => setExpanded((e) => !e)}>
        <span className="text-sm font-medium">
          {payslip.payrollRunPeriodStart} – {payslip.payrollRunPeriodEnd}
        </span>
        <span className="flex items-center gap-4">
          <span className="text-sm font-mono tabular-nums">{pkr.format(payslip.netPay)}</span>
          <span className="text-xs font-medium text-accent">{expanded ? "Hide" : "Details"}</span>
        </span>
      </button>
      {expanded && <PayslipDetail payslip={payslip} />}
    </div>
  );
}

/**
 * Expanded run row. Phase P2 split this into two capabilities that no
 * longer always belong to the same login: `canPrepare` (hr_admin — create,
 * calculate/recalculate, submit for approval, finalize, download the
 * disbursement CSV, and — Correction/Reversal — reverse a finalized run)
 * and `canApprove` (the new, separate Payroll Approver role — approve/
 * reject a `pending_approval` run). Calculate (re-runnable,
 * PayrollService.calculateRun's own rule) and finalize (one-way — no
 * "un-finalize" endpoint exists) are unchanged in spirit; finalize now
 * additionally requires the run be `approved`, not just `calculated` —
 * see PayrollService.finalizeRun's own updated guard. Server-side,
 * `canPrepare`'s reversal action is gated more strictly still — both
 * `payroll.finalize.all` AND `payroll.disburse.all` — but hr_admin is the
 * only preparer identity this app has, and it holds both, so `canPrepare`
 * is the right cosmetic gate here too (see `requirePayrollReverse()`'s own
 * doc comment on the API side).
 */
function RunCard({
  run,
  area,
  targetEmployee,
  canPrepare,
  canApprove,
  onChanged,
}: {
  run: PayrollRunView;
  /** Payroll Areas: the area this run targets, if any — `undefined` with
   * a non-null `run.payrollAreaId` just means the name lookup hasn't
   * resolved (or this login can't list areas). */
  area: PayrollAreaView | undefined;
  /** Phase P4 — the single employee this off-cycle run targets, if any
   * (always set for `final_settlement`; optional single-employee scoping
   * for `bonus`/`arrears`/`other`; `undefined` for a batch run or while
   * the lookup hasn't resolved). */
  targetEmployee: EmployeeView | undefined;
  canPrepare: boolean;
  canApprove: boolean;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [payslips, setPayslips] = useState<PayslipView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calcSummary, setCalcSummary] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<"approved" | "rejected" | null>(null);
  const [comment, setComment] = useState("");
  // Phase P2 (Correction/Reversal) — mirrors the `deciding`/`comment`
  // pattern above, but for reversing an already-`finalized` run. A reason
  // is mandatory server-side (ReversePayrollRunDto), so Confirm stays
  // disabled until something is typed.
  const [reversing, setReversing] = useState(false);
  const [reversalReason, setReversalReason] = useState("");
  // Real production feedback (kumail, 2026-09-28): a live test showed an
  // approver could click Approve with zero numbers on screen — the run's
  // summary lived only behind the (separate, collapsed-by-default) payslip
  // list. `hasReviewedPayslips` is a one-way latch: it flips true the
  // first time this card is expanded and stays true even if the approver
  // collapses it again, so re-collapsing to declutter the screen right
  // before deciding never re-locks Approve/Reject. It gates the DECISION
  // buttons only — expanding/reading is always free — and it's a UI
  // nicety, not the security boundary: `PayrollService.decideApproval()`
  // enforces the real one server-side regardless of what this card shows.
  const [hasReviewedPayslips, setHasReviewedPayslips] = useState(false);

  function toggleExpanded() {
    setExpanded((e) => !e);
    setHasReviewedPayslips(true);
  }

  useEffect(() => {
    if (!expanded) return;
    api
      .listPayslips({ payrollRunId: run.id })
      .then(setPayslips)
      .catch((err) => setError(describeError(err)));
  }, [expanded, run.id]);

  async function handleCalculate() {
    setBusy(true);
    setError(null);
    setCalcSummary(null);
    try {
      const result = await api.calculatePayrollRun(run.id);
      setCalcSummary(
        result.errors.length > 0
          ? `Calculated ${result.payslipCount} payslip(s), ${result.errors.length} employee(s) skipped — see below.`
          : `Calculated ${result.payslipCount} payslip(s).`
      );
      if (expanded) {
        const refreshed = await api.listPayslips({ payrollRunId: run.id });
        setPayslips(refreshed);
      }
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not calculate this run.");
    } finally {
      setBusy(false);
    }
  }

  async function handleFinalize() {
    if (!window.confirm("Finalize this run? This locks every payslip and cannot be undone.")) return;
    setBusy(true);
    setError(null);
    try {
      await api.finalizePayrollRun(run.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not finalize this run.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmitForApproval() {
    setBusy(true);
    setError(null);
    try {
      await api.submitPayrollRunForApproval(run.id);
      onChanged();
    } catch (err) {
      // A 404 here means no "Payroll run approval" workflow template has
      // been configured yet for this tenant (System Admin > Configuration
      // > Workflow Templates) — the same expected gap
      // RequisitionsPanel's own comment documents for job_requisition.
      setError(err instanceof ApiError ? err.message : "Could not submit this run for approval.");
    } finally {
      setBusy(false);
    }
  }

  async function submitDecision(decision: "approved" | "rejected") {
    setBusy(true);
    setError(null);
    try {
      await api.decidePayrollRunApproval(run.id, { decision, comment: comment || undefined });
      setDeciding(null);
      setComment("");
      onChanged();
    } catch (err) {
      // A real 403 here ("not permitted to approve payroll runs" or "not a
      // resolved approver on this step") is the honest answer if this
      // login's role assignment doesn't actually match — canApprove below
      // is a cosmetic gate on top of the real, server-side one.
      setError(err instanceof ApiError ? err.message : "Could not record this decision.");
    } finally {
      setBusy(false);
    }
  }

  async function handleReverse() {
    if (!reversalReason.trim()) return;
    if (!window.confirm("Reverse this finalized run? This cannot be undone — the original payslips are kept for the record.")) return;
    setBusy(true);
    setError(null);
    try {
      await api.reversePayrollRun(run.id, { reason: reversalReason.trim() });
      setReversing(false);
      setReversalReason("");
      onChanged();
    } catch (err) {
      // A real 403 here means this login is missing one of the two
      // permissions reversal requires (payroll.finalize.all AND
      // payroll.disburse.all) — canPrepare below is a cosmetic gate on
      // top of that real, server-side one.
      setError(err instanceof ApiError ? err.message : "Could not reverse this run.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-card rounded-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <button className="text-left" onClick={toggleExpanded}>
          <div className="font-medium text-sm flex items-center gap-2 flex-wrap">
            <span>
              {run.periodStart} – {run.periodEnd}
            </span>
            {/* Payroll Areas — which slice of the company this run pays, so
                two runs for the same period (one per area) are never
                ambiguous in this list. */}
            <span className="text-xs font-normal px-2 py-0.5 rounded-full bg-black/5 text-label-secondary">
              {run.payrollAreaId ? (area ? `${area.name} (${area.code})` : "Payroll area") : "Company-wide"}
            </span>
            {/* Phase P4 — an off-cycle run otherwise looks identical to a
                regular run in this list; this is the one glance that tells
                an approver "this is a bonus/arrears/settlement run, not the
                normal monthly one" before they open it. */}
            {run.runType === "off_cycle" && (
              <span className="text-xs font-normal px-2 py-0.5 rounded-full bg-accent/10 text-accent">
                {run.offCycleReason ? OFF_CYCLE_REASON_LABELS[run.offCycleReason] : "Off-cycle"}
                {targetEmployee ? ` · ${targetEmployee.employeeNumber} ${targetEmployee.firstName} ${targetEmployee.lastName}` : ""}
              </span>
            )}
          </div>
          <div className="text-xs text-label-tertiary mt-0.5">
            {run.finalizedAt ? `Finalized ${new Date(run.finalizedAt).toLocaleDateString()}` : "Not yet finalized"}
          </div>
          {/* Always visible — not gated behind expanding — so a Payroll
              Approver sees the actual scale of what they're deciding on
              (headcount and money) the instant this card renders, before
              they've clicked anything at all. */}
          {run.status !== "draft" && (
            <div className="text-xs text-label-secondary mt-1 font-mono">
              {run.payslipCount} {run.payslipCount === 1 ? "employee" : "employees"} · net pay {pkr.format(run.totalNetPay)}
            </div>
          )}
          {/* Phase P2 (Correction/Reversal) — the reason is exactly what
              Section 36's "capture reason" requirement is for; showing it
              here means anyone looking at the runs list sees why, not just
              that something changed. */}
          {run.status === "reversed" && (
            <div className="text-xs text-danger mt-1">
              Reversed{run.reversedAt ? ` ${new Date(run.reversedAt).toLocaleDateString()}` : ""}
              {run.reversalReason ? `: ${run.reversalReason}` : ""}
            </div>
          )}
        </button>
        <div className="flex items-center gap-3">
          <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${RUN_STATUS_STYLES[run.status]}`}>
            {RUN_STATUS_LABELS[run.status]}
          </span>
          {canPrepare && (run.status === "draft" || run.status === "calculated") && (
            <button
              onClick={handleCalculate}
              disabled={busy}
              className="text-xs font-semibold text-accent hover:underline disabled:opacity-50"
            >
              {run.status === "draft" ? "Calculate" : "Recalculate"}
            </button>
          )}
          {canPrepare && run.status === "calculated" && (
            <button
              onClick={handleSubmitForApproval}
              disabled={busy}
              className="text-xs font-semibold text-accent hover:underline disabled:opacity-50"
            >
              Submit for approval
            </button>
          )}
          {canPrepare && run.status === "approved" && (
            <button
              onClick={handleFinalize}
              disabled={busy}
              className="text-xs font-semibold text-success hover:underline disabled:opacity-50"
            >
              Finalize
            </button>
          )}
          {/* Phase P2 (Correction/Reversal) — hr_admin is the only
              preparer identity this app has, and it holds both
              payroll.finalize.all and payroll.disburse.all (the "elevated
              authorization" PayrollService.requirePayrollReverse() checks
              for), so canPrepare is the right cosmetic gate here too. */}
          {canPrepare && run.status === "finalized" && !reversing && (
            <button
              onClick={() => setReversing(true)}
              disabled={busy}
              className="text-xs font-semibold text-danger hover:underline disabled:opacity-50"
            >
              Reverse
            </button>
          )}
          {canApprove && run.status === "pending_approval" && !deciding && !hasReviewedPayslips && (
            <button
              onClick={toggleExpanded}
              className="text-xs font-semibold text-accent hover:underline"
            >
              Review {run.payslipCount} {run.payslipCount === 1 ? "payslip" : "payslips"} to decide
            </button>
          )}
          {canApprove && run.status === "pending_approval" && !deciding && hasReviewedPayslips && (
            <>
              <button
                onClick={() => setDeciding("approved")}
                disabled={busy}
                className="text-xs font-semibold text-success hover:underline disabled:opacity-50"
              >
                Approve
              </button>
              <button
                onClick={() => setDeciding("rejected")}
                disabled={busy}
                className="text-xs font-semibold text-danger hover:underline disabled:opacity-50"
              >
                Reject
              </button>
            </>
          )}
        </div>
      </div>

      {deciding && (
        <div className="mt-3 pt-3 border-t border-black/5 space-y-2">
          <div className="text-xs text-label-secondary">
            {deciding === "approved" ? "Approving" : "Rejecting"} {run.periodStart} – {run.periodEnd}:{" "}
            <span className="font-mono">
              {run.payslipCount} {run.payslipCount === 1 ? "employee" : "employees"}, net pay {pkr.format(run.totalNetPay)}
            </span>
          </div>
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Comment (optional)"
            className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <div className="flex gap-3 items-center">
            <button
              onClick={() => submitDecision(deciding)}
              disabled={busy}
              className={`text-xs font-semibold rounded-lg px-3 py-1.5 text-white disabled:opacity-50 ${
                deciding === "approved" ? "bg-success" : "bg-danger"
              }`}
            >
              Confirm {deciding === "approved" ? "approval" : "rejection"}
            </button>
            <button onClick={() => setDeciding(null)} className="text-xs text-label-tertiary">
              Cancel
            </button>
          </div>
        </div>
      )}

      {reversing && (
        <div className="mt-3 pt-3 border-t border-black/5 space-y-2">
          <div className="text-xs text-label-secondary">
            Reversing {run.periodStart} – {run.periodEnd} — this cannot be undone. The original payslips are kept
            for the record; a new draft run opens for the same period so you can correct and refinalize it.
          </div>
          <input
            value={reversalReason}
            onChange={(e) => setReversalReason(e.target.value)}
            placeholder="Reason for reversal (required)"
            className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <div className="flex gap-3 items-center">
            <button
              onClick={handleReverse}
              disabled={busy || !reversalReason.trim()}
              className="text-xs font-semibold rounded-lg px-3 py-1.5 text-white bg-danger disabled:opacity-50"
            >
              Confirm reversal
            </button>
            <button
              onClick={() => {
                setReversing(false);
                setReversalReason("");
              }}
              className="text-xs text-label-tertiary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {calcSummary && <p className="text-xs text-label-secondary mt-2">{calcSummary}</p>}
      {error && <p className="text-xs text-danger mt-2">{error}</p>}

      {/* Phase P4 — the queue HR builds up before calculating a
          bonus/arrears/final-settlement run. Server-side
          (`EmployeeOffCyclePaymentsService.create`) already refuses a new
          line once the run is `finalized`/`reversed`, so this mirrors that
          same cutoff rather than inventing a stricter one. */}
      {run.runType === "off_cycle" && run.status !== "finalized" && run.status !== "reversed" && (
        <OffCyclePaymentsPanel run={run} canManage={canPrepare} />
      )}

      {/* Phase P5 — disbursement (preview/download/batch history/void) is
          HR Admin's own prepare-side action, same gate as Reverse above;
          the cost-center breakdown is a read-only report anyone who can
          see this card's numbers may as well see broken down. Both only
          make sense once a run is finalized — before that there's no
          settled payslip set to disburse or cost out. */}
      {run.status === "finalized" && canPrepare && <DisbursementPanel runId={run.id} />}
      {run.status === "finalized" && <CostCenterBreakdownPanel runId={run.id} />}

      {expanded && (
        <div className="mt-4 pt-4 border-t border-black/5 space-y-2">
          {!payslips ? (
            <div className="text-sm text-label-tertiary">Loading payslips…</div>
          ) : payslips.length === 0 ? (
            <div className="text-sm text-label-tertiary">No payslips yet — calculate this run first.</div>
          ) : (
            payslips.map((p) => <PayslipRow key={p.id} payslip={p} />)
          )}
        </div>
      )}
    </div>
  );
}

function RunsSection({
  refreshKey,
  canPrepare,
  canApprove,
  onChanged,
}: {
  refreshKey: number;
  canPrepare: boolean;
  canApprove: boolean;
  onChanged: () => void;
}) {
  const [runs, setRuns] = useState<PayrollRunView[] | null>(null);
  const [areasById, setAreasById] = useState<Map<string, PayrollAreaView>>(new Map());
  const [employeesById, setEmployeesById] = useState<Map<string, EmployeeView>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    api
      .listPayrollRuns()
      .then((r) => setRuns(r.slice().sort((a, b) => b.periodStart.localeCompare(a.periodStart))))
      .catch((err) => setError(describeError(err)));
    // Inactive areas too — an older run keeps pointing at an area that
    // has since been deactivated. Name lookup only; never blocks the list.
    api
      .listPayrollAreas(true)
      .then((areas) => setAreasById(new Map(areas.map((a) => [a.id, a]))))
      .catch(() => undefined);
    // Phase P4 — name lookup only, for the off-cycle target-employee badge
    // on RunCard; never blocks the runs list if it fails.
    api
      .listEmployees()
      .then((employees) => setEmployeesById(new Map(employees.map((e) => [e.id, e]))))
      .catch(() => undefined);
  }, [refreshKey]);

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Payroll Runs</h2>
        {canPrepare && !showForm && (
          <button onClick={() => setShowForm(true)} className="text-sm font-semibold text-accent hover:underline">
            New run
          </button>
        )}
      </div>

      {showForm && (
        <div className="mb-4">
          <CreateRunForm
            onCancel={() => setShowForm(false)}
            onCreated={() => {
              setShowForm(false);
              onChanged();
            }}
          />
        </div>
      )}

      {!runs ? (
        <div className="text-label-tertiary text-sm">Loading…</div>
      ) : runs.length === 0 ? (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">No payroll runs yet.</div>
      ) : (
        <div className="space-y-3">
          {runs.map((r) => (
            <RunCard
              key={r.id}
              run={r}
              area={r.payrollAreaId ? areasById.get(r.payrollAreaId) : undefined}
              targetEmployee={r.targetEmployeeId ? employeesById.get(r.targetEmployeeId) : undefined}
              canPrepare={canPrepare}
              canApprove={canApprove}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Collapsible wrapper so Compensation/Settings/Tax Slabs don't compete
 * with Runs for vertical space by default — the run lifecycle is what an
 * hr_admin opens this page for most often; the other two are
 * infrequent, set-up-once configuration.
 *
 * `forceOpen` lets a deep link (`?section=tax-slabs`, see PayrollPage's
 * own `focusSection`) land directly on an already-expanded section
 * instead of the collapsed default — this is the direct fix for kumail's
 * report (2026-09-27) that the System Admin "Tax Slabs & Statutory
 * Rates" tile "routes me to payroll run": the route itself was always
 * correct (tax slabs genuinely live on this page), but with no deep-link
 * support it landed on the collapsed Runs-first view, which reads as
 * "the wrong page" even though it isn't. `sectionId` is what that same
 * effect scrolls into view once forced open. */
function CollapsibleSection({
  title,
  defaultOpen = false,
  forceOpen = false,
  sectionId,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  sectionId?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen || forceOpen);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (forceOpen) {
      setOpen(true);
      ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    // Only react to forceOpen turning on for this section, not to every render.
  }, [forceOpen]);

  return (
    <section ref={ref} id={sectionId} className="bg-card rounded-card shadow-sm">
      <button
        className="w-full flex items-center justify-between px-5 py-4 text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">{title}</h2>
        <span className="text-label-tertiary text-sm">{open ? "Hide" : "Show"}</span>
      </button>
      {open && <div className="px-5 pb-5">{children}</div>}
    </section>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Migration 0033's read-side deliverable for tax slabs: every effective-
 * dated bracket-table generation this tenant has ever had, oldest first
 * — the "reconstruct what the brackets were on date X" a payroll dispute
 * would actually need.
 */
function TaxSlabHistory() {
  const [history, setHistory] = useState<TaxSlabSetView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getTaxSlabHistory().then(setHistory).catch((err) => setError(describeError(err)));
  }, []);

  if (error) return <p className="text-xs text-danger">{error}</p>;
  if (!history) return <p className="text-xs text-label-tertiary">Loading history…</p>;

  return (
    <div className="space-y-3">
      {[...history].reverse().map((generation) => (
        <div key={generation.effectiveFrom} className="bg-black/5 rounded-lg p-3">
          <p className="text-xs font-semibold text-label-secondary mb-2">
            {formatDate(generation.effectiveFrom)} – {generation.effectiveTo ? formatDate(generation.effectiveTo) : "present"}
          </p>
          <div className="space-y-1">
            {generation.slabs
              .slice()
              .sort((a, b) => a.minAnnualIncome - b.minAnnualIncome)
              .map((slab) => (
                <div key={slab.id} className="flex justify-between text-xs font-mono text-label-tertiary">
                  <span>
                    {slab.minAnnualIncome.toLocaleString()} – {slab.maxAnnualIncome === null ? "∞" : slab.maxAnnualIncome.toLocaleString()}
                  </span>
                  <span>{slab.ratePercent}%</span>
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function SettingsAndSlabsSection() {
  const [settings, setSettings] = useState<PayrollSettingsView | null>(null);
  const [slabs, setSlabs] = useState<TaxSlabView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [showSlabHistory, setShowSlabHistory] = useState(false);

  useEffect(() => {
    Promise.all([api.getPayrollSettings(), api.listTaxSlabs()])
      .then(([s, t]) => {
        setSettings(s);
        setSlabs(t);
      })
      .catch((err) => setError(describeError(err)));
  }, []);

  if (error) return <div className="text-sm text-label-secondary">{error}</div>;

  return (
    <div className="space-y-6">
      {savedNotice && <p className="text-xs text-success">{savedNotice}</p>}
      <div>
        <h3 className="text-sm font-semibold mb-2">EOBI &amp; social security</h3>
        {settings && <p className="text-xs text-label-tertiary mb-2">In effect since {formatDate(settings.effectiveFrom)}</p>}
        {!settings ? (
          <div className="text-sm text-label-tertiary">Loading…</div>
        ) : (
          <PayrollSettingsForm
            settings={settings}
            onSaved={(updated) => {
              setSettings(updated);
              setSavedNotice("Payroll settings saved.");
            }}
          />
        )}
      </div>
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">Income tax brackets</h3>
          <button
            onClick={() => setShowSlabHistory((s) => !s)}
            className="text-xs font-semibold text-accent hover:underline"
          >
            {showSlabHistory ? "Hide history" : "History"}
          </button>
        </div>
        {slabs && slabs.length > 0 && (
          <p className="text-xs text-label-tertiary mb-2">In effect since {formatDate(slabs[0].effectiveFrom)}</p>
        )}
        {showSlabHistory && (
          <div className="mb-4">
            <TaxSlabHistory />
          </div>
        )}
        {!slabs ? (
          <div className="text-sm text-label-tertiary">Loading…</div>
        ) : (
          <TaxSlabsForm
            slabs={slabs}
            onSaved={(updated) => {
              setSlabs(updated);
              setSavedNotice("Tax slabs saved.");
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * `payroll_review.view.self` (employee_self_service only) — the server
 * scopes `GET /payslips` with no params to the caller's own record AND
 * only once its run is finalized (PayrollService.listPayslips), so this
 * is a plain render of whatever comes back, same "server already
 * scopes it" posture as MyLeaveCard.
 */
function MyPayslipsCard({ refreshKey }: { refreshKey: number }) {
  const [payslips, setPayslips] = useState<PayslipView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listPayslips()
      .then(setPayslips)
      .catch((err) => setError(describeError(err)));
  }, [refreshKey]);

  // listPayslips() orders newest-first (`ORDER BY p.created_at DESC`), so
  // the first row is this employee's current/most recent finalized
  // payslip — Part 2 category 5's "Current net pay KPI with pay period
  // and pay date" header, same data the historical list below already
  // has, just surfaced once up top.
  const current = payslips && payslips.length > 0 ? payslips[0] : null;

  return (
    <section className="bg-card rounded-card p-5 shadow-sm mb-6">
      <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-4">My Payslips</h2>
      {error ? (
        <p className="text-sm text-label-secondary">{error}</p>
      ) : !payslips ? (
        <div className="text-sm text-label-tertiary">Loading…</div>
      ) : payslips.length === 0 ? (
        <p className="text-sm text-label-tertiary">No finalized payslips yet.</p>
      ) : (
        <>
          {current && (
            <div className="bg-surface border border-black/5 rounded-lg px-4 py-3.5 mb-4">
              <div className="text-xs uppercase tracking-wide text-label-tertiary">Current net pay</div>
              <div className="text-2xl font-bold tabular-nums">{pkr.format(current.netPay)}</div>
              <div className="text-xs text-label-tertiary mt-0.5">
                {current.payrollRunPeriodStart} – {current.payrollRunPeriodEnd}
              </div>
            </div>
          )}
          <div className="space-y-2">
            {payslips.map((p) => (
              <PayslipRow key={p.id} payslip={p} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Task — Compensation & Payroll (Phase 12, Decision #14; run approval
 * added Phase P2). hr_admin still gets the whole object graph
 * (compensation, settings, tax slabs, run lifecycle, every payslip) and
 * is the only role that can create/calculate/submit/finalize a run.
 * Phase P2 adds a second, DISTINCT role — Payroll Approver — that sees
 * only the Payroll Runs list (never Settings & Tax Slabs, never
 * Compensation) and can only approve/reject a `pending_approval` run;
 * see 0093_payroll_approval_workflow.sql for why this is deliberately not
 * folded into `payroll.manage.all`. employee_self_service still gets only
 * their own finalized payslip. A session holding none of these sees
 * nothing, same as a line_manager on LeavePage's My Leave card.
 */
export function PayrollPage() {
  const { identity } = useAuth();
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey((k) => k + 1);
  const [searchParams] = useSearchParams();
  // System Admin's Configuration tile for "Tax Slabs & Statutory Rates"
  // links here with ?section=tax-slabs; Compensation is included for the
  // same reason, in case something ever deep-links to it too.
  const focusSection = searchParams.get("section");

  const roleKeys = identity?.roleKeys ?? [];
  const isHrAdmin = roleKeys.includes("hr_admin");
  const isPayrollApprover = roleKeys.includes("payroll_approver");
  const isSelfService = roleKeys.includes("employee_self_service");

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-1">Payroll</h1>
      <p className="text-label-tertiary text-sm mb-6">
        {isHrAdmin
          ? "Manage compensation, statutory rates, and run payroll end to end."
          : isPayrollApprover
            ? "Review and decide on payroll runs submitted for your approval."
            : "View your own payslips once a run has been finalized."}
      </p>

      {isSelfService && <MyPayslipsCard refreshKey={refreshKey} />}

      {(isHrAdmin || isPayrollApprover) && (
        <div className="space-y-6">
          <RunsSection refreshKey={refreshKey} canPrepare={isHrAdmin} canApprove={isPayrollApprover} onChanged={bump} />

          {isHrAdmin && focusSection === "compensation" && (
            <div className="bg-card rounded-card p-5 shadow-sm text-sm text-label-tertiary">
              Compensation now lives on each employee's own profile — open an
              employee and use the "Compensation & Assets" tab. This keeps
              recurring pay as employee master data (the same way SAP's
              IT0008/IT0014 infotypes work), with Payroll only reading it to
              calculate a run.
            </div>
          )}

          {/* Payroll Areas (0101_payroll_areas.sql). hr_admin is the only
              role seeded with `payroll_area.manage.all`, so it's the
              management gate; a Payroll Approver can read the list (any
              payroll-staff permission can — PayrollAreasService.list())
              to see which employees a run they're deciding on covers.
              Deep-linkable with ?section=payroll-areas, same as tax slabs. */}
          <CollapsibleSection
            title="Payroll Areas"
            forceOpen={focusSection === "payroll-areas"}
            sectionId="payroll-areas"
          >
            <PayrollAreasSection canManage={isHrAdmin} onChanged={bump} />
          </CollapsibleSection>

          {isHrAdmin && (
            <CollapsibleSection title="Settings & Tax Slabs" forceOpen={focusSection === "tax-slabs"} sectionId="tax-slabs">
              <SettingsAndSlabsSection />
            </CollapsibleSection>
          )}

          {/* Phase P5 — which bank-file columns get written and in what
              order; tenant-editable so every bank's import template fits
              without a per-bank code path. Deep-linkable the same way as
              the sections above, for a future System Admin tile. */}
          {isHrAdmin && (
            <CollapsibleSection
              title="Disbursement Settings"
              forceOpen={focusSection === "disbursement-settings"}
              sectionId="disbursement-settings"
            >
              <DisbursementSettingsForm />
            </CollapsibleSection>
          )}
        </div>
      )}

      {!isHrAdmin && !isPayrollApprover && !isSelfService && (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
          Nothing to show for your role here.
        </div>
      )}
    </div>
  );
}
