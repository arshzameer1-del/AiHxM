import { FormEvent, useCallback, useEffect, useState } from "react";
import type { GoalAlignmentNode, GoalView, KeyResultView, KeyResultsResultView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { ErrorNote, Field, GoalStatusBadge, ProgressBar, errorText, inputCls, linkBtn, primaryBtn } from "./perfUi";

type KrForm = { title: string; startValue: string; targetValue: string; unit: string; weight: string };
const emptyKr: KrForm = { title: "", startValue: "0", targetValue: "", unit: "", weight: "1" };
const fmt = (n: number) => new Intl.NumberFormat("en-PK", { maximumFractionDigits: 2 }).format(n);

/**
 * The measurable results under one goal. A check-in updates the key result; the goal's progress follows as the weighted average,
 * so the goal itself is no longer typed in by hand once it has key results.
 */
export function KeyResultsPanel({ goal, canShape, canCheckIn, onChanged }: { goal: GoalView; canShape: boolean; canCheckIn: boolean; onChanged: () => void }) {
  const [data, setData] = useState<KeyResultsResultView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<KeyResultView | null>(null);
  const [form, setForm] = useState<KrForm>(emptyKr);
  const [checkIn, setCheckIn] = useState<{ kr: KeyResultView; value: string; note: string } | null>(null);

  const load = useCallback(() => {
    api.listKeyResults(goal.id).then((r) => { setData(r); setError(null); }).catch((e) => setError(errorText(e, "Could not load key results")));
  }, [goal.id]);
  useEffect(load, [load]);

  async function run(fn: () => Promise<KeyResultsResultView>, fallback: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      setData(await fn());
      onChanged();
      return true;
    } catch (e) {
      setError(errorText(e, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const body = {
      title: form.title.trim(), startValue: Number(form.startValue || 0), targetValue: Number(form.targetValue),
      unit: form.unit.trim() || null, weight: Number(form.weight || 1),
    };
    const ok = await run(() => (editing ? api.updateKeyResult(editing.id, body) : api.createKeyResult(goal.id, body)), "Could not save the key result");
    if (ok) { setAdding(false); setEditing(null); setForm(emptyKr); }
  }

  async function submitCheckIn(e: FormEvent) {
    e.preventDefault();
    if (!checkIn) return;
    const ok = await run(() => api.checkInKeyResult(checkIn.kr.id, { currentValue: Number(checkIn.value), note: checkIn.note.trim() || null }), "Could not save the check-in");
    if (ok) setCheckIn(null);
  }

  const startEdit = (kr: KeyResultView) => {
    setEditing(kr);
    setAdding(true);
    setForm({ title: kr.title, startValue: String(kr.startValue), targetValue: String(kr.targetValue), unit: kr.unit ?? "", weight: String(kr.weight) });
  };

  return (
    <section className="bg-black/[0.03] rounded-lg p-4 space-y-3" aria-label={`Key results for ${goal.title}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-sm font-semibold">Key results</h3>
        {canShape && !adding && (
          <button className={linkBtn} onClick={() => { setEditing(null); setForm(emptyKr); setAdding(true); }}>Add a key result</button>
        )}
      </div>
      <ErrorNote message={error} />
      {!data ? <p className="text-xs text-label-tertiary">Loading…</p> : data.keyResults.length === 0 ? (
        <p className="text-xs text-label-tertiary">No key results yet. Add measurable results and the goal's progress will follow them.</p>
      ) : (
        <ul className="space-y-3">
          {data.keyResults.map((kr) => (
            <li key={kr.id} className="text-sm">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="font-medium">{kr.title}</div>
                  <div className="text-xs text-label-tertiary tabular-nums">
                    {fmt(kr.startValue)} → {fmt(kr.targetValue)} {kr.unit ?? ""} · now {fmt(kr.currentValue)} · weight {fmt(kr.weight)}
                  </div>
                </div>
                <span className="flex items-center gap-3 shrink-0">
                  {canCheckIn && <button className={linkBtn} onClick={() => setCheckIn({ kr, value: String(kr.currentValue), note: "" })}>Check in</button>}
                  {canShape && <button className={linkBtn} onClick={() => startEdit(kr)}>Edit</button>}
                  {canShape && <button className="text-xs text-label-tertiary hover:text-danger" onClick={() => run(() => api.removeKeyResult(kr.id), "Could not remove the key result")}>Remove</button>}
                </span>
              </div>
              <div className="mt-1 max-w-sm"><ProgressBar pct={kr.progressPct} /></div>
            </li>
          ))}
        </ul>
      )}

      {checkIn && (
        <form onSubmit={submitCheckIn} className="bg-card rounded-lg p-3 space-y-2" aria-label={`Check in on ${checkIn.kr.title}`}>
          <Field label={`Current value${checkIn.kr.unit ? ` (${checkIn.kr.unit})` : ""}`}>
            <input type="number" step="any" required className={inputCls} value={checkIn.value} onChange={(e) => setCheckIn({ ...checkIn, value: e.target.value })} />
          </Field>
          <Field label="Note (optional)"><input className={inputCls} value={checkIn.note} onChange={(e) => setCheckIn({ ...checkIn, note: e.target.value })} /></Field>
          <div className="flex gap-3">
            <button type="submit" disabled={busy} className={primaryBtn}>Save check-in</button>
            <button type="button" onClick={() => setCheckIn(null)} className="text-sm font-medium text-label-secondary">Cancel</button>
          </div>
        </form>
      )}

      {adding && (
        <form onSubmit={save} className="bg-card rounded-lg p-3 space-y-2" aria-label={editing ? "Edit key result" : "New key result"}>
          <Field label="Key result"><input required className={inputCls} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Close 10 recurring bugs" /></Field>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Field label="Start"><input type="number" step="any" className={inputCls} value={form.startValue} onChange={(e) => setForm({ ...form, startValue: e.target.value })} /></Field>
            <Field label="Target"><input type="number" step="any" required className={inputCls} value={form.targetValue} onChange={(e) => setForm({ ...form, targetValue: e.target.value })} /></Field>
            <Field label="Unit"><input className={inputCls} value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="bugs, %, PKR" /></Field>
            <Field label="Weight" hint="Relative: 3 counts three times 1"><input type="number" min="0.01" step="any" className={inputCls} value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} /></Field>
          </div>
          <div className="flex gap-3">
            <button type="submit" disabled={busy} className={primaryBtn}>{editing ? "Save key result" : "Add key result"}</button>
            <button type="button" onClick={() => { setAdding(false); setEditing(null); }} className="text-sm font-medium text-label-secondary">Cancel</button>
          </div>
        </form>
      )}
      {data && data.keyResults.length > 0 && (
        <p className="text-xs text-label-secondary">Goal progress follows these key results: {fmt(data.goalProgressPct)}%.</p>
      )}
    </section>
  );
}

/** Goals of a cycle as a tree: company or department goals at the top, the goals that serve them beneath. */
export function GoalAlignmentTree({ cycleId }: { cycleId: string }) {
  const [nodes, setNodes] = useState<GoalAlignmentNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setNodes(null);
    api.getGoalAlignment(cycleId).then(setNodes).catch((e) => { setNodes([]); setError(errorText(e, "Could not load the alignment")); });
  }, [cycleId]);

  if (!nodes) return <p className="text-sm text-label-tertiary">Loading…</p>;
  const kids = new Map<string | null, GoalAlignmentNode[]>();
  for (const n of nodes) kids.set(n.parentGoalId, [...(kids.get(n.parentGoalId) ?? []), n]);

  const render = (n: GoalAlignmentNode, depth: number) => (
    <li key={n.goalId}>
      <div className="flex items-center gap-3 py-1.5 text-sm" style={{ paddingLeft: depth * 20 }}>
        <span className={`font-medium ${n.isContext ? "text-label-tertiary" : ""}`}>{n.title}</span>
        <span className="text-xs text-label-tertiary">{n.employeeName}{n.keyResultCount > 0 ? ` · ${n.keyResultCount} key result${n.keyResultCount === 1 ? "" : "s"}` : ""}</span>
        <span className="w-28 shrink-0 ml-auto"><ProgressBar pct={n.progressPct} /></span>
        <GoalStatusBadge status={n.status} />
      </div>
      {(kids.get(n.goalId) ?? []).length > 0 && <ul>{(kids.get(n.goalId) ?? []).map((c) => render(c, depth + 1))}</ul>}
    </li>
  );

  return (
    <div className="bg-card rounded-card shadow-sm p-4" aria-label="Goal alignment">
      <ErrorNote message={error} />
      {nodes.length === 0 ? <p className="text-sm text-label-tertiary">No goals to show for this cycle.</p> : <ul className="divide-y divide-black/5">{(kids.get(null) ?? []).map((n) => render(n, 0))}</ul>}
      <p className="text-xs text-label-tertiary mt-3">Grey titles are parent goals shown only to place yours; you can see their progress but not open them.</p>
    </div>
  );
}
