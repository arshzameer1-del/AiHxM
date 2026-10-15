import { FormEvent, useEffect, useState } from "react";
import type { CompanyWorkTimeDefaultView, LoanTypeView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

const inputClass = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent";
const labelClass = "block text-sm font-medium mb-1";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const numberOrNull = (v: string): number | null => (v.trim() === "" ? null : Number(v));

/**
 * PAY-13 - the tenant's own loan and advance policy: a catalogue of types, each with optional limits (instalment as a
 * percent of monthly earnings, amount as a multiple of them, longest repayment, guarantor). A blank limit means none.
 * PAY-24 - the tenant-wide standard working hours, which the overtime rate is divided by unless an employee's work profile says otherwise.
 */
export function LoanTypesPanel() {
  const [types, setTypes] = useState<LoanTypeView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = () =>
    api
      .listLoanTypes(true)
      .then(setTypes)
      .catch((err) => setError(errorMessage(err, "Could not load the loan types.")));

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">Loan &amp; advance types</h3>
          <button type="button" onClick={() => setAdding((a) => !a)} className="text-xs font-semibold text-accent hover:underline">
            {adding ? "Cancel" : "+ New type"}
          </button>
        </div>
        {error && <p className="text-xs text-danger mb-2">{error}</p>}
        {adding && (
          <NewTypeForm
            onCreated={() => {
              setAdding(false);
              void load();
            }}
          />
        )}
        {!types ? (
          <p className="text-sm text-label-tertiary">Loading…</p>
        ) : (
          <div className="space-y-2">
            {types.map((t) => (
              <TypeRow key={t.id} type={t} onChanged={() => void load()} />
            ))}
          </div>
        )}
      </div>
      <WorkTimeDefault />
    </div>
  );
}

function TypeRow({ type, onChanged }: { type: LoanTypeView; onChanged: () => void }) {
  const [pct, setPct] = useState(type.maxInstallmentPercent?.toString() ?? "");
  const [mult, setMult] = useState(type.maxPrincipalMultiple?.toString() ?? "");
  const [maxN, setMaxN] = useState(type.maxInstallments?.toString() ?? "");
  const [guarantor, setGuarantor] = useState(type.requiresGuarantor);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(patch: Parameters<typeof api.updateLoanType>[1]) {
    setBusy(true);
    setError(null);
    try {
      await api.updateLoanType(type.id, patch);
      onChanged();
    } catch (err) {
      setError(errorMessage(err, "Could not save this type."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-black/5 rounded-lg p-3 text-sm">
      <div className="flex items-center justify-between mb-2">
        <div className="font-medium">
          {type.name} <span className="text-xs text-label-tertiary font-mono">{type.code}</span>
          <span className="text-xs text-label-tertiary"> · {type.kind === "loan" ? "Loan" : "Salary advance"}</span>
        </div>
        <button type="button" disabled={busy} onClick={() => save({ isActive: !type.isActive })} className="text-xs font-semibold text-accent hover:underline">
          {type.isActive ? "Switch off" : "Switch on"}
        </button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
        <div>
          <label className="block text-xs mb-1" htmlFor={`lt-pct-${type.id}`}>Max instalment, % of earnings</label>
          <input id={`lt-pct-${type.id}`} type="number" min="0" max="100" value={pct} onChange={(e) => setPct(e.target.value)} className={inputClass} placeholder="No limit" />
        </div>
        <div>
          <label className="block text-xs mb-1" htmlFor={`lt-mult-${type.id}`}>Max amount, × earnings</label>
          <input id={`lt-mult-${type.id}`} type="number" min="0" step="0.5" value={mult} onChange={(e) => setMult(e.target.value)} className={inputClass} placeholder="No limit" />
        </div>
        <div>
          <label className="block text-xs mb-1" htmlFor={`lt-n-${type.id}`}>Max instalments</label>
          <input id={`lt-n-${type.id}`} type="number" min="1" value={maxN} onChange={(e) => setMaxN(e.target.value)} className={inputClass} placeholder="No limit" />
        </div>
        <label className="flex items-center gap-2 text-xs pb-2">
          <input type="checkbox" checked={guarantor} onChange={(e) => setGuarantor(e.target.checked)} /> Needs a guarantor
        </label>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => save({ maxInstallmentPercent: numberOrNull(pct), maxPrincipalMultiple: numberOrNull(mult), maxInstallments: numberOrNull(maxN), requiresGuarantor: guarantor })}
          className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
        >
          Save limits
        </button>
        <span className="text-xs text-label-tertiary">Applies to loans issued from now on.</span>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </div>
  );
}

function NewTypeForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [kind, setKind] = useState<"loan" | "salary_advance">("loan");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createLoanType({ name: name.trim(), code: code.trim(), kind });
      onCreated();
    } catch (err) {
      setError(errorMessage(err, "Could not create this type."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end bg-black/5 rounded-lg p-3 mb-3">
      <div>
        <label className={labelClass} htmlFor="lt-new-name">Name</label>
        <input id="lt-new-name" required value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
      </div>
      <div>
        <label className={labelClass} htmlFor="lt-new-code">Code</label>
        <input id="lt-new-code" required value={code} onChange={(e) => setCode(e.target.value)} placeholder="staff_loan" className={inputClass} />
      </div>
      <div>
        <label className={labelClass} htmlFor="lt-new-kind">Kind</label>
        <select id="lt-new-kind" value={kind} onChange={(e) => setKind(e.target.value as "loan" | "salary_advance")} className={inputClass}>
          <option value="loan">Loan</option>
          <option value="salary_advance">Salary advance</option>
        </select>
      </div>
      <button type="submit" disabled={busy} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">Create</button>
      {error && <div className="text-danger text-xs sm:col-span-4">{error}</div>}
    </form>
  );
}

function WorkTimeDefault() {
  const [current, setCurrent] = useState<CompanyWorkTimeDefaultView | null>(null);
  const [monthly, setMonthly] = useState("");
  const [from, setFrom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api
      .getCompanyWorkTimeDefault()
      .then((c) => {
        setCurrent(c);
        setMonthly(String(c.standardMonthlyHours));
      })
      .catch((err) => setError(errorMessage(err, "Could not load the working-time default.")));
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      const c = await api.setCompanyWorkTimeDefault({ standardMonthlyHours: Number(monthly), effectiveFrom: from || undefined });
      setCurrent(c);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err, "Could not save the working-time default."));
    }
  }

  return (
    <form onSubmit={save}>
      <h3 className="text-sm font-semibold mb-2">Standard working hours</h3>
      <p className="text-xs text-label-secondary mb-2">
        The monthly hours the overtime rate is divided by. An employee&apos;s own work profile takes precedence.
        {current ? ` In force now: ${current.standardMonthlyHours} hours a month.` : ""}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className={labelClass} htmlFor="wt-monthly">Hours per month</label>
          <input id="wt-monthly" type="number" min="100" max="300" step="0.5" required value={monthly} onChange={(e) => setMonthly(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className={labelClass} htmlFor="wt-from">Effective from (optional)</label>
          <input id="wt-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass} />
        </div>
        <button type="submit" className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold">Save</button>
        {saved && <span className="text-xs text-green-700">Saved.</span>}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </form>
  );
}
