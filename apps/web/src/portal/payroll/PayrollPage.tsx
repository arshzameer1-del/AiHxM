import { useEffect, useState } from "react";
import type { PayrollRunView, PayrollSettingsView, PayslipView, TaxSlabSetView, TaxSlabView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { CompensationForm, CreateRunForm, PayrollSettingsForm, TaxSlabsForm } from "./PayrollAdminForms";
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
    <div className="bg-card rounded-lg px-4 py-3 shadow-sm">
      <button className="w-full flex items-center justify-between text-left" onClick={() => setExpanded((e) => !e)}>
        <span className="text-sm font-medium">{payslip.employeeNumber}</span>
        <span className="flex items-center gap-4">
          <span className="text-sm font-mono">{pkr.format(payslip.netPay)}</span>
          <span className="text-xs text-label-tertiary">{expanded ? "Hide" : "Details"}</span>
        </span>
      </button>
      {expanded && <PayslipDetail payslip={payslip} />}
    </div>
  );
}

/**
 * Expanded run row for hr_admin: calculate (re-runnable until finalized,
 * PayrollService.calculateRun's own rule), finalize (one-way — no
 * "un-finalize" endpoint exists), and download the bank disbursement CSV,
 * which `generateDisbursementFile` refuses with a 400 unless the run is
 * already finalized, so that action only ever renders once it can succeed.
 */
function RunCard({ run, onChanged }: { run: PayrollRunView; onChanged: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [payslips, setPayslips] = useState<PayslipView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calcSummary, setCalcSummary] = useState<string | null>(null);

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

  async function handleDownload() {
    setBusy(true);
    setError(null);
    try {
      await api.downloadDisbursementFile(run.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not download the disbursement file.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-card rounded-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <button className="text-left" onClick={() => setExpanded((e) => !e)}>
          <div className="font-medium text-sm">
            {run.periodStart} – {run.periodEnd}
          </div>
          <div className="text-xs text-label-tertiary mt-0.5">
            {run.finalizedAt ? `Finalized ${new Date(run.finalizedAt).toLocaleDateString()}` : "Not yet finalized"}
          </div>
        </button>
        <div className="flex items-center gap-3">
          <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${RUN_STATUS_STYLES[run.status]}`}>
            {RUN_STATUS_LABELS[run.status]}
          </span>
          {run.status !== "finalized" && (
            <button
              onClick={handleCalculate}
              disabled={busy}
              className="text-xs font-semibold text-accent hover:underline disabled:opacity-50"
            >
              {run.status === "draft" ? "Calculate" : "Recalculate"}
            </button>
          )}
          {run.status === "calculated" && (
            <button
              onClick={handleFinalize}
              disabled={busy}
              className="text-xs font-semibold text-success hover:underline disabled:opacity-50"
            >
              Finalize
            </button>
          )}
          {run.status === "finalized" && (
            <button
              onClick={handleDownload}
              disabled={busy}
              className="text-xs font-semibold text-accent hover:underline disabled:opacity-50"
            >
              Download disbursement CSV
            </button>
          )}
        </div>
      </div>

      {calcSummary && <p className="text-xs text-label-secondary mt-2">{calcSummary}</p>}
      {error && <p className="text-xs text-danger mt-2">{error}</p>}

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

function RunsSection({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const [runs, setRuns] = useState<PayrollRunView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    api
      .listPayrollRuns()
      .then((r) => setRuns(r.slice().sort((a, b) => b.periodStart.localeCompare(a.periodStart))))
      .catch((err) => setError(describeError(err)));
  }, [refreshKey]);

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Payroll Runs</h2>
        {!showForm && (
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
            <RunCard key={r.id} run={r} onChanged={onChanged} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Collapsible wrapper so Compensation/Settings/Tax Slabs don't compete
 * with Runs for vertical space by default — the run lifecycle is what an
 * hr_admin opens this page for most often; the other three are
 * infrequent, set-up-once configuration. */
function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="bg-card rounded-card shadow-sm">
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
        <div className="space-y-2">
          {payslips.map((p) => (
            <PayslipRow key={p.id} payslip={p} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Task — Compensation & Payroll (Phase 12, Decision #14). Split strictly
 * along the two permissions 0023_payroll_seed.sql actually grants —
 * there is no partial-admin middle ground (no separate Finance Admin
 * role, per that migration's own header comment): hr_admin gets the
 * whole object graph (compensation, settings, tax slabs, run lifecycle,
 * every payslip); employee_self_service gets only their own finalized
 * payslip. A session holding neither sees neither section, same as a
 * line_manager on LeavePage's My Leave card.
 */
export function PayrollPage() {
  const { identity } = useAuth();
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey((k) => k + 1);

  const roleKeys = identity?.roleKeys ?? [];
  const isHrAdmin = roleKeys.includes("hr_admin");
  const isSelfService = roleKeys.includes("employee_self_service");

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-1">Payroll</h1>
      <p className="text-label-tertiary text-sm mb-6">
        {isHrAdmin
          ? "Manage compensation, statutory rates, and run payroll end to end."
          : "View your own payslips once a run has been finalized."}
      </p>

      {isSelfService && <MyPayslipsCard refreshKey={refreshKey} />}

      {isHrAdmin && (
        <div className="space-y-6">
          <RunsSection refreshKey={refreshKey} onChanged={bump} />

          <CollapsibleSection title="Compensation">
            <CompensationForm onSaved={bump} />
          </CollapsibleSection>

          <CollapsibleSection title="Settings & Tax Slabs">
            <SettingsAndSlabsSection />
          </CollapsibleSection>
        </div>
      )}

      {!isHrAdmin && !isSelfService && (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
          Nothing to show for your role here.
        </div>
      )}
    </div>
  );
}
