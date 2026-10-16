import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { EmployeeView, GoalPlanView, GoalUpdateView, GoalView, ReviewCycleView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { ReasonModal } from "../../components/ReasonModal";
import { ErrorNote, Field, GoalStatusBadge, GOAL_STATUS_LABELS, ProgressBar, errorText, formatDate, inputCls, linkBtn, primaryBtn } from "./perfUi";
import { formatDateTime } from "../shared/dates";

type GoalForm = { title: string; description: string; weight: string; dueDate: string; targetValue: string; targetUnit: string };
const emptyForm: GoalForm = { title: "", description: "", weight: "", dueDate: "", targetValue: "", targetUnit: "" };

/**
 * TAL-05: goals with a due date, target and progress, the extended statuses, an update history and a weight plan that has
 * to add up to exactly 100 before it can be finalised.
 */
export function GoalsPanel() {
  const { identity } = useAuth();
  const roleKeys = identity?.roleKeys ?? [];
  const isHr = roleKeys.includes("hr_admin");
  const isManager = roleKeys.includes("line_manager");

  const [cycles, setCycles] = useState<ReviewCycleView[]>([]);
  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [cycleId, setCycleId] = useState("");
  const [employeeId, setEmployeeId] = useState(identity?.employeeId ?? "");
  const [goals, setGoals] = useState<GoalView[]>([]);
  const [plan, setPlan] = useState<GoalPlanView | null>(null);
  const [form, setForm] = useState<GoalForm>(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyFor, setHistoryFor] = useState<GoalView | null>(null);
  const [history, setHistory] = useState<GoalUpdateView[]>([]);
  const [reopening, setReopening] = useState(false);
  const [progressEdit, setProgressEdit] = useState<{ goal: GoalView; value: string; status: string; note: string } | null>(null);

  useEffect(() => {
    api.listReviewCycles().then((list) => {
      setCycles(list);
      const active = list.find((c) => c.status === "active") ?? list[0];
      if (active) setCycleId(active.id);
    }).catch((err) => setError(errorText(err, "Could not load review cycles")));
    if (isHr || isManager) api.listEmployees().then(setEmployees).catch(() => undefined);
  }, [isHr, isManager]);

  const load = useCallback(async () => {
    if (!cycleId || !employeeId) {
      setGoals([]);
      setPlan(null);
      return;
    }
    try {
      const [g, p] = await Promise.all([api.listGoals({ reviewCycleId: cycleId, employeeId }), api.getGoalPlan(cycleId, employeeId)]);
      setGoals(g);
      setPlan(p);
      setError(null);
    } catch (err) {
      setError(errorText(err, "Could not load goals"));
    }
  }, [cycleId, employeeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const cycle = useMemo(() => cycles.find((c) => c.id === cycleId), [cycles, cycleId]);
  const locked = plan?.status === "finalised" && !isHr;
  const canEditPlan = Boolean(cycleId && employeeId) && cycle?.status !== "closed";

  async function addGoal(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createGoal({
        reviewCycleId: cycleId,
        employeeId,
        title: form.title,
        description: form.description || undefined,
        weight: form.weight ? Number(form.weight) : undefined,
        dueDate: form.dueDate || undefined,
        targetValue: form.targetValue ? Number(form.targetValue) : undefined,
        targetUnit: form.targetUnit || undefined,
      });
      setForm(emptyForm);
      setShowForm(false);
      await load();
    } catch (err) {
      setError(errorText(err, "Could not add the goal"));
    } finally {
      setBusy(false);
    }
  }

  async function saveProgress(e: FormEvent) {
    e.preventDefault();
    if (!progressEdit) return;
    const { goal, value, status, note } = progressEdit;
    setBusy(true);
    try {
      await api.updateGoal(goal.id, {
        ...(value !== "" ? (goal.targetValue ? { currentValue: Number(value) } : { progressPct: Number(value) }) : {}),
        ...(status && status !== goal.status ? { status: status as Exclude<GoalView["status"], "overdue"> } : {}),
        note: note || undefined,
      });
      setProgressEdit(null);
      await load();
    } catch (err) {
      setError(errorText(err, "Could not save the update"));
    } finally {
      setBusy(false);
    }
  }

  async function openHistory(goal: GoalView) {
    setHistoryFor(goal);
    try {
      setHistory(await api.listGoalUpdates(goal.id));
    } catch (err) {
      setError(errorText(err, "Could not load the history"));
    }
  }

  async function finalise() {
    setBusy(true);
    try {
      setPlan(await api.finaliseGoalPlan({ reviewCycleId: cycleId, employeeId }));
      setError(null);
    } catch (err) {
      setError(errorText(err, "Could not finalise the plan"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <ErrorNote message={error} />

      <div className="flex flex-wrap gap-4 items-end">
        <Field label="Review cycle">
          <select className={inputCls} value={cycleId} onChange={(e) => setCycleId(e.target.value)}>
            {cycles.map((c) => (
              <option key={c.id} value={c.id}>{c.name} ({c.status})</option>
            ))}
          </select>
        </Field>
        {(isHr || isManager) && (
          <Field label="Employee">
            <select className={inputCls} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">Choose an employee…</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>{emp.firstName} {emp.lastName} ({emp.employeeNumber})</option>
              ))}
            </select>
          </Field>
        )}
        {cycle?.currentPhase === "goal_setting" && <span className="text-xs bg-accent/10 text-accent-dark rounded px-2 py-1">Goal-setting window is open</span>}
      </div>

      {plan && (
        <div className="bg-card rounded-card shadow-sm p-4 space-y-2">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="text-sm font-semibold">
                Weights: {plan.totalWeight} / 100{" "}
                <span className={`ml-2 text-xs font-semibold px-2 py-0.5 rounded ${plan.status === "finalised" ? "bg-green-100 text-green-700" : "bg-black/5 text-label-secondary"}`}>
                  {plan.status === "finalised" ? "Plan finalised" : "Draft plan"}
                </span>
              </div>
              <div className="text-xs text-label-tertiary">
                {plan.goalCount} goal(s){plan.remainingWeight > 0 ? ` · ${plan.remainingWeight} still to allocate` : ""}
                {plan.reopenedReason ? ` · reopened: ${plan.reopenedReason}` : ""}
              </div>
            </div>
            <div className="flex gap-2">
              {plan.status === "draft" && canEditPlan && (
                <button onClick={finalise} disabled={busy || !plan.isComplete} className={primaryBtn} title={plan.isComplete ? "" : "Weights must add up to exactly 100"}>
                  Finalise plan
                </button>
              )}
              {plan.status === "finalised" && (isHr || isManager) && cycle?.status !== "closed" && (
                <button onClick={() => setReopening(true)} className="rounded-lg border border-black/10 px-4 py-2 text-sm font-semibold">
                  Reopen plan
                </button>
              )}
            </div>
          </div>
          <ProgressBar pct={plan.totalWeight} />
        </div>
      )}

      {canEditPlan && !locked && (
        <div>
          {!showForm ? (
            <button onClick={() => setShowForm(true)} className={primaryBtn}>Add goal</button>
          ) : (
            <form onSubmit={addGoal} className="bg-black/5 rounded-lg p-4 space-y-3">
              <div className="grid sm:grid-cols-2 gap-3">
                <Field label="Title"><input required className={inputCls} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
                <Field label="Due date"><input type="date" className={inputCls} value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></Field>
                <Field label="Weight (%)" hint={plan ? `${plan.remainingWeight} available` : undefined}>
                  <input type="number" min={0} max={100} step="0.01" className={inputCls} value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Target"><input type="number" min={0} step="any" className={inputCls} value={form.targetValue} onChange={(e) => setForm({ ...form, targetValue: e.target.value })} /></Field>
                  <Field label="Unit"><input className={inputCls} placeholder="e.g. tickets" value={form.targetUnit} onChange={(e) => setForm({ ...form, targetUnit: e.target.value })} /></Field>
                </div>
              </div>
              <Field label="Description"><textarea rows={2} className={inputCls} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
              <div className="flex gap-3">
                <button type="submit" disabled={busy} className={primaryBtn}>Save goal</button>
                <button type="button" onClick={() => setShowForm(false)} className="text-sm font-medium text-label-secondary">Cancel</button>
              </div>
            </form>
          )}
        </div>
      )}
      {locked && <p className="text-sm text-label-tertiary">This goal plan is finalised. Ask HR or your manager to reopen it to change goals.</p>}

      {goals.length === 0 ? (
        <div className="text-label-tertiary text-sm">{cycleId && employeeId ? "No goals yet" : "Choose a cycle and an employee to see goals."}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-black/10 text-left">
                <th className="py-2 px-3 font-semibold">Goal</th>
                <th className="py-2 px-3 font-semibold">Weight</th>
                <th className="py-2 px-3 font-semibold">Due</th>
                <th className="py-2 px-3 font-semibold">Progress</th>
                <th className="py-2 px-3 font-semibold">Status</th>
                <th className="py-2 px-3 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {goals.map((g) => (
                <tr key={g.id} className="border-b border-black/5 align-top">
                  <td className="py-3 px-3">
                    <div className="font-medium">{g.title}</div>
                    {g.description && <div className="text-xs text-label-tertiary">{g.description}</div>}
                    {g.targetValue !== null && <div className="text-xs text-label-tertiary">{g.currentValue ?? 0} of {g.targetValue} {g.targetUnit ?? ""}</div>}
                  </td>
                  <td className="py-3 px-3 tabular-nums">{g.weight ?? "-"}</td>
                  <td className="py-3 px-3">{formatDate(g.dueDate)}</td>
                  <td className="py-3 px-3"><ProgressBar pct={g.progressPct} /></td>
                  <td className="py-3 px-3"><GoalStatusBadge status={g.effectiveStatus} /></td>
                  <td className="py-3 px-3 space-x-3 whitespace-nowrap">
                    {g.status !== "cancelled" && cycle?.status !== "closed" && (
                      <button className={linkBtn} onClick={() => setProgressEdit({ goal: g, value: String((g.targetValue ? g.currentValue : g.progressPct) ?? ""), status: g.status, note: "" })}>Update</button>
                    )}
                    <button className={linkBtn} onClick={() => openHistory(g)}>History</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {progressEdit && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50" onClick={() => setProgressEdit(null)}>
          <form onSubmit={saveProgress} onClick={(e) => e.stopPropagation()} className="bg-card rounded-card p-6 shadow-lg max-w-md w-full space-y-4">
            <h2 className="font-bold text-lg">Update “{progressEdit.goal.title}”</h2>
            <Field label={progressEdit.goal.targetValue ? `Current value (${progressEdit.goal.targetUnit ?? "units"})` : "Progress (%)"}>
              <input type="number" min={0} step="any" className={inputCls} value={progressEdit.value} onChange={(e) => setProgressEdit({ ...progressEdit, value: e.target.value })} />
            </Field>
            <Field label="Status">
              <select className={inputCls} value={progressEdit.status} onChange={(e) => setProgressEdit({ ...progressEdit, status: e.target.value })}>
                {(["active", "in_progress", "at_risk", "completed", "cancelled"] as const).map((s) => (
                  <option key={s} value={s}>{GOAL_STATUS_LABELS[s]}</option>
                ))}
              </select>
            </Field>
            <Field label="Note"><textarea rows={2} className={inputCls} value={progressEdit.note} onChange={(e) => setProgressEdit({ ...progressEdit, note: e.target.value })} /></Field>
            <div className="flex gap-3">
              <button type="submit" disabled={busy} className={primaryBtn}>Save</button>
              <button type="button" onClick={() => setProgressEdit(null)} className="text-sm font-medium text-label-secondary">Cancel</button>
            </div>
          </form>
        </div>
      )}

      {historyFor && (
        <div className="bg-card rounded-card shadow-sm p-4 space-y-2">
          <div className="flex justify-between">
            <h3 className="font-semibold text-sm">History: {historyFor.title}</h3>
            <button onClick={() => setHistoryFor(null)} className="text-label-tertiary text-xl leading-none" aria-label="Close history">×</button>
          </div>
          <ul className="divide-y divide-black/5 text-sm">
            {history.map((h) => (
              <li key={h.id} className="py-2">
                <span className="font-medium capitalize">{h.updateType.replace(/_/g, " ")}</span>
                <span className="text-label-tertiary"> · {formatDateTime(h.createdAt)}</span>
                {h.fromStatus !== h.toStatus && h.toStatus && <span> · {h.fromStatus ? `${GOAL_STATUS_LABELS[h.fromStatus]} → ` : ""}{GOAL_STATUS_LABELS[h.toStatus]}</span>}
                {h.progressPct !== null && <span> · {h.progressPct}%</span>}
                {h.note && <div className="text-xs text-label-secondary">{h.note}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {reopening && (
        <ReasonModal
          title="Reopen goal plan"
          description="The employee will be able to change goals and weights again until the plan is finalised."
          confirmLabel="Reopen plan"
          onCancel={() => setReopening(false)}
          onConfirm={async (reason) => {
            setPlan(await api.reopenGoalPlan({ reviewCycleId: cycleId, employeeId, reason }));
            setReopening(false);
          }}
        />
      )}
    </div>
  );
}
