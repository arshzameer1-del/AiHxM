import { FormEvent, useEffect, useState } from "react";
import type { CompensationComponentView, CompensationView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

const inputClass =
  "w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent";
const labelClass = "block text-sm font-medium mb-1";

const pkr = new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", maximumFractionDigits: 0 });

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
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
  const [amounts, setAmounts] = useState<Record<string, string>>({});
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
        for (const c of current.components) next[c.componentId] = String(c.amount);
        setAmounts(next);
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

  const activeComponents = components.filter((c) => c.isActive);
  const total = activeComponents.reduce((sum, c) => sum + (Number(amounts[c.id]) || 0), 0);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const updated = await api.setCompensationComponents({
        employeeId,
        effectiveFrom,
        components: activeComponents.map((c) => ({ componentId: c.id, amount: Number(amounts[c.id]) || 0 })),
      });
      setTotalMonthly(updated.totalMonthly);
      if (showHistory) {
        const refreshed = await api.getCompensationHistory(employeeId);
        setHistory(refreshed);
      }
      setEffectiveFrom("");
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
              .filter((c) => amounts[c.id])
              .map((c) => (
                <div key={c.id} className="flex justify-between text-sm">
                  <span>{c.name}</span>
                  <span className="font-mono">{pkr.format(Number(amounts[c.id]))}/mo</span>
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
                  <label className="text-sm">
                    {c.name}
                    {!c.isTaxable && <span className="text-label-tertiary text-xs ml-1">(non-taxable)</span>}
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={amounts[c.id] ?? ""}
                    onChange={(e) => setAmounts((prev) => ({ ...prev, [c.id]: e.target.value }))}
                    className={`${inputClass} w-40 text-right`}
                    placeholder="0"
                  />
                </div>
              ))}
              {activeComponents.length === 0 && <p className="text-sm text-label-tertiary">Loading components…</p>}
              <div className="grid grid-cols-[1fr_auto] gap-3 items-center pt-2 border-t border-black/10">
                <span className="text-sm font-semibold">Total monthly</span>
                <span className="font-mono font-semibold w-40 text-right">{pkr.format(total)}</span>
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
                <div className="text-sm text-label-tertiary">Loading…</div>
              ) : history.length === 0 ? (
                <div className="text-sm text-label-tertiary">No compensation set for this employee yet.</div>
              ) : (
                history.map((c) => (
                  <div key={c.id} className="flex justify-between text-sm bg-black/5 rounded-lg px-3 py-2">
                    <span>
                      {c.componentName} — {c.effectiveFrom} {c.effectiveTo ? `– ${c.effectiveTo}` : "– current"}
                    </span>
                    <span className="font-mono font-semibold">{pkr.format(c.amount)}/mo</span>
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
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const created = await api.createCompensationComponent({ name, isTaxable });
      onAdded(created);
    } catch (err) {
      setError(errorMessage(err, "Could not add this component."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-end gap-3 bg-black/5 rounded-lg p-3 mt-2">
      <div className="flex-1">
        <label className={labelClass}>Component name</label>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Fuel Allowance"
          className={inputClass}
        />
      </div>
      <label className="flex items-center gap-2 text-sm pb-2">
        <input type="checkbox" checked={isTaxable} onChange={(e) => setIsTaxable(e.target.checked)} />
        Taxable
      </label>
      <button
        type="submit"
        disabled={submitting || !name.trim()}
        className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
      >
        {submitting ? "Adding…" : "Add"}
      </button>
      <button type="button" onClick={onCancel} className="text-sm font-medium text-label-secondary pb-2">
        Cancel
      </button>
      {error && <div className="text-danger text-sm">{error}</div>}
    </form>
  );
}
