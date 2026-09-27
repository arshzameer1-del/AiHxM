import { FormEvent, useEffect, useState } from "react";
import type {
  CompensationComponentView,
  CompensationView,
  EmployeeView,
  PayrollSettingsView,
  SocialSecurityScheme,
  TaxSlabView,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { pkr } from "./payrollLabels";

const inputClass =
  "w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent";
const labelClass = "block text-sm font-medium mb-1";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * `payroll.manage.all` (hr_admin) territory only — PayrollPage never
 * renders this for anyone else.
 *
 * Payroll Enterprise Gap Analysis & Roadmap, Phase P1 — compensation is a
 * real component model now (Basic Salary + named allowances), not one
 * flat monthly figure: one numeric input per active catalog component,
 * submitted together as of one effective date
 * (`SetEmployeeCompensationComponentsRequest`). Each component keeps its
 * own effective-dated history — `setCompensationComponents()` supersedes,
 * never overwrites.
 */
export function CompensationForm({ onSaved }: { onSaved: () => void }) {
  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [components, setComponents] = useState<CompensationComponentView[]>([]);
  const [employeeId, setEmployeeId] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [history, setHistory] = useState<CompensationView[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showAddComponent, setShowAddComponent] = useState(false);

  useEffect(() => {
    api.listEmployees().then(setEmployees).catch(() => {
      // A failed employee-list fetch shouldn't block the rest of the form.
    });
    api.listCompensationComponents().then(setComponents).catch(() => {
      // Falls back to an empty catalog — the "Add component" form still works.
    });
  }, []);

  useEffect(() => {
    if (!employeeId) {
      setHistory(null);
      setAmounts({});
      return;
    }
    api
      .getCurrentCompensation(employeeId)
      .then((current) => {
        const next: Record<string, string> = {};
        for (const c of current.components) next[c.componentId] = String(c.amount);
        setAmounts(next);
      })
      .catch(() => setAmounts({}));
    if (showHistory) {
      api.getCompensationHistory(employeeId).then(setHistory).catch(() => setHistory(null));
    }
  }, [employeeId, showHistory]);

  const activeComponents = components.filter((c) => c.isActive);
  const total = activeComponents.reduce((sum, c) => sum + (Number(amounts[c.id]) || 0), 0);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.setCompensationComponents({
        employeeId,
        effectiveFrom,
        components: activeComponents.map((c) => ({ componentId: c.id, amount: Number(amounts[c.id]) || 0 })),
      });
      if (showHistory) {
        const refreshed = await api.getCompensationHistory(employeeId);
        setHistory(refreshed);
      }
      setEffectiveFrom("");
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Could not set this employee's compensation."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="space-y-4 bg-black/5 rounded-lg p-4">
        <div>
          <label className={labelClass}>Employee</label>
          <select required value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className={inputClass}>
            <option value="">Select an employee…</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.firstName} {emp.lastName} ({emp.employeeNumber})
              </option>
            ))}
          </select>
        </div>

        {employeeId && (
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
            <div className="grid grid-cols-[1fr_auto] gap-3 items-center pt-2 border-t border-black/10">
              <span className="text-sm font-semibold">Total monthly</span>
              <span className="font-mono font-semibold w-40 text-right">{pkr.format(total)}</span>
            </div>
          </div>
        )}

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
            disabled={submitting || !employeeId}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Save compensation"}
          </button>
          {employeeId && (
            <button
              type="button"
              onClick={() => setShowHistory((s) => !s)}
              className="text-xs font-semibold text-accent hover:underline"
            >
              {showHistory ? "Hide history" : "History"}
            </button>
          )}
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
              <div key={c.id} className="flex justify-between text-sm bg-card rounded-lg px-3 py-2 shadow-sm">
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
  );
}

/** A tenant's compensation-component catalog is theirs to extend — Phase
 * P1 deliberately doesn't hard-code the 6 starter components as the only
 * ones a company can ever pay. New components default to taxable=true
 * (see `CompensationComponentView`'s own doc comment for why). */
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

const SOCIAL_SECURITY_SCHEMES: SocialSecurityScheme[] = ["none", "pessi", "sessi"];
const SOCIAL_SECURITY_LABELS: Record<SocialSecurityScheme, string> = {
  none: "None",
  pessi: "PESSI (Punjab)",
  sessi: "SESSI (Sindh)",
};

/**
 * Every rate/base here is tenant-editable DATA (Decision #14), never a
 * hardcoded constant — see `claude/statutory-payroll-rates-pakistan.md`
 * for exactly which of these still need direct accountant confirmation
 * before this tenant runs real payroll on them.
 */
export function PayrollSettingsForm({
  settings,
  onSaved,
}: {
  settings: PayrollSettingsView;
  onSaved: (updated: PayrollSettingsView) => void;
}) {
  const [eobiEmployeeRatePercent, setEobiEmployeeRatePercent] = useState(String(settings.eobiEmployeeRatePercent));
  const [eobiEmployerRatePercent, setEobiEmployerRatePercent] = useState(String(settings.eobiEmployerRatePercent));
  const [eobiWageBase, setEobiWageBase] = useState(String(settings.eobiWageBase));
  const [socialSecurityScheme, setSocialSecurityScheme] = useState<SocialSecurityScheme>(settings.socialSecurityScheme);
  const [socialSecurityEmployerRatePercent, setSocialSecurityEmployerRatePercent] = useState(
    String(settings.socialSecurityEmployerRatePercent)
  );
  const [socialSecurityWageCeiling, setSocialSecurityWageCeiling] = useState(
    settings.socialSecurityWageCeiling === null ? "" : String(settings.socialSecurityWageCeiling)
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const updated = await api.updatePayrollSettings({
        eobiEmployeeRatePercent: Number(eobiEmployeeRatePercent),
        eobiEmployerRatePercent: Number(eobiEmployerRatePercent),
        eobiWageBase: Number(eobiWageBase),
        socialSecurityScheme,
        socialSecurityEmployerRatePercent: Number(socialSecurityEmployerRatePercent),
        socialSecurityWageCeiling: socialSecurityWageCeiling === "" ? null : Number(socialSecurityWageCeiling),
      });
      onSaved(updated);
    } catch (err) {
      setError(errorMessage(err, "Could not save payroll settings."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-black/5 rounded-lg p-4">
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className={labelClass}>EOBI employee rate (%)</label>
          <input
            type="number"
            step="0.01"
            required
            value={eobiEmployeeRatePercent}
            onChange={(e) => setEobiEmployeeRatePercent(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>EOBI employer rate (%)</label>
          <input
            type="number"
            step="0.01"
            required
            value={eobiEmployerRatePercent}
            onChange={(e) => setEobiEmployerRatePercent(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>EOBI wage base (PKR)</label>
          <input
            type="number"
            step="1"
            required
            value={eobiWageBase}
            onChange={(e) => setEobiWageBase(e.target.value)}
            className={inputClass}
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className={labelClass}>Social security scheme</label>
          <select
            value={socialSecurityScheme}
            onChange={(e) => setSocialSecurityScheme(e.target.value as SocialSecurityScheme)}
            className={inputClass}
          >
            {SOCIAL_SECURITY_SCHEMES.map((s) => (
              <option key={s} value={s}>
                {SOCIAL_SECURITY_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Employer rate (%)</label>
          <input
            type="number"
            step="0.01"
            required
            value={socialSecurityEmployerRatePercent}
            onChange={(e) => setSocialSecurityEmployerRatePercent(e.target.value)}
            className={inputClass}
            disabled={socialSecurityScheme === "none"}
          />
        </div>
        <div>
          <label className={labelClass}>Wage ceiling (PKR, optional)</label>
          <input
            type="number"
            step="1"
            value={socialSecurityWageCeiling}
            onChange={(e) => setSocialSecurityWageCeiling(e.target.value)}
            className={inputClass}
            disabled={socialSecurityScheme === "none"}
          />
        </div>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      <button
        type="submit"
        disabled={submitting}
        className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
      >
        {submitting ? "Saving…" : "Save settings"}
      </button>
    </form>
  );
}

type SlabDraft = { minAnnualIncome: string; maxAnnualIncome: string; baseTax: string; ratePercent: string };

function slabsToDraft(slabs: TaxSlabView[]): SlabDraft[] {
  return slabs
    .slice()
    .sort((a, b) => a.minAnnualIncome - b.minAnnualIncome)
    .map((s) => ({
      minAnnualIncome: String(s.minAnnualIncome),
      maxAnnualIncome: s.maxAnnualIncome === null ? "" : String(s.maxAnnualIncome),
      baseTax: String(s.baseTax),
      ratePercent: String(s.ratePercent),
    }));
}

/**
 * `SetTaxSlabsRequest` replaces the tenant's ENTIRE bracket table in one
 * call (shared-types' own comment on that type explains why: a partial
 * edit to a progressive table can leave income gaps/overlaps that are
 * much harder to validate piecemeal) — so this form edits the whole
 * table as one unit and submits it as one unit, never a per-row PATCH.
 */
export function TaxSlabsForm({ slabs, onSaved }: { slabs: TaxSlabView[]; onSaved: (updated: TaxSlabView[]) => void }) {
  const [rows, setRows] = useState<SlabDraft[]>(slabsToDraft(slabs));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function updateRow(index: number, patch: Partial<SlabDraft>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((prev) => [...prev, { minAnnualIncome: "", maxAnnualIncome: "", baseTax: "0", ratePercent: "0" }]);
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const updated = await api.setTaxSlabs({
        slabs: rows.map((r) => ({
          minAnnualIncome: Number(r.minAnnualIncome),
          maxAnnualIncome: r.maxAnnualIncome === "" ? null : Number(r.maxAnnualIncome),
          baseTax: Number(r.baseTax),
          ratePercent: Number(r.ratePercent),
        })),
      });
      setRows(slabsToDraft(updated));
      onSaved(updated);
    } catch (err) {
      setError(errorMessage(err, "Could not save the tax slab table."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 bg-black/5 rounded-lg p-4">
      <div className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2 text-xs font-semibold uppercase tracking-wide text-label-tertiary px-1">
        <span>Min annual income</span>
        <span>Max annual income</span>
        <span>Base tax</span>
        <span>Rate (%)</span>
        <span />
      </div>
      {rows.map((row, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2 items-center">
          <input
            type="number"
            required
            value={row.minAnnualIncome}
            onChange={(e) => updateRow(i, { minAnnualIncome: e.target.value })}
            className={inputClass}
          />
          <input
            type="number"
            placeholder="Uncapped"
            value={row.maxAnnualIncome}
            onChange={(e) => updateRow(i, { maxAnnualIncome: e.target.value })}
            className={inputClass}
          />
          <input
            type="number"
            required
            value={row.baseTax}
            onChange={(e) => updateRow(i, { baseTax: e.target.value })}
            className={inputClass}
          />
          <input
            type="number"
            step="0.01"
            required
            value={row.ratePercent}
            onChange={(e) => updateRow(i, { ratePercent: e.target.value })}
            className={inputClass}
          />
          <button
            type="button"
            onClick={() => removeRow(i)}
            className="text-xs font-medium text-label-tertiary hover:text-danger px-2"
          >
            Remove
          </button>
        </div>
      ))}

      <div className="flex items-center gap-4 pt-1">
        <button type="button" onClick={addRow} className="text-sm font-semibold text-accent hover:underline">
          Add bracket
        </button>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      <button
        type="submit"
        disabled={submitting || rows.length === 0}
        className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
      >
        {submitting ? "Saving…" : "Save tax slabs"}
      </button>
    </form>
  );
}

export function CreateRunForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.createPayrollRun({ periodStart, periodEnd });
      onCreated();
    } catch (err) {
      setError(errorMessage(err, "Could not create this payroll run."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-black/5 rounded-lg p-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Period start</label>
          <input
            type="date"
            required
            value={periodStart}
            onChange={(e) => setPeriodStart(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Period end</label>
          <input
            type="date"
            required
            value={periodEnd}
            onChange={(e) => setPeriodEnd(e.target.value)}
            className={inputClass}
          />
        </div>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {submitting ? "Creating…" : "Create run"}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}
