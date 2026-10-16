import { LoadingNote } from "../shared/PageChrome";
import { useEffect, useState } from "react";
import type {
  EmployeeSchemeAccountView,
  FinalSettlementStatus,
  FinalSettlementView,
  PayrollSchemeDefinitionView,
  PayrollSchemeParameters,
  PayrollSchemeType,
  PayrollSettlementSettingsView,
  SchemeLedgerEntryView,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { pkr } from "./payrollLabels";
import { formatDay, todayIso } from "../shared/dates";

const inputClass = "w-full rounded-lg border border-black/10 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const STATUS_STYLE: Record<FinalSettlementStatus, string> = {
  open: "bg-black/10 text-label-secondary",
  calculated: "bg-amber-100 text-amber-800",
  approved: "bg-accent/15 text-accent",
  finalized: "bg-success/15 text-green-700",
  cancelled: "bg-black/10 text-label-tertiary",
  reversed: "bg-danger/15 text-red-700",
};
const STATUS_LABEL: Record<FinalSettlementStatus, string> = {
  open: "Not calculated",
  calculated: "Awaiting approval",
  approved: "Approved",
  finalized: "Paid",
  cancelled: "Cancelled",
  reversed: "Reversed",
};
const VIA_LABEL: Record<string, string> = {
  payslip: "Paid through the payslip",
  scheme_ledger: "Paid from the scheme account",
  run_result: "Result of the final payroll run",
  info: "Needs attention",
};

const num = (v: string): number | null => (v.trim() === "" ? null : Number(v));

/**
 * PAY-14 - one employee's final settlement, from the termination that opened it to the immutable result of the
 * final payroll run. HR calculates, a different person (the payroll approver) approves, and finalising the
 * employee's final_settlement run closes it.
 */
export function FinalSettlementsSection({ canPrepare, canApprove }: { canPrepare: boolean; canApprove: boolean }) {
  const [rows, setRows] = useState<FinalSettlementView[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .listFinalSettlements()
      .then(setRows)
      .catch((err) => setError(errorMessage(err, "Could not load final settlements.")));
  useEffect(() => {
    void load();
  }, []);

  if (error) return <p className="text-xs text-danger">{error}</p>;
  if (!rows) return <LoadingNote />;
  if (rows.length === 0) return <p className="text-sm text-label-tertiary">No terminations yet. A settlement opens here when an employee's termination takes effect.</p>;

  return (
    <div className="space-y-2">
      {rows.map((s) => (
        <div key={s.id} className="bg-black/5 rounded-lg">
          <button type="button" onClick={() => setOpenId(openId === s.id ? null : s.id)} className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm">
            <span>
              <span className="font-medium">{s.employeeName}</span> <span className="font-mono text-xs text-label-tertiary">{s.employeeNumber}</span>
              <span className="text-xs text-label-tertiary"> · last working day {formatDay(s.lastWorkingDay)}</span>
            </span>
            <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_STYLE[s.status]}`}>{STATUS_LABEL[s.status]}</span>
          </button>
          {openId === s.id && <SettlementDetail id={s.id} canPrepare={canPrepare} canApprove={canApprove} onChanged={load} />}
        </div>
      ))}
    </div>
  );
}

function SettlementDetail({ id, canPrepare, canApprove, onChanged }: { id: string; canPrepare: boolean; canApprove: boolean; onChanged: () => void }) {
  const [s, setS] = useState<FinalSettlementView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reasonFor, setReasonFor] = useState<"withdraw" | "cancel" | null>(null);
  const [reason, setReason] = useState("");

  useEffect(() => {
    api.getFinalSettlement(id).then(setS).catch((err) => setError(errorMessage(err, "Could not load the settlement.")));
  }, [id]);

  async function act(fn: () => Promise<FinalSettlementView>, failure: string) {
    setBusy(true);
    setError(null);
    try {
      setS(await fn());
      setReasonFor(null);
      setReason("");
      onChanged();
    } catch (err) {
      setError(errorMessage(err, failure));
    } finally {
      setBusy(false);
    }
  }

  if (!s) return <p className="px-3 pb-3 text-xs text-label-tertiary">{error ?? "Loading…"}</p>;
  const payable = s.lines.filter((l) => ["payslip", "run_result"].includes(l.settleVia));
  const net = payable.reduce((a, l) => a + l.amount, 0);

  return (
    <div className="px-3 pb-3 space-y-3 text-xs">
      {s.lines.length === 0 ? (
        <p className="text-label-tertiary">Not calculated yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="text-label-tertiary">
              <tr>
                <th className="pr-3 py-1 font-medium">Item</th>
                <th className="pr-3 py-1 font-medium text-right">Amount</th>
                <th className="py-1 font-medium">How it is settled</th>
              </tr>
            </thead>
            <tbody>
              {s.lines.map((l) => (
                <tr key={l.id} className="border-t border-black/5 align-top">
                  <td className="pr-3 py-1">
                    {l.label}
                    {l.warning && <div className="text-amber-700">{l.warning}</div>}
                  </td>
                  <td className="pr-3 py-1 text-right tabular-nums">{pkr.format(l.amount)}</td>
                  <td className="py-1 text-label-tertiary">{VIA_LABEL[l.settleVia]}</td>
                </tr>
              ))}
            </tbody>
            {s.status !== "open" && (
              <tfoot>
                <tr className="border-t border-black/10 font-semibold">
                  <td className="pr-3 py-1">Net through the payslip</td>
                  <td className="pr-3 py-1 text-right tabular-nums">{pkr.format(net)}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {s.result && typeof s.result.netPay === "number" && (
        <p className="text-label-secondary">
          Final payslip: gross {pkr.format(Number(s.result.grossPay))}, income tax {pkr.format(Number(s.result.incomeTax))}, net {pkr.format(s.result.netPay as number)}. This result is fixed.
        </p>
      )}
      {error && <p className="text-danger">{error}</p>}
      <div className="flex items-center gap-3 flex-wrap">
        {canPrepare && ["open", "calculated"].includes(s.status) && (
          <button disabled={busy} onClick={() => act(() => api.calculateFinalSettlement(id), "Could not calculate.")} className="font-semibold rounded-lg px-3 py-1.5 text-white bg-accent disabled:opacity-50">
            {s.status === "open" ? "Calculate" : "Recalculate"}
          </button>
        )}
        {canApprove && s.status === "calculated" && (
          <button disabled={busy} onClick={() => act(() => api.approveFinalSettlement(id), "Could not approve.")} className="font-semibold rounded-lg px-3 py-1.5 text-white bg-accent disabled:opacity-50">
            Approve
          </button>
        )}
        {canApprove && s.status === "approved" && (
          <button disabled={busy} onClick={() => setReasonFor("withdraw")} className="font-semibold text-danger hover:underline">
            Withdraw approval
          </button>
        )}
        {canPrepare && ["open", "calculated"].includes(s.status) && (
          <button disabled={busy} onClick={() => setReasonFor("cancel")} className="font-semibold text-danger hover:underline">
            Cancel settlement
          </button>
        )}
        {s.status === "approved" && <span className="text-label-tertiary">Create and finalise this employee's final settlement payroll run to pay it.</span>}
      </div>
      {reasonFor && (
        <div className="flex items-center gap-2 flex-wrap">
          <input aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" className={`${inputClass} max-w-sm`} />
          <button
            disabled={busy || reason.trim().length < 3}
            onClick={() => act(() => (reasonFor === "withdraw" ? api.withdrawFinalSettlementApproval(id, reason.trim()) : api.cancelFinalSettlement(id, reason.trim())), "Could not complete this.")}
            className="font-semibold rounded-lg px-3 py-1 text-white bg-danger disabled:opacity-50"
          >
            Confirm
          </button>
          <button onClick={() => setReasonFor(null)} className="text-label-tertiary">Cancel</button>
        </div>
      )}
    </div>
  );
}

const PARAM_FIELDS: Record<PayrollSchemeType, Array<{ key: keyof PayrollSchemeParameters; label: string; kind: "number" | "text" | "rounding" | "bool" }>> = {
  provident_fund: [
    { key: "employeeComponentKey", label: "Payslip component of the employee's contribution", kind: "text" },
    { key: "employerComponentKey", label: "Payslip component of the employer's contribution", kind: "text" },
    { key: "employerVestingMonths", label: "Months before the employer's share is paid out", kind: "number" },
  ],
  gratuity: [
    { key: "daysPerYearOfService", label: "Days of pay per year of service", kind: "number" },
    { key: "minimumServiceMonths", label: "Minimum months of service", kind: "number" },
    { key: "dailyRateDivisor", label: "Monthly salary divided by (one day's pay)", kind: "number" },
    { key: "serviceRounding", label: "Service counted as", kind: "rounding" },
    { key: "isTaxable", label: "Taxable in the final payroll run", kind: "bool" },
  ],
  other: [],
};

/** PAY-14 / PAY-15 configuration: what the tenant's final settlement uses, and the scheme definitions. No figure is pre-filled. */
export function SchemesAndSettlementSettingsPanel() {
  return (
    <div className="space-y-6">
      <SettlementSettingsForm />
      <SchemeDefinitionsPanel />
    </div>
  );
}

function SettlementSettingsForm() {
  const [s, setS] = useState<PayrollSettlementSettingsView | null>(null);
  const [divisor, setDivisor] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getSettlementSettings().then((v) => {
      setS(v);
      setDivisor(v.dailyRateDivisor === null ? "" : String(v.dailyRateDivisor));
    }).catch((err) => setError(errorMessage(err, "Could not load the settlement settings.")));
  }, []);

  async function save(patch: Parameters<typeof api.updateSettlementSettings>[0]) {
    setError(null);
    setSaved(false);
    try {
      const v = await api.updateSettlementSettings(patch);
      setS(v);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err, "Could not save."));
    }
  }

  if (!s) return <p className="text-sm text-label-tertiary">{error ?? "Loading…"}</p>;
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">Final settlement settings</h3>
      <p className="text-xs text-label-tertiary">
        Leave encashment and notice recovery are worked out from one day's pay. Choose the salary figure and the number it is divided by - nothing is assumed.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-xl">
        <label className="text-xs">One day's pay is taken from
          <select id="settlement-base" className={inputClass} value={s.dailyRateBase ?? ""} onChange={(e) => save({ dailyRateBase: (e.target.value || null) as PayrollSettlementSettingsView["dailyRateBase"] })}>
            <option value="">Not set</option>
            <option value="basic_salary">Basic salary</option>
            <option value="gross_earnings">All fixed earnings</option>
          </select>
        </label>
        <label className="text-xs">Monthly figure divided by
          <input id="settlement-divisor" className={inputClass} inputMode="decimal" value={divisor} onChange={(e) => setDivisor(e.target.value)} onBlur={() => num(divisor) !== s.dailyRateDivisor && save({ dailyRateDivisor: num(divisor) })} />
        </label>
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={s.leaveEncashmentEnabled} onChange={(e) => save({ leaveEncashmentEnabled: e.target.checked })} /> Encash remaining leave of encashable types on separation</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={s.leaveEncashmentTaxable} onChange={(e) => save({ leaveEncashmentTaxable: e.target.checked })} /> Leave encashment is taxable</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={s.noticeRecoveryEnabled} onChange={(e) => save({ noticeRecoveryEnabled: e.target.checked })} /> Recover pay for notice days not served</label>
      </div>
      {saved && <p className="text-xs text-success">Saved.</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

function SchemeDefinitionsPanel() {
  const [rows, setRows] = useState<PayrollSchemeDefinitionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ code: string; name: string; schemeType: PayrollSchemeType; effectiveFrom: string; values: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.listPayrollSchemes().then(setRows).catch((err) => setError(errorMessage(err, "Could not load the schemes.")));
  useEffect(() => {
    void load();
  }, []);

  function edit(r: PayrollSchemeDefinitionView) {
    setError(null);
    setForm({
      code: r.code, name: r.name, schemeType: r.schemeType, effectiveFrom: todayIso(),
      values: Object.fromEntries(Object.entries(r.parameters).map(([k, v]) => [k, v === null || v === undefined ? "" : String(v)])),
    });
  }

  async function save() {
    if (!form) return;
    setBusy(true);
    setError(null);
    const parameters: Record<string, unknown> = {};
    for (const f of PARAM_FIELDS[form.schemeType]) {
      const raw = form.values[f.key as string];
      if (raw === undefined || raw === "") continue;
      parameters[f.key as string] = f.kind === "number" ? Number(raw) : f.kind === "bool" ? raw === "true" : raw;
    }
    try {
      await api.upsertPayrollScheme({ code: form.code, name: form.name, schemeType: form.schemeType, effectiveFrom: form.effectiveFrom, parameters: parameters as PayrollSchemeParameters });
      setForm(null);
      await load();
    } catch (err) {
      setError(errorMessage(err, "Could not save the scheme."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Provident fund &amp; gratuity schemes</h3>
        {!form && (
          <button type="button" className="text-xs font-semibold text-accent hover:underline" onClick={() => setForm({ code: "", name: "", schemeType: "provident_fund", effectiveFrom: todayIso(), values: {} })}>
            + New scheme
          </button>
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      {!rows ? (
        <LoadingNote />
      ) : rows.length === 0 && !form ? (
        <p className="text-xs text-label-tertiary">No schemes yet. Each scheme's rates and day counts are entered by you; none are built in.</p>
      ) : (
        <div className="bg-black/5 rounded-lg divide-y divide-black/10">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <div>
                <span className="font-medium">{r.name}</span> <span className="font-mono text-xs text-label-tertiary">{r.code}</span>
                <span className="text-xs text-label-tertiary"> · {r.schemeType.replace("_", " ")} · from {formatDay(r.effectiveFrom)}</span>
                {!r.isActive && <span className="ml-2 text-xs text-label-tertiary">Inactive</span>}
                {!r.isComplete && <div className="text-xs text-amber-700">Still needs: {r.missingParameters.join(", ")}</div>}
              </div>
              <button className="text-xs font-semibold text-accent hover:underline" onClick={() => edit(r)}>New version</button>
            </div>
          ))}
        </div>
      )}
      {form && (
        <div className="border border-black/10 rounded-lg p-3 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="text-xs">Name<input id="scheme-name" className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="text-xs">Code<input id="scheme-code" className={`${inputClass} font-mono`} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="lower_case_code" /></label>
            <label className="text-xs">Type
              <select id="scheme-type" className={inputClass} value={form.schemeType} onChange={(e) => setForm({ ...form, schemeType: e.target.value as PayrollSchemeType, values: {} })}>
                <option value="provident_fund">Provident fund</option>
                <option value="gratuity">Gratuity</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="text-xs">Effective from<input id="scheme-from" type="date" className={inputClass} value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} /></label>
          </div>
          {PARAM_FIELDS[form.schemeType].map((f) => (
            <label key={f.key} className="block text-xs">{f.label}
              {f.kind === "rounding" ? (
                <select className={inputClass} value={form.values[f.key] ?? ""} onChange={(e) => setForm({ ...form, values: { ...form.values, [f.key]: e.target.value } })}>
                  <option value="">Not set</option>
                  <option value="complete_years">Completed years only</option>
                  <option value="pro_rata">Pro-rata months</option>
                </select>
              ) : f.kind === "bool" ? (
                <select className={inputClass} value={form.values[f.key] ?? ""} onChange={(e) => setForm({ ...form, values: { ...form.values, [f.key]: e.target.value } })}>
                  <option value="">Taxable (default)</option>
                  <option value="true">Taxable</option>
                  <option value="false">Not taxable</option>
                </select>
              ) : (
                <input className={inputClass} inputMode={f.kind === "number" ? "decimal" : undefined} value={form.values[f.key] ?? ""} onChange={(e) => setForm({ ...form, values: { ...form.values, [f.key]: e.target.value } })} />
              )}
            </label>
          ))}
          <div className="flex items-center gap-3">
            <button disabled={busy || !form.code || !form.name} onClick={save} className="text-sm font-semibold rounded-lg px-4 py-2 text-white bg-accent disabled:opacity-50">Save scheme</button>
            <button onClick={() => setForm(null)} className="text-sm text-label-tertiary">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** PAY-15 - an employee's scheme accounts and their ledgers (Compensation & Assets tab). */
export function EmployeeSchemeAccountsPanel({ employeeId, canManage }: { employeeId: string; canManage: boolean }) {
  const [accounts, setAccounts] = useState<EmployeeSchemeAccountView[] | null>(null);
  const [schemes, setSchemes] = useState<PayrollSchemeDefinitionView[]>([]);
  const [ledgerFor, setLedgerFor] = useState<string | null>(null);
  const [entries, setEntries] = useState<SchemeLedgerEntryView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ entryType: "opening_balance", amount: "", note: "" });
  const [newScheme, setNewScheme] = useState("");

  const load = () =>
    api
      .listSchemeAccounts(employeeId)
      .then(setAccounts)
      .catch((err) => setError(err instanceof ApiError && err.status === 403 ? "forbidden" : errorMessage(err, "Could not load scheme accounts.")));
  useEffect(() => {
    void load();
    api.listPayrollSchemes().then(setSchemes).catch(() => undefined);
  }, [employeeId]);

  async function openLedger(id: string) {
    setLedgerFor(ledgerFor === id ? null : id);
    if (ledgerFor !== id) setEntries(await api.listSchemeLedger(id).catch(() => []));
  }

  async function post(accountId: string) {
    setError(null);
    try {
      await api.postSchemeLedgerEntry(accountId, { entryType: form.entryType as "opening_balance" | "withdrawal" | "adjustment", amount: Number(form.amount), note: form.note || undefined });
      setForm({ entryType: "opening_balance", amount: "", note: "" });
      setEntries(await api.listSchemeLedger(accountId));
      void load();
    } catch (err) {
      setError(errorMessage(err, "Could not post the entry."));
    }
  }

  if (error === "forbidden" || (!accounts && !error)) return null;
  const free = schemes.filter((s) => !accounts?.some((a) => a.schemeCode === s.code));
  return (
    <section className="bg-card rounded-card p-5 shadow-sm space-y-3">
      <h3 className="text-sm font-semibold">Provident fund &amp; gratuity accounts</h3>
      {error && <p className="text-xs text-danger">{error}</p>}
      {accounts && accounts.length === 0 && <p className="text-xs text-label-tertiary">Not enrolled in any scheme.</p>}
      {accounts?.map((a) => (
        <div key={a.id} className="bg-black/5 rounded-lg p-3 text-xs space-y-2">
          <div className="flex items-center justify-between">
            <span><span className="font-medium">{schemes.find((s) => s.code === a.schemeCode)?.name ?? a.schemeCode}</span> · {a.status}</span>
            <span className="tabular-nums font-semibold">{pkr.format(a.balance)}</span>
          </div>
          <button className="font-semibold text-accent hover:underline" onClick={() => openLedger(a.id)}>{ledgerFor === a.id ? "Hide ledger" : "Ledger"}</button>
          {ledgerFor === a.id && (
            <div className="space-y-2">
              <table className="w-full text-left">
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id} className="border-t border-black/5">
                      <td className="py-1 pr-2">{formatDay(e.entryDate)}</td>
                      <td className="py-1 pr-2">{e.entryType.replace(/_/g, " ")}{e.note ? ` - ${e.note}` : ""}</td>
                      <td className="py-1 text-right tabular-nums">{pkr.format(e.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {canManage && a.status === "active" && (
                <div className="flex items-center gap-2 flex-wrap">
                  <select aria-label="Entry type" className="rounded-lg border border-black/10 px-2 py-1" value={form.entryType} onChange={(e) => setForm({ ...form, entryType: e.target.value })}>
                    <option value="opening_balance">Opening balance</option>
                    <option value="withdrawal">Withdrawal</option>
                    <option value="adjustment">Adjustment</option>
                  </select>
                  <input aria-label="Amount" className="w-28 rounded-lg border border-black/10 px-2 py-1" inputMode="decimal" placeholder="Amount" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
                  <input aria-label="Note" className="flex-1 min-w-32 rounded-lg border border-black/10 px-2 py-1" placeholder="Note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
                  <button disabled={!form.amount} onClick={() => post(a.id)} className="font-semibold rounded-lg px-3 py-1 text-white bg-accent disabled:opacity-50">Post</button>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      {canManage && free.length > 0 && (
        <div className="flex items-center gap-2">
          <select aria-label="Scheme" className="rounded-lg border border-black/10 px-2 py-1 text-xs" value={newScheme} onChange={(e) => setNewScheme(e.target.value)}>
            <option value="">Enrol in a scheme…</option>
            {free.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
          <button disabled={!newScheme} className="text-xs font-semibold text-accent hover:underline disabled:opacity-50"
            onClick={async () => { try { await api.openSchemeAccount(employeeId, newScheme); setNewScheme(""); void load(); } catch (err) { setError(errorMessage(err, "Could not enrol.")); } }}>
            Enrol
          </button>
        </div>
      )}
    </section>
  );
}
