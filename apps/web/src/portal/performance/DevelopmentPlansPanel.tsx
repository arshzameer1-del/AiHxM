import { FormEvent, useCallback, useEffect, useState } from "react";
import type { CompetencyView, DevelopmentItemStatus, DevelopmentItemType, DevelopmentPlanStatus, DevelopmentPlanView, EmployeeView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { ErrorNote, Field, errorText, formatDate, inputCls, primaryBtn } from "./perfUi";

const ITEM_TYPES: DevelopmentItemType[] = ["course", "mentoring", "coaching", "project", "stretch_assignment", "reading", "other"];
const PLAN_STATUSES: DevelopmentPlanStatus[] = ["draft", "active", "completed", "cancelled"];
const ITEM_STATUSES: DevelopmentItemStatus[] = ["not_started", "in_progress", "done"];
const label = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** TAL-06: development plans, optionally tied to a competency, with actions that track their own status. */
export function DevelopmentPlansPanel() {
  const { identity } = useAuth();
  const roleKeys = identity?.roleKeys ?? [];
  const canManageOthers = roleKeys.includes("hr_admin") || roleKeys.includes("line_manager");

  const [plans, setPlans] = useState<DevelopmentPlanView[]>([]);
  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [competencies, setCompetencies] = useState<CompetencyView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ employeeId: identity?.employeeId ?? "", title: "", objective: "", targetDate: "" });
  const [newItem, setNewItem] = useState<Record<string, { action: string; itemType: DevelopmentItemType; competencyId: string; dueDate: string }>>({});

  const load = useCallback(async () => {
    try {
      setPlans(await api.listDevelopmentPlans());
      setError(null);
    } catch (err) {
      setError(errorText(err, "Could not load development plans"));
    }
  }, []);

  useEffect(() => {
    void load();
    api.listCompetencies().then(setCompetencies).catch(() => undefined);
    api.listEmployees().then(setEmployees).catch(() => undefined);
  }, [load]);

  const nameOf = (id: string) => {
    const e = employees.find((x) => x.id === id);
    return e ? `${e.firstName} ${e.lastName}` : "Me";
  };
  const replace = (p: DevelopmentPlanView) => setPlans((list) => list.map((x) => (x.id === p.id ? p : x)));
  const run = async (fn: () => Promise<void>, fallback: string) => {
    try {
      await fn();
      setError(null);
    } catch (err) {
      setError(errorText(err, fallback));
    }
  };

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    await run(async () => {
      await api.createDevelopmentPlan({ employeeId: form.employeeId, title: form.title, objective: form.objective || undefined, targetDate: form.targetDate || undefined });
      setCreating(false);
      setForm({ ...form, title: "", objective: "", targetDate: "" });
      await load();
    }, "Could not create the plan");
    setBusy(false);
  }

  return (
    <div className="space-y-4">
      <ErrorNote message={error} />
      {!creating ? (
        <button className={primaryBtn} onClick={() => setCreating(true)}>New development plan</button>
      ) : (
        <form onSubmit={create} className="bg-black/5 rounded-lg p-4 space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            {canManageOthers && (
              <Field label="Employee">
                <select required className={inputCls} value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
                  <option value="">Choose…</option>
                  {employees.map((x) => <option key={x.id} value={x.id}>{x.firstName} {x.lastName} ({x.employeeNumber})</option>)}
                </select>
              </Field>
            )}
            <Field label="Title"><input required className={inputCls} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
            <Field label="Target date"><input type="date" className={inputCls} value={form.targetDate} onChange={(e) => setForm({ ...form, targetDate: e.target.value })} /></Field>
          </div>
          <Field label="Objective"><textarea rows={2} className={inputCls} value={form.objective} onChange={(e) => setForm({ ...form, objective: e.target.value })} /></Field>
          <div className="flex gap-3">
            <button type="submit" disabled={busy} className={primaryBtn}>Create</button>
            <button type="button" onClick={() => setCreating(false)} className="text-sm font-medium text-label-secondary">Cancel</button>
          </div>
        </form>
      )}

      {plans.length === 0 && <p className="text-sm text-label-tertiary">No development plans yet.</p>}
      {plans.map((p) => {
        const draft = newItem[p.id] ?? { action: "", itemType: "course" as DevelopmentItemType, competencyId: "", dueDate: "" };
        return (
          <div key={p.id} className="bg-card rounded-card shadow-sm p-4 space-y-3">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <div className="font-semibold">{p.title}</div>
                <div className="text-xs text-label-tertiary">{nameOf(p.employeeId)}{p.targetDate ? ` · target ${formatDate(p.targetDate)}` : ""}</div>
                {p.objective && <div className="text-sm text-label-secondary mt-1">{p.objective}</div>}
              </div>
              <select aria-label={`Status of ${p.title}`} className="rounded-lg border border-black/10 px-2 py-1 text-sm" value={p.status}
                onChange={(e) => run(async () => replace(await api.updateDevelopmentPlan(p.id, { status: e.target.value as DevelopmentPlanStatus })), "Could not update the plan")}>
                {PLAN_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
              </select>
            </div>
            <ul className="divide-y divide-black/5 text-sm">
              {p.items.map((it) => (
                <li key={it.id} className="py-2 flex items-center justify-between gap-3 flex-wrap">
                  <span>
                    <span className="text-xs bg-black/5 rounded px-1.5 py-0.5 mr-2">{label(it.itemType)}</span>
                    {it.action}
                    {it.competencyId && <span className="text-xs text-label-tertiary"> · {competencies.find((c) => c.id === it.competencyId)?.name ?? "competency"}</span>}
                    {it.dueDate && <span className="text-xs text-label-tertiary"> · due {formatDate(it.dueDate)}</span>}
                  </span>
                  <span className="flex items-center gap-2">
                    <select aria-label={`Status of ${it.action}`} className="rounded border border-black/10 px-2 py-1 text-xs" value={it.status}
                      onChange={(e) => run(async () => replace(await api.updateDevelopmentPlanItem(it.id, { status: e.target.value as DevelopmentItemStatus })), "Could not update the action")}>
                      {ITEM_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
                    </select>
                    <button className="text-xs text-danger" onClick={() => run(async () => replace(await api.removeDevelopmentPlanItem(it.id)), "Could not remove the action")}>Remove</button>
                  </span>
                </li>
              ))}
            </ul>
            <form className="grid sm:grid-cols-[1fr_9rem_9rem_8rem_auto] gap-2 items-end" onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                replace(await api.addDevelopmentPlanItem(p.id, { action: draft.action, itemType: draft.itemType, competencyId: draft.competencyId || undefined, dueDate: draft.dueDate || undefined }));
                setNewItem({ ...newItem, [p.id]: { ...draft, action: "" } });
              }, "Could not add the action");
            }}>
              <input aria-label="New action" required placeholder="Add an action…" className={inputCls} value={draft.action} onChange={(e) => setNewItem({ ...newItem, [p.id]: { ...draft, action: e.target.value } })} />
              <select aria-label="Action type" className={inputCls} value={draft.itemType} onChange={(e) => setNewItem({ ...newItem, [p.id]: { ...draft, itemType: e.target.value as DevelopmentItemType } })}>
                {ITEM_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}
              </select>
              <select aria-label="Competency" className={inputCls} value={draft.competencyId} onChange={(e) => setNewItem({ ...newItem, [p.id]: { ...draft, competencyId: e.target.value } })}>
                <option value="">No competency</option>
                {competencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <input aria-label="Due date" type="date" className={inputCls} value={draft.dueDate} onChange={(e) => setNewItem({ ...newItem, [p.id]: { ...draft, dueDate: e.target.value } })} />
              <button type="submit" className={primaryBtn}>Add</button>
            </form>
          </div>
        );
      })}
    </div>
  );
}
