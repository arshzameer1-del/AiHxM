import { FormEvent, useEffect, useState } from "react";
import type {
  AdditionalPaymentType,
  EmployeeOffCyclePaymentView,
  EmployeeView,
  OffCycleReason,
  PayrollAreaView,
  PayrollRunType,
  PayrollRunView,
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

// Compensation editing moved to Core Employee's own "Compensation &
// Assets" tab (2026-09-27, kumail's own architecture correction — see
// EmployeeCompensationPanel in
// apps/web/src/portal/employees/EmployeeCompensationPanel.tsx). Recurring
// pay is employee master data, maintained per-employee the same way SAP's
// IT0008/IT0014 infotypes work — not a standalone Payroll-page widget with
// its own employee picker.

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

/**
 * Payroll Areas (0101_payroll_areas.sql): a run may optionally target one
 * active Payroll Area — only that area's employees are calculated. The
 * default stays company-wide (`payrollAreaId` omitted/null), exactly as
 * every run before Payroll Areas existed. PayrollService.createRun() owns
 * the overlap rules (a company-wide run and an area run can't both exist
 * for the same period), so its 409 message is surfaced as-is.
 */
const OFF_CYCLE_REASONS: OffCycleReason[] = ["bonus", "arrears", "final_settlement", "other"];
export const OFF_CYCLE_REASON_LABELS: Record<OffCycleReason, string> = {
  bonus: "Bonus",
  arrears: "Arrears",
  final_settlement: "Final Settlement (termination)",
  other: "Other",
};

/**
 * Payroll Enterprise Gap Analysis Phase P4 — `runType`/`offCycleReason`/
 * `targetEmployeeId` added to the original regular-run form. A `regular`
 * run is unchanged (every field below this toggle stays hidden and the
 * request carries none of the three off-cycle fields, exactly as before
 * this phase). `final_settlement` forces a single target employee — a
 * batch settlement makes no sense, PayrollService.createRun() itself
 * refuses one without a target.
 */
export function CreateRunForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [payrollAreaId, setPayrollAreaId] = useState("");
  const [areas, setAreas] = useState<PayrollAreaView[]>([]);
  const [runType, setRunType] = useState<PayrollRunType>("regular");
  const [offCycleReason, setOffCycleReason] = useState<OffCycleReason>("bonus");
  const [targetEmployeeId, setTargetEmployeeId] = useState("");
  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // Active areas only — PayrollService.createRun() refuses an inactive
    // one. A failure here just leaves "Company-wide" as the only choice.
    api.listPayrollAreas().then(setAreas).catch(() => setAreas([]));
    api.listEmployees().then(setEmployees).catch(() => setEmployees([]));
  }, []);

  const selectedArea = areas.find((a) => a.id === payrollAreaId);
  const isOffCycle = runType === "off_cycle";
  const requiresTarget = isOffCycle && offCycleReason === "final_settlement";
  // Final Settlement only makes sense against an already-terminated
  // employee (PayrollService.createRun() enforces this server-side too,
  // with a clearer error) — narrowing the picker here just saves a
  // round-trip for the common mistake of picking someone still active.
  const employeeOptions = requiresTarget ? employees.filter((e) => e.terminationDate) : employees;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.createPayrollRun({
        periodStart,
        periodEnd,
        payrollAreaId: payrollAreaId || null,
        ...(isOffCycle
          ? { runType, offCycleReason, ...(targetEmployeeId ? { targetEmployeeId } : {}) }
          : {}),
      });
      onCreated();
    } catch (err) {
      setError(errorMessage(err, "Could not create this payroll run."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-black/5 rounded-lg p-4">
      <div>
        <label className={labelClass}>Run type</label>
        <select
          value={runType}
          onChange={(e) => setRunType(e.target.value as PayrollRunType)}
          className={inputClass}
        >
          <option value="regular">Regular (the normal monthly/weekly run)</option>
          <option value="off_cycle">Off-cycle (bonus, arrears, or final settlement)</option>
        </select>
      </div>

      {isOffCycle && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Reason</label>
            <select
              value={offCycleReason}
              onChange={(e) => {
                setOffCycleReason(e.target.value as OffCycleReason);
                setTargetEmployeeId("");
              }}
              className={inputClass}
            >
              {OFF_CYCLE_REASONS.map((r) => (
                <option key={r} value={r}>
                  {OFF_CYCLE_REASON_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>{requiresTarget ? "Employee (required)" : "Employee (optional — leave blank for a batch run)"}</label>
            <select
              required={requiresTarget}
              value={targetEmployeeId}
              onChange={(e) => setTargetEmployeeId(e.target.value)}
              className={inputClass}
            >
              <option value="">{requiresTarget ? "Select…" : "All employees (batch)"}</option>
              {employeeOptions.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.employeeNumber} — {emp.firstName} {emp.lastName}
                  {emp.terminationDate ? ` (terminated ${emp.terminationDate})` : ""}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
      {isOffCycle && (
        <p className="text-xs text-label-tertiary">
          {offCycleReason === "final_settlement"
            ? "This run's period must cover the employee's termination date. Add the gratuity / leave encashment / any other settlement line as an Off-Cycle Payment once the run is created, before calculating it — this platform does not compute those figures itself."
            : "Pays exactly what's added as an Off-Cycle Payment against this run — no regular salary, no loan deduction, no EOBI. Add those payments once the run is created, before calculating it."}
        </p>
      )}

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

      <div>
        <label className={labelClass}>Payroll area</label>
        <select value={payrollAreaId} onChange={(e) => setPayrollAreaId(e.target.value)} className={inputClass}>
          <option value="">Company-wide (all employees)</option>
          {areas.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.code}) — {a.employeeCount} {a.employeeCount === 1 ? "employee" : "employees"}
            </option>
          ))}
        </select>
        <p className="text-xs text-label-tertiary mt-1">
          {selectedArea
            ? `Only employees assigned to ${selectedArea.name} (and employed during the period) are included.`
            : "Everyone employed during the period is included, whatever payroll area they belong to."}
        </p>
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

/**
 * Phase P4 (0113_payroll_off_cycle_runs.sql) — the SAP IT0267-equivalent
 * panel, mirroring `EmployeeAdditionalPaymentsPanel`'s own add/list/cancel
 * pattern but scoped to one off-cycle run (not one employee): payments are
 * listed by `run.id`, not by `employeeId`, since a batch bonus/arrears run
 * queues one row per paid employee against the same run. Rendered inside
 * `RunCard` only while the run is still `off_cycle` and not yet
 * `finalized`/`reversed` — once finalized, `finalizeRun()` has already
 * marked every consumed row and this stops being an editable queue.
 */
export function OffCyclePaymentsPanel({ run, canManage }: { run: PayrollRunView; canManage: boolean }) {
  const [payments, setPayments] = useState<EmployeeOffCyclePaymentView[] | null>(null);
  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  function load() {
    api
      .listEmployeeOffCyclePayments(run.id)
      .then(setPayments)
      .catch((err) => setLoadError(errorMessage(err, "Could not load off-cycle payments.")));
  }

  useEffect(() => {
    load();
    api.listEmployees().then(setEmployees).catch(() => setEmployees([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);

  const employeesById = new Map(employees.map((e) => [e.id, e]));

  async function handleCancel(id: string) {
    try {
      await api.cancelEmployeeOffCyclePayment(id);
      load();
    } catch (err) {
      setLoadError(errorMessage(err, "Could not cancel this payment."));
    }
  }

  const pendingTotal = (payments ?? [])
    .filter((p) => p.status === "pending")
    .reduce((sum, p) => sum + (p.paymentType === "deduction" ? -p.amount : p.amount), 0);

  return (
    <div className="mt-4 pt-4 border-t border-black/5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-xs uppercase tracking-wide text-label-tertiary">Off-Cycle Payments</h3>
        {canManage && !showForm && (
          <button type="button" onClick={() => setShowForm(true)} className="text-xs font-semibold text-accent hover:underline">
            + Add payment
          </button>
        )}
      </div>

      {loadError && <p className="text-xs text-danger mb-2">{loadError}</p>}

      {canManage && showForm && (
        <NewOffCyclePaymentForm
          run={run}
          employees={employees}
          onCreated={() => {
            setShowForm(false);
            load();
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {!payments ? (
        <p className="text-sm text-label-tertiary">Loading…</p>
      ) : payments.length === 0 ? (
        <p className="text-sm text-label-tertiary">
          No off-cycle payments queued yet
          {run.offCycleReason === "final_settlement"
            ? " — add the gratuity / leave encashment / any other settlement line before calculating this run. This platform does not compute those figures itself."
            : ". Calculating this run now would pay nothing."}
        </p>
      ) : (
        <div className="space-y-2">
          {payments.map((p) => {
            const emp = employeesById.get(p.employeeId);
            return (
              <div key={p.id} className="flex items-center justify-between bg-black/5 rounded-lg px-3 py-2 text-sm">
                <div>
                  <div className="font-medium">
                    {p.label}
                    {!p.isTaxable && <span className="text-label-tertiary text-xs ml-1">(non-taxable)</span>}
                  </div>
                  <div className="text-xs text-label-tertiary">
                    {emp ? `${emp.employeeNumber} — ${emp.firstName} ${emp.lastName}` : p.employeeId} · Status:{" "}
                    <span className="font-semibold">{p.status}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`font-mono font-semibold ${p.paymentType === "deduction" ? "text-danger" : ""}`}>
                    {p.paymentType === "deduction" ? "-" : "+"}
                    {pkr.format(p.amount)}
                  </span>
                  {canManage && p.status === "pending" && (
                    <button type="button" onClick={() => handleCancel(p.id)} className="text-xs font-semibold text-danger hover:underline">
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          <div className="flex justify-between text-xs font-semibold pt-1 border-t border-black/5">
            <span className="text-label-tertiary">Pending total</span>
            <span className="font-mono">{pkr.format(pendingTotal)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function NewOffCyclePaymentForm({
  run,
  employees,
  onCreated,
  onCancel,
}: {
  run: PayrollRunView;
  employees: EmployeeView[];
  onCreated: () => void;
  onCancel: () => void;
}) {
  // A `final_settlement` (or a single-employee bonus/arrears) run already
  // has a fixed `targetEmployeeId` — the form fixes the employee instead of
  // offering a picker, since PayrollService's own off-cycle payments service
  // would otherwise accept a payment for someone this run was never scoped
  // to pay. A batch run (`targetEmployeeId` null) still needs the picker.
  const fixedEmployee = run.targetEmployeeId ? employees.find((e) => e.id === run.targetEmployeeId) : undefined;
  const [employeeId, setEmployeeId] = useState(run.targetEmployeeId ?? "");
  const [paymentType, setPaymentType] = useState<AdditionalPaymentType>("earning");
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [isTaxable, setIsTaxable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.createEmployeeOffCyclePayment({
        employeeId,
        payrollRunId: run.id,
        paymentType,
        label: label.trim(),
        amount: Number(amount),
        isTaxable: paymentType === "deduction" ? undefined : isTaxable,
      });
      onCreated();
    } catch (err) {
      setError(errorMessage(err, "Could not create this off-cycle payment."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 bg-black/5 rounded-lg p-4 mb-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Employee</label>
          {fixedEmployee ? (
            <div className={`${inputClass} bg-black/5 text-label-secondary`}>
              {fixedEmployee.employeeNumber} — {fixedEmployee.firstName} {fixedEmployee.lastName}
            </div>
          ) : (
            <select required value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className={inputClass}>
              <option value="">Select…</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.employeeNumber} — {emp.firstName} {emp.lastName}
                </option>
              ))}
            </select>
          )}
        </div>
        <div>
          <label className={labelClass}>Type</label>
          <select value={paymentType} onChange={(e) => setPaymentType(e.target.value as AdditionalPaymentType)} className={inputClass}>
            <option value="earning">Earning</option>
            <option value="deduction">Deduction</option>
          </select>
        </div>
      </div>
      <div>
        <label className={labelClass}>Label</label>
        <input
          required
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={run.offCycleReason === "final_settlement" ? "e.g. Gratuity" : "e.g. Eid Bonus"}
          className={inputClass}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 items-end">
        <div>
          <label className={labelClass}>Amount (PKR)</label>
          <input type="number" min="1" step="1" required value={amount} onChange={(e) => setAmount(e.target.value)} className={inputClass} />
        </div>
        {paymentType === "earning" && (
          <label className="flex items-center gap-2 text-sm pb-2">
            <input type="checkbox" checked={isTaxable} onChange={(e) => setIsTaxable(e.target.checked)} />
            Taxable
          </label>
        )}
        {paymentType === "deduction" && <p className="text-xs text-label-tertiary pb-2">A deduction is never taxable.</p>}
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={submitting || !employeeId}
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {submitting ? "Adding…" : "Add payment"}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}
