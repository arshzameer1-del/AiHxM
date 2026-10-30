import { FormEvent, useCallback, useEffect, useState } from "react";
import type { HeadcountPlanView, OrgUnitView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";

const field = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm";
const btn = "px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50";
const quiet = "px-3 py-1.5 rounded-lg bg-black/5 text-sm font-medium disabled:opacity-50";

/** HR: how many people each department should have, set beside how many it has. A comparison only: nothing is hired or changed. */
export function HeadcountPlansPage() {
  const [plans, setPlans] = useState<HeadcountPlanView[] | null>(null);
  const [units, setUnits] = useState<OrgUnitView[]>([]);
  const [name, setName] = useState("");
  const [year, setYear] = useState("");
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { api.listHeadcountPlans().then(setPlans).catch((e) => { setPlans([]); setError(e instanceof ApiError ? e.message : "Could not load the plans."); }); }, []);
  useEffect(() => { load(); api.listOrgUnits().then(setUnits).catch(() => setUnits([])); }, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const lines = Object.entries(counts).filter(([, v]) => v !== "").map(([orgUnitId, v]) => ({ orgUnitId, plannedCount: Number(v) }));
    try { await api.createHeadcountPlan({ name, fiscalYear: year, lines }); setName(""); setYear(""); setCounts({}); load(); } catch (err) { setError(err instanceof ApiError ? err.message : "Could not save the plan."); }
  }

  return (
    <div data-testid="headcount">
      <PageHeader title="Headcount plans" subtitle="Type in how many people each department should have. Today's real headcount and approved open positions are shown beside it." />
      {error && <p className="text-sm text-danger mb-3" role="alert">{error}</p>}
      <form onSubmit={save} className="bg-card rounded-card p-4 shadow-sm space-y-3 mb-6 max-w-2xl">
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label htmlFor="hc-name" className="block text-xs font-medium text-label-secondary mb-1">Plan name</label><input id="hc-name" className={field} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></div>
          <div><label htmlFor="hc-year" className="block text-xs font-medium text-label-secondary mb-1">Year</label><input id="hc-year" className={field} value={year} onChange={(e) => setYear(e.target.value)} placeholder="2026-27" required maxLength={20} /></div>
        </div>
        <div className="space-y-1 max-h-72 overflow-y-auto">
          {units.map((u) => (
            <div key={u.id} className="flex items-center gap-2 text-sm"><label htmlFor={`hc-${u.id}`} className="flex-1">{u.name}</label>
              <input id={`hc-${u.id}`} type="number" min={0} className="w-24 rounded-lg border border-black/10 px-2 py-1 text-sm" value={counts[u.id] ?? ""} onChange={(e) => setCounts({ ...counts, [u.id]: e.target.value })} /></div>
          ))}
          {units.length === 0 && <p className="text-xs text-label-tertiary">Add departments under Organization first.</p>}
        </div>
        <button type="submit" className={btn}>Save plan</button>
      </form>
      {plans === null ? <LoadingNote what="plans" /> : plans.length === 0 ? <p className="text-sm text-label-tertiary">No plans yet.</p> : (
        <div className="space-y-4">
          {plans.map((p) => (
            <div key={p.id} className="bg-card rounded-card p-4 shadow-sm" data-testid="hc-plan">
              <div className="flex items-center gap-3 mb-2"><h2 className="font-semibold flex-1">{p.name} <span className="text-label-tertiary font-normal">{p.fiscalYear}</span></h2>
                <button type="button" className={quiet} onClick={() => api.deleteHeadcountPlan(p.id).then(load).catch((e) => setError(e instanceof ApiError ? e.message : "Could not delete."))}>Delete</button></div>
              <div className="overflow-x-auto"><table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-label-tertiary"><th className="py-1 pr-3">Department</th><th className="pr-3 text-right">Planned</th><th className="pr-3 text-right">Today</th><th className="pr-3 text-right">Still to fill</th><th className="text-right">Approved open positions</th></tr></thead>
                <tbody>{p.lines.map((l) => (
                  <tr key={l.orgUnitId} className="border-t border-black/5"><td className="py-1.5 pr-3">{l.orgUnitName}</td><td className="pr-3 text-right tabular-nums">{l.plannedCount}</td><td className="pr-3 text-right tabular-nums">{l.actualCount}</td>
                    <td className={`pr-3 text-right tabular-nums ${l.difference < 0 ? "text-danger" : ""}`}>{l.difference > 0 ? l.difference : l.difference < 0 ? `${-l.difference} over` : "0"}</td><td className="text-right tabular-nums">{l.openRequisitionPositions}</td></tr>))}
                  <tr className="border-t border-black/20 font-medium"><td className="py-1.5 pr-3">Total</td><td className="pr-3 text-right tabular-nums">{p.totalPlanned}</td><td className="pr-3 text-right tabular-nums">{p.totalActual}</td><td /><td /></tr></tbody>
              </table></div>
              <p className="text-xs text-label-tertiary mt-2">"Today" counts active employees placed directly in the department. Open positions are approved requisitions with the same department name.</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
