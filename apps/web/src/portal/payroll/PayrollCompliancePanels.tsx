import { FormEvent, useCallback, useEffect, useState } from "react";
import type { AnnualSalaryStatementView, LevyKind, LevyWorksheetView, MinimumWageRateView } from "@aihxm/shared-types";
import { useConfirm } from "../shared/useConfirm";
import { api } from "../../api/client";
import { LoadingNote } from "../shared/PageChrome";
import { formatDay } from "../shared/dates";
import { Field, Notice, Pill, buttonClass, errorMessage, inputClass, quietButtonClass } from "./PayrollPanelKit";
import { pkr } from "./payrollLabels";

/** Minimum wage the company has recorded, per province and date. The smart checks compare salaries with it. Nothing ships pre-filled. */
export function MinimumWagePanel() {
  const { dialog, ask } = useConfirm();
  const [rows, setRows] = useState<MinimumWageRateView[] | null>(null);
  const [form, setForm] = useState({ province: "", monthlyAmount: "", effectiveFrom: "", sourceNote: "" });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const load = useCallback(() => api.listMinimumWages().then(setRows).catch((e) => setError(errorMessage(e, "Could not load the minimum wage table."))), []);
  useEffect(() => {
    void load();
  }, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(null);
    try {
      setRows(await api.addMinimumWage({ province: form.province, monthlyAmount: Number(form.monthlyAmount), effectiveFrom: form.effectiveFrom, sourceNote: form.sourceNote || null }));
      setForm({ province: "", monthlyAmount: "", effectiveFrom: "", sourceNote: "" });
      setSaved("Saved. The Smart checks screen now compares salaries with this figure.");
    } catch (err) {
      setError(errorMessage(err, "Could not save."));
    }
  }

  return (
    <div className="space-y-4" data-testid="minimum-wage-panel">
      {dialog}
      <p className="text-sm text-label-secondary">
        Type in the minimum monthly wage from the latest notification for each province. Nothing is pre-filled: the figure and its date are yours, and the Smart checks screen lists active employees paid less than it.
        Use a locations province key (for example sindh) or <strong>All</strong> to cover every location.
      </p>
      <form onSubmit={add} className="grid gap-3 sm:grid-cols-4 items-end">
        <Field label="Province or area"><input className={inputClass} value={form.province} onChange={(e) => setForm({ ...form, province: e.target.value })} required maxLength={80} aria-label="Province or area" /></Field>
        <Field label="Monthly minimum (PKR)"><input className={inputClass} type="number" min="1" step="0.01" value={form.monthlyAmount} onChange={(e) => setForm({ ...form, monthlyAmount: e.target.value })} required aria-label="Monthly minimum" /></Field>
        <Field label="Applies from"><input className={inputClass} type="date" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} required aria-label="Applies from" /></Field>
        <Field label="Where it came from"><input className={inputClass} value={form.sourceNote} onChange={(e) => setForm({ ...form, sourceNote: e.target.value })} maxLength={500} aria-label="Source note" /></Field>
        <div className="sm:col-span-4"><button type="submit" className={buttonClass}>Add</button></div>
      </form>
      <Notice error={error} saved={saved} />
      {rows === null ? <LoadingNote /> : rows.length === 0 ? <p className="text-sm text-label-tertiary">No minimum wage recorded yet.</p> : (
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-label-tertiary"><th className="py-1 pr-3">Province</th><th className="pr-3">Monthly minimum</th><th className="pr-3">From</th><th className="pr-3">Source</th><th /></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} className="border-t border-black/5">
              <td className="py-1.5 pr-3">{r.province}</td><td className="pr-3 tabular-nums">{pkr.format(r.monthlyAmount)}</td><td className="pr-3">{formatDay(r.effectiveFrom)}</td><td className="pr-3 text-label-secondary">{r.sourceNote ?? ""}</td>
              <td><button type="button" className={quietButtonClass} onClick={() => ask(`Delete the ${r.province} minimum wage entry that starts on ${formatDay(r.effectiveFrom)}?`, () => void api.deleteMinimumWage(r.id).then(setRows).catch((e) => setError(errorMessage(e, "Could not delete."))), "Delete")}>Delete</button></td>
            </tr>))}</tbody>
        </table></div>
      )}
    </div>
  );
}

const LEVY_NAME: Record<LevyKind, string> = { wwf: "Workers Welfare Fund (WWF)", wppf: "Workers Profit Participation Fund (WPPF)" };

/** A worksheet that multiplies a base figure by a rate you enter. Nothing is deducted, posted or paid from it. */
export function LevyWorksheetsPanel() {
  const [rows, setRows] = useState<LevyWorksheetView[] | null>(null);
  const [form, setForm] = useState({ kind: "wwf" as LevyKind, fiscalYear: "", baseLabel: "Profit before tax", baseAmount: "", ratePercent: "", notes: "" });
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.listLevyWorksheets().then(setRows).catch((e) => setError(errorMessage(e, "Could not load the worksheets."))), []);
  useEffect(() => {
    void load();
  }, [load]);
  const preview = Number(form.baseAmount) > 0 && Number(form.ratePercent) >= 0 && form.ratePercent !== "" ? Math.round(Number(form.baseAmount) * Number(form.ratePercent)) / 100 : null;

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.createLevyWorksheet({ kind: form.kind, fiscalYear: form.fiscalYear, baseLabel: form.baseLabel, baseAmount: Number(form.baseAmount), ratePercent: Number(form.ratePercent), notes: form.notes || null });
      setForm({ ...form, baseAmount: "", ratePercent: "", notes: "" });
      await load();
    } catch (err) {
      setError(errorMessage(err, "Could not save the worksheet."));
    }
  }
  const act = (p: Promise<unknown>) => p.then(load).catch((e) => setError(errorMessage(e, "That did not work.")));

  return (
    <div className="space-y-4" data-testid="levy-panel">
      <p className="text-sm text-label-secondary">
        A working paper for the yearly WWF and WPPF figures. Enter the base (for example profit before tax) and the rate your accountant gives you; the sheet shows base times rate for review.
        Nothing is deducted from anyone, posted to the books or paid from here.
      </p>
      <form onSubmit={create} className="grid gap-3 sm:grid-cols-3 items-end">
        <Field label="Levy"><select className={inputClass} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as LevyKind })} aria-label="Levy">{(["wwf", "wppf"] as LevyKind[]).map((k) => <option key={k} value={k}>{LEVY_NAME[k]}</option>)}</select></Field>
        <Field label="Year"><input className={inputClass} value={form.fiscalYear} onChange={(e) => setForm({ ...form, fiscalYear: e.target.value })} placeholder="2025-26" required maxLength={20} aria-label="Year" /></Field>
        <Field label="Base is"><input className={inputClass} value={form.baseLabel} onChange={(e) => setForm({ ...form, baseLabel: e.target.value })} required maxLength={120} aria-label="Base is" /></Field>
        <Field label="Base amount (PKR)"><input className={inputClass} type="number" min="0" step="0.01" value={form.baseAmount} onChange={(e) => setForm({ ...form, baseAmount: e.target.value })} required aria-label="Base amount" /></Field>
        <Field label="Rate (%)"><input className={inputClass} type="number" min="0" max="100" step="0.001" value={form.ratePercent} onChange={(e) => setForm({ ...form, ratePercent: e.target.value })} required aria-label="Rate" /></Field>
        <Field label="Notes"><input className={inputClass} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={1000} aria-label="Notes" /></Field>
        <div className="sm:col-span-3 flex items-center gap-3"><button type="submit" className={buttonClass}>Save worksheet</button>{preview !== null && <span className="text-sm text-label-secondary">Works out to {pkr.format(preview)}</span>}</div>
      </form>
      <Notice error={error} />
      {rows === null ? <LoadingNote /> : rows.length === 0 ? <p className="text-sm text-label-tertiary">No worksheets yet.</p> : (
        <ul className="space-y-2">{rows.map((r) => (
          <li key={r.id} className="rounded-lg border border-black/10 p-3 text-sm flex flex-wrap items-center gap-3" data-testid="levy-row">
            <div className="flex-1 min-w-[14rem]"><div className="font-medium">{LEVY_NAME[r.kind]} · {r.fiscalYear}</div><div className="text-label-secondary">{r.baseLabel} {pkr.format(r.baseAmount)} × {r.ratePercent}% = <strong className="tabular-nums">{pkr.format(r.amount)}</strong></div>{r.notes && <div className="text-label-tertiary">{r.notes}</div>}</div>
            <Pill tone={r.status === "final" ? "good" : "neutral"}>{r.status === "final" ? "Final" : "Draft"}</Pill>
            {r.status === "draft" && <><button type="button" className={buttonClass} onClick={() => void act(api.finalizeLevyWorksheet(r.id))}>Mark final</button><button type="button" className={quietButtonClass} onClick={() => void act(api.deleteLevyWorksheet(r.id))}>Delete</button></>}
          </li>))}</ul>
      )}
    </div>
  );
}

/** Totals of the finalised payslips for a 1 July to 30 June tax year, as a working file. */
export function AnnualSalaryStatementPanel() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(new Date().getMonth() >= 6 ? thisYear : thisYear - 1);
  const [data, setData] = useState<AnnualSalaryStatementView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function show() {
    setBusy(true);
    setError(null);
    try {
      setData(await api.getAnnualSalaryStatement(year));
    } catch (err) {
      setData(null);
      setError(errorMessage(err, "Could not build the statement."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="annual-statement-panel">
      <p className="text-sm text-label-secondary">Salary and tax withheld for every employee across a tax year (1 July to 30 June), added up from the payslips of finalised runs. Nothing is recalculated.</p>
      <div className="flex items-end gap-3">
        <Field label="Tax year starting July of"><input className={inputClass} type="number" min={2000} max={2100} value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Tax year" /></Field>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => void show()}>Show</button>
        {data && <button type="button" className={quietButtonClass} onClick={() => api.downloadPayrollText(`/compliance/annual-salary-statement/csv?year=${year}`, `annual-salary-statement-${year}-${year + 1}.csv`).catch((e) => setError(errorMessage(e, "Could not download.")))}>Download CSV</button>}
      </div>
      <Notice error={error} />
      {data && (
        <div className="space-y-2">
          <p className="text-xs text-label-tertiary">{formatDay(data.taxYearStart)} to {formatDay(data.taxYearEnd)} · {data.runCount} finalised run{data.runCount === 1 ? "" : "s"}{data.missingCnicCount > 0 ? ` · ${data.missingCnicCount} without a CNIC on file` : ""}</p>
          {data.rows.length === 0 ? <p className="text-sm text-label-tertiary">No finalised payroll in this tax year.</p> : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-label-tertiary"><th className="py-1 pr-3">Employee</th><th className="pr-3">CNIC</th><th className="pr-3">Months</th><th className="pr-3 text-right">Gross</th><th className="pr-3 text-right">Taxable</th><th className="text-right">Tax withheld</th></tr></thead>
              <tbody>{data.rows.map((r) => (
                <tr key={r.employeeNumber} className="border-t border-black/5"><td className="py-1.5 pr-3">{r.employeeName} <span className="text-label-tertiary">{r.employeeNumber}</span></td><td className="pr-3">{r.cnic ?? "—"}</td><td className="pr-3">{r.monthsPaid}</td><td className="pr-3 text-right tabular-nums">{pkr.format(r.grossPay)}</td><td className="pr-3 text-right tabular-nums">{pkr.format(r.taxableIncome)}</td><td className="text-right tabular-nums">{pkr.format(r.taxWithheld)}</td></tr>))}
                <tr className="border-t border-black/20 font-medium"><td className="py-1.5 pr-3" colSpan={3}>Total</td><td className="pr-3 text-right tabular-nums">{pkr.format(data.totals.grossPay)}</td><td className="pr-3 text-right tabular-nums">{pkr.format(data.totals.taxableIncome)}</td><td className="text-right tabular-nums">{pkr.format(data.totals.taxWithheld)}</td></tr></tbody>
            </table></div>
          )}
          <p className="text-xs text-label-tertiary">{data.note}</p>
        </div>
      )}
    </div>
  );
}
