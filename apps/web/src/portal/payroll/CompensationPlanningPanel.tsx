import { FormEvent, useCallback, useEffect, useState } from "react";
import type { CompCycleView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { LoadingNote } from "../shared/PageChrome";
import { formatDay } from "../shared/dates";
import { Field, Notice, Pill, buttonClass, errorMessage, inputClass, quietButtonClass } from "./PayrollPanelKit";
import { pkr } from "./payrollLabels";

const STATUS: Record<CompCycleView["status"], { label: string; tone: "neutral" | "good" | "warn" | "bad" | "accent" }> = {
  draft: { label: "Draft", tone: "neutral" }, submitted: { label: "Waiting for approval", tone: "warn" }, approved: { label: "Approved, not applied", tone: "accent" }, applied: { label: "Applied to payroll", tone: "good" }, cancelled: { label: "Cancelled", tone: "bad" },
};

/** Increment cycles. Proposals stay on this screen until a person approves and then applies them; applying writes each new Basic Salary. */
export function CompensationPlanningPanel() {
  const [cycles, setCycles] = useState<CompCycleView[] | null>(null);
  const [form, setForm] = useState({ name: "", effectiveFrom: "", budget: "" });
  const [edits, setEdits] = useState<Record<string, Record<string, { value: string; reason: string }>>>({});
  const [pct, setPct] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const load = useCallback(() => api.listCompCycles().then(setCycles).catch((e) => { setCycles([]); setError(errorMessage(e, "Could not load the cycles.")); }), []);
  useEffect(() => { void load(); }, [load]);

  const run = async (p: Promise<unknown>, done?: string) => { setError(null); setNotice(null); try { await p; if (done) setNotice(done); await load(); } catch (e) { setError(errorMessage(e, "That did not work.")); } };
  async function approve(id: string, same: boolean) {
    setError(null);
    setNotice(null);
    try {
      await api.compCycleAction(id, "approve", { samePersonConfirmed: same });
      setConfirmFor(null);
      setNotice("Approved. It has not been applied yet.");
      await load();
    } catch (e) {
      const m = errorMessage(e, "That did not work.");
      if (m.startsWith("You submitted this cycle yourself")) setConfirmFor(id);
      setError(m);
    }
  }
  async function create(e: FormEvent) { e.preventDefault(); await run(api.createCompCycle({ name: form.name, effectiveFrom: form.effectiveFrom, budgetAmount: form.budget ? Number(form.budget) : null }).then(() => setForm({ name: "", effectiveFrom: "", budget: "" }))); }
  const valueOf = (c: CompCycleView, id: string, cur: number) => edits[c.id]?.[id]?.value ?? String(cur);
  const setEdit = (cid: string, eid: string, patch: Partial<{ value: string; reason: string }>, base: { value: string; reason: string }) => setEdits({ ...edits, [cid]: { ...(edits[cid] ?? {}), [eid]: { ...base, ...(edits[cid]?.[eid] ?? {}), ...patch } } });
  async function saveDraft(c: CompCycleView) {
    const items = c.items.map((i) => ({ employeeId: i.employeeId, proposedBasic: Number(edits[c.id]?.[i.employeeId]?.value ?? i.proposedBasic), reason: edits[c.id]?.[i.employeeId]?.reason ?? i.reason ?? null }));
    await run(api.saveCompCycleItems(c.id, { items }).then(() => setEdits({ ...edits, [c.id]: {} })), "Proposals saved.");
  }
  function applyPct(c: CompCycleView) {
    const p = Number(pct);
    if (!Number.isFinite(p)) return;
    const next: Record<string, { value: string; reason: string }> = {};
    for (const i of c.items) next[i.employeeId] = { value: String(Math.round(i.currentBasic * (1 + p / 100))), reason: edits[c.id]?.[i.employeeId]?.reason ?? i.reason ?? "" };
    setEdits({ ...edits, [c.id]: next });
  }

  return (
    <div className="space-y-4" data-testid="comp-planning">
      <p className="text-sm text-label-secondary">Plan increments in one place. Nothing reaches payroll until someone approves the cycle and then presses Apply; applying writes each changed Basic Salary from the date you set. Employees are not told automatically, and arrears for a past date are not calculated here.</p>
      <form onSubmit={create} className="grid gap-3 sm:grid-cols-4 items-end">
        <Field label="Cycle name"><input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={120} aria-label="Cycle name" /></Field>
        <Field label="New salaries start"><input className={inputClass} type="date" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} required aria-label="New salaries start" /></Field>
        <Field label="Monthly budget (optional)"><input className={inputClass} type="number" min="0" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} aria-label="Monthly budget" /></Field>
        <button type="submit" className={buttonClass}>Start a cycle</button>
      </form>
      <Notice error={error} saved={notice} />
      {cycles === null ? <LoadingNote /> : cycles.length === 0 ? <p className="text-sm text-label-tertiary">No cycles yet.</p> : cycles.map((c) => (
        <div key={c.id} className="rounded-lg border border-black/10 p-3 space-y-3" data-testid="comp-cycle">
          <div className="flex items-center gap-3 flex-wrap"><div className="flex-1 min-w-[12rem]"><div className="font-medium">{c.name}</div><div className="text-xs text-label-tertiary">From {formatDay(c.effectiveFrom)} · {c.changedCount} change{c.changedCount === 1 ? "" : "s"} · +{pkr.format(c.totalMonthlyIncrease)} a month{c.budgetAmount !== null ? ` of ${pkr.format(c.budgetAmount)} budget` : ""}</div></div><Pill tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Pill></div>
          {c.items.length > 0 && (
            <div className="overflow-x-auto max-h-80 overflow-y-auto"><table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-label-tertiary"><th className="py-1 pr-3">Employee</th><th className="pr-3 text-right">Basic now</th><th className="pr-3">Proposed</th><th className="pr-3 text-right">Change</th><th>Reason</th></tr></thead>
              <tbody>{c.items.map((i) => (
                <tr key={i.employeeId} className="border-t border-black/5"><td className="py-1 pr-3">{i.employeeName}</td><td className="pr-3 text-right tabular-nums">{pkr.format(i.currentBasic)}</td>
                  <td className="pr-3">{c.status === "draft" ? <input aria-label={`Proposed basic for ${i.employeeName}`} className="w-28 rounded border border-black/10 px-2 py-0.5 text-sm" type="number" min="0" value={valueOf(c, i.employeeId, i.proposedBasic)} onChange={(e) => setEdit(c.id, i.employeeId, { value: e.target.value }, { value: String(i.proposedBasic), reason: i.reason ?? "" })} /> : <span className="tabular-nums">{pkr.format(i.proposedBasic)}</span>}</td>
                  <td className="pr-3 text-right tabular-nums">{i.changePercent === 0 ? "—" : `${i.changePercent > 0 ? "+" : ""}${i.changePercent}%`}</td>
                  <td>{c.status === "draft" ? <input aria-label={`Reason for ${i.employeeName}`} className="w-full rounded border border-black/10 px-2 py-0.5 text-sm" maxLength={300} value={edits[c.id]?.[i.employeeId]?.reason ?? i.reason ?? ""} onChange={(e) => setEdit(c.id, i.employeeId, { reason: e.target.value }, { value: String(i.proposedBasic), reason: i.reason ?? "" })} /> : i.reason ?? ""}</td></tr>))}</tbody>
            </table></div>
          )}
          <div className="flex gap-2 flex-wrap items-center">
            {c.status === "draft" && (<>
              <button type="button" className={quietButtonClass} onClick={() => void run(api.loadCompCyclePeople(c.id).then((r) => { if (r.withoutBasic > 0) setNotice(`${r.withoutBasic} active employee${r.withoutBasic === 1 ? " has" : "s have"} no Basic Salary on file and were left out.`); }))}>Load people</button>
              <label className="text-xs text-label-tertiary" htmlFor={`pct-${c.id}`}>Fill all with</label><input id={`pct-${c.id}`} className="w-16 rounded border border-black/10 px-2 py-0.5 text-sm" type="number" value={pct} onChange={(e) => setPct(e.target.value)} /><span className="text-xs text-label-tertiary">%</span>
              <button type="button" className={quietButtonClass} onClick={() => applyPct(c)}>Fill</button>
              <button type="button" className={buttonClass} onClick={() => void saveDraft(c)}>Save proposals</button>
              <button type="button" className={buttonClass} onClick={() => void run(api.compCycleAction(c.id, "submit"), "Submitted for approval.")}>Submit for approval</button></>)}
            {c.status === "submitted" && (<>
              <button type="button" className={quietButtonClass} onClick={() => void run(api.compCycleAction(c.id, "withdraw"))}>Back to draft</button>
              <button type="button" className={buttonClass} onClick={() => void approve(c.id, false)}>Approve</button>
              {confirmFor === c.id && <button type="button" className={buttonClass} onClick={() => void approve(c.id, true)}>I prepared this cycle and I am approving it too</button>}</>)}
            {c.status === "approved" && <button type="button" className={buttonClass} onClick={() => void run(api.compCycleAction(c.id, "apply"), "Applied. The new Basic Salaries are on file.")}>Apply to payroll</button>}
            {["draft", "submitted", "approved"].includes(c.status) && <button type="button" className={quietButtonClass} onClick={() => void run(api.compCycleAction(c.id, "cancel"))}>Cancel cycle</button>}
            {c.approvedByName && <span className="text-xs text-label-tertiary">Approved by {c.approvedByName}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
