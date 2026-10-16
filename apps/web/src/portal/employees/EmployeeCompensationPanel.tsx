import { LoadingNote } from "../shared/PageChrome";
import { FormEvent, useEffect, useState } from "react";
import type { CompensationCalculationType, CompensationComponentType, CompensationComponentView, CompensationView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

const inputClass =
  "w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent";
const labelClass = "block text-sm font-medium mb-1";

const pkr = new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", maximumFractionDigits: 0 });

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** What the input of a component shows: the typed amount, the percentage or the unit count - by calculation type. */
function inputValueOf(c: CompensationView): string {
  if (c.calculationType === "percentage") return c.percentage !== null ? String(c.percentage) : "";
  if (c.calculationType === "per_unit") return c.units !== null ? String(c.units) : "";
  if (c.calculationType === "formula") return "";
  return String(c.enteredAmount ?? c.amount);
}

function hintFor(c: CompensationComponentView): string {
  switch (c.calculationType) {
    case "percentage":
      return `% of ${c.basisType === "basic_salary" ? "basic salary" : c.basisType === "gross_fixed_earnings" ? "fixed earnings" : "another component"}`;
    case "per_unit":
      return `${c.unitRate !== null ? pkr.format(c.unitRate) : "rate"} per ${c.unitLabel ?? "unit"} - enter the number of ${c.unitLabel ?? "units"}`;
    case "formula":
      return "calculated from a formula";
    case "threshold":
      return "paid when the threshold is met";
    default:
      return c.componentType === "deduction" ? "deducted every month" : c.componentType === "employer_contribution" ? "employer cost, not paid to the employee" : "per month";
  }
}

/** The request entry of a component: nothing for a formula (it follows its inputs) or an empty derived figure. */
function entryFor(c: CompensationComponentView, typed: string | undefined): Array<{ componentId: string; amount?: number; percentage?: number; units?: number }> {
  if (c.calculationType === "formula") return [];
  const value = typed === undefined || typed === "" ? null : Number(typed);
  if (c.calculationType === "percentage") return value === null ? [] : [{ componentId: c.id, percentage: value }];
  if (c.calculationType === "per_unit") return value === null ? [] : [{ componentId: c.id, units: value }];
  return [{ componentId: c.id, amount: value ?? 0 }];
}

/**
 * Core Employee master data (SAP IT0008/IT0014-equivalent) — moved here
 * from the standalone Payroll page (2026-09-27, kumail's own architecture
 * correction: "why compensation is maintained in payroll i think this is
 * master data in employee ... follow same concept of infotype 14/15 and
 * for off-cycle 267"). Recurring compensation is a fact ABOUT this one
 * employee, edited from their own profile — no employee picker, unlike
 * the old Payroll-page widget this replaces.
 *
 * Still a real component model (Basic Salary + named allowances), not one
 * flat monthly figure: one numeric input per active catalog component,
 * submitted together as of one effective date. Each component keeps its
 * own effective-dated history — `setCompensationComponents()` supersedes,
 * never overwrites. A future IT0015 ("Additional Payments" — one-time)
 * and IT0267 ("Additional Off-Cycle Payments") entity will live alongside
 * this one, Core-Employee-owned the same way, once Payroll's Phase P3/P4
 * build them.
 */
export function EmployeeCompensationPanel({ employeeId, canManage }: { employeeId: string; canManage: boolean }) {
  const [components, setComponents] = useState<CompensationComponentView[]>([]);
  // the figure typed per component: the amount (fixed / threshold), the percentage or the unit count - by its calculation type
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [currentAmounts, setCurrentAmounts] = useState<Record<string, number>>({});
  const [payFrequency, setPayFrequency] = useState<"monthly" | "annual">("monthly");
  const [changeReasonNote, setChangeReasonNote] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [totalMonthly, setTotalMonthly] = useState<number | null>(null);
  const [history, setHistory] = useState<CompensationView[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showAddComponent, setShowAddComponent] = useState(false);

  function loadCurrent() {
    api
      .getCurrentCompensation(employeeId)
      .then((current) => {
        const next: Record<string, string> = {};
        for (const c of current.components) next[c.componentId] = inputValueOf(c);
        setAmounts(next);
        setCurrentAmounts(Object.fromEntries(current.components.map((c) => [c.componentId, c.amount])));
        setTotalMonthly(current.totalMonthly);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) return; // no employee record for this component yet
        setLoadError(errorMessage(err, "Could not load this employee's compensation."));
      });
  }

  useEffect(() => {
    api.listCompensationComponents().then(setComponents).catch(() => {
      // Falls back to an empty catalog — the "Add component" form still works.
    });
    loadCurrent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId]);

  useEffect(() => {
    if (!showHistory) return;
    api.getCompensationHistory(employeeId).then(setHistory).catch(() => setHistory(null));
  }, [employeeId, showHistory]);

  // a non-cash benefit is recorded on its own pages, never as a pay amount; derived pay is shown but calculated
  const activeComponents = components.filter((c) => c.isActive && c.componentType !== "non_cash_benefit");
  const total = activeComponents
    .filter((c) => c.componentType === "earning" || c.componentType === "reimbursement" || c.componentType === "shift_premium")
    .reduce((sum, c) => sum + (c.calculationType === "fixed" || c.calculationType === "threshold" ? (Number(amounts[c.id]) || 0) / (payFrequency === "annual" ? 12 : 1) : currentAmounts[c.id] ?? 0), 0);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const updated = await api.setCompensationComponents({
        employeeId,
        effectiveFrom,
        components: activeComponents.flatMap((c) => entryFor(c, amounts[c.id])),
        ...(payFrequency === "annual" ? { payFrequency } : {}),
        ...(changeReasonNote.trim() ? { changeReasonNote: changeReasonNote.trim() } : {}),
      });
      setTotalMonthly(updated.totalMonthly);
      if (showHistory) {
        const refreshed = await api.getCompensationHistory(employeeId);
        setHistory(refreshed);
      }
      setEffectiveFrom("");
      setChangeReasonNote("");
      loadCurrent();
    } catch (err) {
      setError(errorMessage(err, "Could not set this employee's compensation."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="bg-card rounded-card p-5 shadow-sm mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">Compensation</h2>
        {totalMonthly !== null && <span className="text-sm font-mono font-semibold">{pkr.format(totalMonthly)}/mo</span>}
      </div>

      {loadError && <p className="text-xs text-danger mb-2">{loadError}</p>}

      {!canManage ? (
        totalMonthly === null ? (
          <p className="text-sm text-label-tertiary">No compensation set yet.</p>
        ) : (
          <div className="space-y-1">
            {activeComponents
              .filter((c) => currentAmounts[c.id])
              .map((c) => (
                <div key={c.id} className="flex justify-between text-sm">
                  <span>{c.name}</span>
                  <span className="font-mono">{pkr.format(currentAmounts[c.id])}/mo</span>
                </div>
              ))}
          </div>
        )
      ) : (
        <div className="space-y-4">
          <form onSubmit={handleSubmit} className="space-y-4 bg-black/5 rounded-lg p-4">
            <div className="space-y-2">
              {activeComponents.map((c) => (
                <div key={c.id} className="grid grid-cols-[1fr_auto] gap-3 items-center">
                  <label className="text-sm" htmlFor={`comp-${c.id}`}>
                    {c.name}
                    {!c.isTaxable && c.componentType === "earning" && <span className="text-label-tertiary text-xs ml-1">(non-taxable)</span>}
                    <span className="block text-[11px] text-label-tertiary">{hintFor(c)}</span>
                  </label>
                  {c.calculationType === "formula" ? (
                    <span className="font-mono text-sm w-40 text-right">{currentAmounts[c.id] !== undefined ? pkr.format(currentAmounts[c.id]) : "Calculated"}</span>
                  ) : (
                    <input
                      id={`comp-${c.id}`}
                      type="number"
                      min="0"
                      step={c.calculationType === "percentage" ? "0.01" : "1"}
                      value={amounts[c.id] ?? (c.calculationType === "percentage" && c.defaultPercentage !== null ? String(c.defaultPercentage) : "")}
                      onChange={(e) => setAmounts((prev) => ({ ...prev, [c.id]: e.target.value }))}
                      className={`${inputClass} w-40 text-right`}
                      placeholder="0"
                    />
                  )}
                </div>
              ))}
              {activeComponents.length === 0 && <p className="text-sm text-label-tertiary">Loading components…</p>}
              <div className="grid grid-cols-[1fr_auto] gap-3 items-center pt-2 border-t border-black/10">
                <span className="text-sm font-semibold">Total monthly</span>
                <span className="font-mono font-semibold w-40 text-right">{pkr.format(total)}</span>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={labelClass} htmlFor="comp-frequency">Figures typed as</label>
                <select id="comp-frequency" value={payFrequency} onChange={(e) => setPayFrequency(e.target.value as "monthly" | "annual")} className={inputClass}>
                  <option value="monthly">Monthly amounts</option>
                  <option value="annual">Annual amounts (paid as one-twelfth a month)</option>
                </select>
              </div>
              <div>
                <label className={labelClass} htmlFor="comp-reason">Reason for this change</label>
                <input id="comp-reason" value={changeReasonNote} onChange={(e) => setChangeReasonNote(e.target.value)} placeholder="e.g. Annual increment" className={inputClass} />
              </div>
            </div>

            <div>
              <label className={labelClass}>Effective from</label>
              <input
                type="date"
                required
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
                className={inputClass}
              />
            </div>

            {error && <div className="text-danger text-sm">{error}</div>}

            <div className="flex items-center gap-4">
              <button
                type="submit"
                disabled={submitting}
                className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
              >
                {submitting ? "Saving…" : "Save compensation"}
              </button>
              <button
                type="button"
                onClick={() => setShowHistory((s) => !s)}
                className="text-xs font-semibold text-accent hover:underline"
              >
                {showHistory ? "Hide history" : "History"}
              </button>
            </div>
          </form>

          {showHistory && (
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-label-tertiary">Compensation history</div>
              {!history ? (
                <LoadingNote />
              ) : history.length === 0 ? (
                <div className="text-sm text-label-tertiary">No compensation set for this employee yet.</div>
              ) : (
                history.map((c) => (
                  <div key={c.id} className="flex justify-between text-sm bg-black/5 rounded-lg px-3 py-2">
                    <span>
                      {c.componentName} — {c.effectiveFrom} {c.effectiveTo ? `– ${c.effectiveTo}` : "– current"}
                    </span>
                    <span className="font-mono font-semibold">
                      {pkr.format(c.amount)}/mo
                      {c.payFrequency === "annual" && c.enteredAmount !== null ? <span className="text-label-tertiary font-normal"> (from {pkr.format(c.enteredAmount)}/yr)</span> : null}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}

          <div>
            {!showAddComponent ? (
              <button
                type="button"
                onClick={() => setShowAddComponent(true)}
                className="text-xs font-semibold text-accent hover:underline"
              >
                + Add a custom compensation component
              </button>
            ) : (
              <AddComponentForm
                onAdded={(c) => {
                  setComponents((prev) => [...prev, c]);
                  setShowAddComponent(false);
                }}
                onCancel={() => setShowAddComponent(false)}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** A tenant's compensation-component catalog is theirs to extend — Phase
 * P1 deliberately doesn't hard-code the 6 starter components as the only
 * ones a company can ever pay. New components default to taxable=true
 * (see `CompensationComponentView`'s own doc comment for why). Adding a
 * component here adds it for every employee's form (it's a company-wide
 * catalog), not just this one. */
function AddComponentForm({ onAdded, onCancel }: { onAdded: (c: CompensationComponentView) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [isTaxable, setIsTaxable] = useState(true);
  const [componentType, setComponentType] = useState<CompensationComponentType>("earning");
  const [calculationType, setCalculationType] = useState<CompensationCalculationType>("fixed");
  const [defaultPercentage, setDefaultPercentage] = useState("");
  const [unitRate, setUnitRate] = useState("");
  const [unitLabel, setUnitLabel] = useState("");
  const [capAmount, setCapAmount] = useState("");
  const [prorationNone, setProrationNone] = useState(false);
  const [countsTowardEobi, setCountsTowardEobi] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const payType = componentType === "earning" || componentType === "reimbursement" || componentType === "shift_premium";
  const num = (v: string) => (v.trim() === "" ? undefined : Number(v));

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const created = await api.createCompensationComponent({
        name,
        componentType,
        isTaxable: payType ? isTaxable : false,
        calculationType,
        ...(calculationType === "percentage" ? { basisType: "basic_salary" as const, defaultPercentage: num(defaultPercentage) } : {}),
        ...(calculationType === "per_unit" ? { unitRate: num(unitRate), unitLabel: unitLabel.trim() || undefined } : {}),
        ...(capAmount.trim() ? { capAmount: Number(capAmount) } : {}),
        ...(prorationNone ? { prorationMode: "none" as const } : {}),
        ...(payType && countsTowardEobi ? { countsTowardEobiBase: true } : {}),
      });
      onAdded(created);
    } catch (err) {
      setError(errorMessage(err, "Could not add this component."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-black/5 rounded-lg p-3 mt-2">
      <div className="sm:col-span-2">
        <label className={labelClass} htmlFor="new-comp-name">Component name</label>
        <input id="new-comp-name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Fuel Allowance" className={inputClass} />
      </div>
      <div>
        <label className={labelClass} htmlFor="new-comp-type">Kind</label>
        <select id="new-comp-type" value={componentType} onChange={(e) => setComponentType(e.target.value as CompensationComponentType)} className={inputClass}>
          <option value="earning">Earning</option>
          <option value="deduction">Deduction</option>
          <option value="employer_contribution">Employer contribution</option>
          <option value="reimbursement">Reimbursement</option>
          <option value="shift_premium">Shift premium</option>
          <option value="non_cash_benefit">Non-cash benefit</option>
        </select>
      </div>
      <div>
        <label className={labelClass} htmlFor="new-comp-calc">How it is worked out</label>
        <select id="new-comp-calc" value={calculationType} onChange={(e) => setCalculationType(e.target.value as CompensationCalculationType)} className={inputClass}>
          <option value="fixed">Fixed amount</option>
          <option value="percentage">Percentage of basic salary</option>
          <option value="per_unit">Rate per unit</option>
        </select>
      </div>
      {calculationType === "percentage" && (
        <div>
          <label className={labelClass} htmlFor="new-comp-pct">Default percentage</label>
          <input id="new-comp-pct" type="number" min="0" step="0.01" value={defaultPercentage} onChange={(e) => setDefaultPercentage(e.target.value)} className={inputClass} />
        </div>
      )}
      {calculationType === "per_unit" && (
        <>
          <div>
            <label className={labelClass} htmlFor="new-comp-rate">Rate per unit</label>
            <input id="new-comp-rate" type="number" min="0" step="1" value={unitRate} onChange={(e) => setUnitRate(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className={labelClass} htmlFor="new-comp-unit">Unit name</label>
            <input id="new-comp-unit" value={unitLabel} onChange={(e) => setUnitLabel(e.target.value)} placeholder="e.g. shift" className={inputClass} />
          </div>
        </>
      )}
      <div>
        <label className={labelClass} htmlFor="new-comp-cap">Monthly cap (optional)</label>
        <input id="new-comp-cap" type="number" min="0" step="1" value={capAmount} onChange={(e) => setCapAmount(e.target.value)} className={inputClass} />
      </div>
      <div className="sm:col-span-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        {payType && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={isTaxable} onChange={(e) => setIsTaxable(e.target.checked)} />
            Taxable
          </label>
        )}
        {payType && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={countsTowardEobi} onChange={(e) => setCountsTowardEobi(e.target.checked)} />
            Counts toward the EOBI base
          </label>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={prorationNone} onChange={(e) => setProrationNone(e.target.checked)} />
          Paid in full even for part of a month
        </label>
      </div>
      <div className="sm:col-span-2 flex items-center gap-3">
        <button type="submit" disabled={submitting || !name.trim()} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">
          {submitting ? "Adding…" : "Add"}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-label-secondary">
          Cancel
        </button>
      </div>
      {error && <div className="text-danger text-sm sm:col-span-2">{error}</div>}
    </form>
  );
}
