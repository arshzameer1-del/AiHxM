import { LoadingNote } from "../shared/PageChrome";
import { FormEvent, useEffect, useState } from "react";
import type { AccrualMethod, LeaveBalanceUnit, LeaveDurationMode, LeaveDurationSettingsView, LeaveGenderRestriction, LeavePolicyView, LeaveRuleHistoryEntry, LeaveTypeView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LeaveDurationSettingsEditor } from "./LeaveDurationSettingsEditor";

const ACCRUAL_LABELS: Record<AccrualMethod, string> = {
  upfront: "Whole year up front",
  monthly: "Accrues monthly",
  none: "Earned (no automatic grant)",
};

export const DURATION_MODE_LABELS: Record<LeaveDurationMode, string> = {
  full_day: "Full days only",
  half_day: "Full or half days",
  short_hours: "Short hours (start and end time)",
  hourly: "By the hour",
  flexible_partial: "Flexible (days, half days or hours)",
};
const UNIT_LABELS: Record<LeaveBalanceUnit, string> = { days: "Days", hours: "Hours", minutes: "Minutes" };

/** Everything about how a short-hours / timed leave type is requested: its own rules plus per-policy overrides, and the change history. */
function TimingRules({ type }: { type: LeaveTypeView }) {
  const [rows, setRows] = useState<LeaveDurationSettingsView[] | null>(null);
  const [policies, setPolicies] = useState<LeavePolicyView[]>([]);
  const [history, setHistory] = useState<LeaveRuleHistoryEntry[] | null>(null);
  const [overrideFor, setOverrideFor] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api.listLeaveDurationSettings(type.code).then(setRows).catch((err) => setError(describeError(err)));
    api.leaveDurationSettingsHistory(type.code).then(setHistory).catch(() => setHistory([]));
  };
  useEffect(() => {
    load();
    api.listLeavePolicies().then(setPolicies).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type.code]);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!rows) return <LoadingNote />;
  const base = rows.find((r) => r.leavePolicyId === null) ?? null;
  const overrides = rows.filter((r) => r.leavePolicyId !== null && r.id !== null);
  const free = policies.filter((p) => !overrides.some((o) => o.leavePolicyId === p.id));
  const policyName = (id: string | null) => policies.find((p) => p.id === id)?.name ?? "Policy";

  return (
    <div className="space-y-4" data-testid={`timing-rules-${type.code}`}>
      <LeaveDurationSettingsEditor code={type.code} policyId={null} initial={base} onSaved={load} idPrefix={`ds-${type.code}`} />

      <div>
        <h4 className="text-sm font-semibold mb-2">Overrides for a leave policy</h4>
        <p className="text-xs text-label-secondary mb-2">A policy can replace these rules for the employees on it (for example a shorter limit for probationers). Without an override a policy uses the rules above.</p>
        {overrides.map((o) => (
          <details key={o.leavePolicyId} className="mb-2 rounded-lg border border-black/10">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{policyName(o.leavePolicyId)} <span className="text-xs text-label-tertiary">version {o.version}</span></summary>
            <div className="p-3">
              <LeaveDurationSettingsEditor code={type.code} policyId={o.leavePolicyId} policyName={policyName(o.leavePolicyId)} initial={o} onSaved={load} onRemoved={load} idPrefix={`ds-${type.code}-${o.leavePolicyId}`} />
            </div>
          </details>
        ))}
        {free.length > 0 && (
          <div className="flex items-center gap-2">
            <label htmlFor={`ov-${type.code}`} className="text-sm">Add an override for</label>
            <select id={`ov-${type.code}`} value={overrideFor} onChange={(e) => setOverrideFor(e.target.value)} className="rounded-lg border border-black/10 px-3 py-1.5 text-sm">
              <option value="">Choose a policy…</option>
              {free.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
        {overrideFor && (
          <div className="mt-3">
            <LeaveDurationSettingsEditor code={type.code} policyId={overrideFor} policyName={policyName(overrideFor)} initial={base ? { ...base, id: null } : null} onSaved={() => { setOverrideFor(""); load(); }} idPrefix={`ds-${type.code}-new`} />
          </div>
        )}
      </div>

      <details>
        <summary className="cursor-pointer text-sm font-semibold">Change history</summary>
        {history && history.length === 0 && <p className="text-xs text-label-tertiary mt-2">No changes recorded yet.</p>}
        <ul className="mt-2 space-y-1 text-xs text-label-secondary">
          {(history ?? []).map((h) => (
            <li key={h.id}>
              {new Date(h.changedAt).toLocaleString()} · version {h.version} · {h.action}
              {typeof h.snapshot.leavePolicyId === "string" ? ` · override for ${policyName(h.snapshot.leavePolicyId)}` : ""}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Leave module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to manage leave types.";
    return err.message;
  }
  return "Something went wrong.";
}

/**
 * TLM-01 - the tenant's leave type catalogue. Built-in types can be renamed and tuned but not
 * removed; Pakistan-typical types (maternity, paternity, Hajj, bereavement, compensatory, short
 * leave) exist switched off - turn one on here, then give it days on a Leave Policy.
 */
export function LeaveTypesPanel() {
  const [types, setTypes] = useState<LeaveTypeView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openRules, setOpenRules] = useState<string | null>(null);
  const [form, setForm] = useState({ code: "", name: "", isPaid: true, accrualMethod: "upfront" as AccrualMethod, genderRestriction: "any" as LeaveGenderRestriction, halfDayAllowed: true, durationMode: "full_day" as LeaveDurationMode, balanceUnit: "days" as LeaveBalanceUnit });
  const [formError, setFormError] = useState<string | null>(null);

  function load() {
    api.listLeaveTypes(true).then(setTypes).catch((err) => setError(describeError(err)));
  }
  useEffect(load, []);

  async function patch(t: LeaveTypeView, change: Parameters<typeof api.updateLeaveType>[1]) {
    setBusyId(t.id);
    setError(null);
    try {
      await api.updateLeaveType(t.id, change);
      load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    try {
      await api.createLeaveType({ ...form, tracksBalance: true });
      setCreating(false);
      setForm({ code: "", name: "", isPaid: true, accrualMethod: "upfront", genderRestriction: "any", halfDayAllowed: true, durationMode: "full_day", balanceUnit: "days" });
      load();
    } catch (err) {
      setFormError(describeError(err));
    }
  }

  if (error && !types) return <p className="text-sm text-danger">{error}</p>;
  if (!types) return <LoadingNote />;

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex items-center justify-between">
        <p className="text-sm text-label-secondary max-w-2xl">
          Leave types available to your employees. A switched-off type cannot be requested. Days per year are set on a
          Leave Policy, not here.
        </p>
        <button onClick={() => setCreating((v) => !v)} className="bg-accent text-white rounded-lg px-3 py-1.5 text-sm font-semibold">
          {creating ? "Close" : "New leave type"}
        </button>
      </div>

      {creating && (
        <form onSubmit={create} className="bg-black/5 rounded-lg p-4 grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="lt-code" className="block text-sm font-medium mb-1">Code</label>
            <input id="lt-code" required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="study_leave"
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm font-mono" />
          </div>
          <div>
            <label htmlFor="lt-name" className="block text-sm font-medium mb-1">Name</label>
            <input id="lt-name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm" />
          </div>
          <div>
            <label htmlFor="lt-accrual" className="block text-sm font-medium mb-1">Accrual</label>
            <select id="lt-accrual" value={form.accrualMethod} onChange={(e) => setForm({ ...form, accrualMethod: e.target.value as AccrualMethod })}
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm">
              {(Object.keys(ACCRUAL_LABELS) as AccrualMethod[]).map((m) => <option key={m} value={m}>{ACCRUAL_LABELS[m]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="lt-gender" className="block text-sm font-medium mb-1">Available to</label>
            <select id="lt-gender" value={form.genderRestriction} onChange={(e) => setForm({ ...form, genderRestriction: e.target.value as LeaveGenderRestriction })}
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm">
              <option value="any">Everyone</option>
              <option value="female">Female employees</option>
              <option value="male">Male employees</option>
            </select>
          </div>
          <div>
            <label htmlFor="lt-mode" className="block text-sm font-medium mb-1">How it is requested</label>
            <select id="lt-mode" value={form.durationMode} onChange={(e) => setForm({ ...form, durationMode: e.target.value as LeaveDurationMode })}
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm">
              {(Object.keys(DURATION_MODE_LABELS) as LeaveDurationMode[]).map((m) => <option key={m} value={m}>{DURATION_MODE_LABELS[m]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="lt-unit" className="block text-sm font-medium mb-1">Balance is kept in</label>
            <select id="lt-unit" value={form.balanceUnit} onChange={(e) => setForm({ ...form, balanceUnit: e.target.value as LeaveBalanceUnit })}
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm">
              {(Object.keys(UNIT_LABELS) as LeaveBalanceUnit[]).map((u) => <option key={u} value={u}>{UNIT_LABELS[u]}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isPaid} onChange={(e) => setForm({ ...form, isPaid: e.target.checked })} /> Paid leave</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.halfDayAllowed} onChange={(e) => setForm({ ...form, halfDayAllowed: e.target.checked })} /> Half days allowed</label>
          {formError && <div className="col-span-2 text-sm text-danger">{formError}</div>}
          <div className="col-span-2"><button type="submit" className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold">Create leave type</button></div>
        </form>
      )}

      <div className="bg-card rounded-card shadow-sm divide-y divide-black/5">
        {types.map((t) => (
          <div key={t.id}>
          <div className="p-4 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="font-medium text-sm">
                {t.name} <span className="font-mono text-xs text-label-tertiary ml-1">{t.code}</span>
                {t.isSystem && <span className="ml-2 text-[11px] uppercase tracking-wide text-label-tertiary">built-in</span>}
              </div>
              <div className="text-xs text-label-secondary mt-1">
                {t.isPaid ? "Paid" : "Unpaid"} · {t.tracksBalance ? ACCRUAL_LABELS[t.accrualMethod] : "No balance"}
                {t.genderRestriction !== "any" && ` · ${t.genderRestriction} only`}
                {` · ${DURATION_MODE_LABELS[t.durationMode]}`}
                {t.balanceUnit !== "days" && ` · balance in ${t.balanceUnit}`}
                {t.documentRequired && ` · document${t.documentRequiredAfterDays > 0 ? ` over ${t.documentRequiredAfterDays}d` : ""}`}
                {t.carryForwardAllowed && " · carries forward"}
                {t.encashable && " · encashable"}
              </div>
            </div>
            <div className="flex flex-col items-end gap-2 shrink-0">
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={t.isActive}
                  disabled={busyId === t.id || (t.isSystem && t.isActive)}
                  onChange={(e) => patch(t, { isActive: e.target.checked })}
                />
                {t.isActive ? "On" : "Off"}
              </label>
              <div className="flex items-center gap-2">
                <label htmlFor={`mode-${t.code}`} className="sr-only">How {t.name} is requested</label>
                <select id={`mode-${t.code}`} value={t.durationMode} disabled={busyId === t.id} onChange={(e) => patch(t, { durationMode: e.target.value as LeaveDurationMode })}
                  className="rounded-lg border border-black/10 px-2 py-1 text-xs">
                  {(Object.keys(DURATION_MODE_LABELS) as LeaveDurationMode[]).map((m) => <option key={m} value={m}>{DURATION_MODE_LABELS[m]}</option>)}
                </select>
                <label htmlFor={`unit-${t.code}`} className="sr-only">Balance unit of {t.name}</label>
                <select id={`unit-${t.code}`} value={t.balanceUnit} disabled={busyId === t.id} onChange={(e) => patch(t, { balanceUnit: e.target.value as LeaveBalanceUnit })}
                  className="rounded-lg border border-black/10 px-2 py-1 text-xs">
                  {(Object.keys(UNIT_LABELS) as LeaveBalanceUnit[]).map((u) => <option key={u} value={u}>{UNIT_LABELS[u]}</option>)}
                </select>
              </div>
              {(t.durationMode === "short_hours" || t.durationMode === "hourly" || t.durationMode === "flexible_partial") && (
                <button type="button" onClick={() => setOpenRules(openRules === t.code ? null : t.code)} className="text-xs font-semibold text-accent hover:underline" aria-expanded={openRules === t.code}>
                  {openRules === t.code ? "Hide timing rules" : "Timing rules"}
                </button>
              )}
            </div>
          </div>
          {openRules === t.code && <div className="px-4 pb-4"><TimingRules type={t} /></div>}
          </div>
        ))}
      </div>
    </div>
  );
}
