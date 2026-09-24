import { FormEvent, useEffect, useState } from "react";
import type {
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
 * renders this for anyone else. Sets one employee's rate as of a given
 * date (`SetCompensationRequest`); the service keeps every prior rate
 * around with `effectiveTo` closed off, so this is additive, not an
 * edit-in-place.
 */
export function CompensationForm({ onSaved }: { onSaved: () => void }) {
  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [employeeId, setEmployeeId] = useState("");
  const [monthlySalary, setMonthlySalary] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [history, setHistory] = useState<CompensationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.listEmployees().then(setEmployees).catch(() => {
      // A failed employee-list fetch shouldn't block the rest of the form.
    });
  }, []);

  useEffect(() => {
    if (!employeeId) {
      setHistory(null);
      return;
    }
    api
      .getCompensationHistory(employeeId)
      .then(setHistory)
      .catch(() => setHistory(null));
  }, [employeeId]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.setCompensation({
        employeeId,
        monthlySalary: Number(monthlySalary),
        effectiveFrom,
      });
      const refreshed = await api.getCompensationHistory(employeeId);
      setHistory(refreshed);
      setMonthlySalary("");
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

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Monthly salary (PKR)</label>
            <input
              type="number"
              min="0"
              step="1"
              required
              value={monthlySalary}
              onChange={(e) => setMonthlySalary(e.target.value)}
              className={inputClass}
            />
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
        </div>

        {error && <div className="text-danger text-sm">{error}</div>}

        <button
          type="submit"
          disabled={submitting || !employeeId}
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Set compensation"}
        </button>
      </form>

      {history && (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-label-tertiary">Rate history</div>
          {history.length === 0 ? (
            <div className="text-sm text-label-tertiary">No compensation set for this employee yet.</div>
          ) : (
            history.map((c) => (
              <div key={c.id} className="flex justify-between text-sm bg-card rounded-lg px-3 py-2 shadow-sm">
                <span>
                  {c.effectiveFrom} {c.effectiveTo ? `– ${c.effectiveTo}` : "– current"}
                </span>
                <span className="font-mono font-semibold">{pkr.format(c.monthlySalary)}/mo</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
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
