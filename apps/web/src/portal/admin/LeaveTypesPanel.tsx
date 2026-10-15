import { FormEvent, useEffect, useState } from "react";
import type { AccrualMethod, LeaveGenderRestriction, LeaveTypeView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

const ACCRUAL_LABELS: Record<AccrualMethod, string> = {
  upfront: "Whole year up front",
  monthly: "Accrues monthly",
  none: "Earned (no automatic grant)",
};

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
  const [form, setForm] = useState({ code: "", name: "", isPaid: true, accrualMethod: "upfront" as AccrualMethod, genderRestriction: "any" as LeaveGenderRestriction, halfDayAllowed: true });
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
      setForm({ code: "", name: "", isPaid: true, accrualMethod: "upfront", genderRestriction: "any", halfDayAllowed: true });
      load();
    } catch (err) {
      setFormError(describeError(err));
    }
  }

  if (error && !types) return <p className="text-sm text-danger">{error}</p>;
  if (!types) return <p className="text-sm text-label-tertiary">Loading…</p>;

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
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isPaid} onChange={(e) => setForm({ ...form, isPaid: e.target.checked })} /> Paid leave</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.halfDayAllowed} onChange={(e) => setForm({ ...form, halfDayAllowed: e.target.checked })} /> Half days allowed</label>
          {formError && <div className="col-span-2 text-sm text-danger">{formError}</div>}
          <div className="col-span-2"><button type="submit" className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold">Create leave type</button></div>
        </form>
      )}

      <div className="bg-card rounded-card shadow-sm divide-y divide-black/5">
        {types.map((t) => (
          <div key={t.id} className="p-4 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="font-medium text-sm">
                {t.name} <span className="font-mono text-xs text-label-tertiary ml-1">{t.code}</span>
                {t.isSystem && <span className="ml-2 text-[11px] uppercase tracking-wide text-label-tertiary">built-in</span>}
              </div>
              <div className="text-xs text-label-secondary mt-1">
                {t.isPaid ? "Paid" : "Unpaid"} · {t.tracksBalance ? ACCRUAL_LABELS[t.accrualMethod] : "No balance"}
                {t.genderRestriction !== "any" && ` · ${t.genderRestriction} only`}
                {!t.halfDayAllowed && " · no half days"}
                {t.documentRequired && ` · document${t.documentRequiredAfterDays > 0 ? ` over ${t.documentRequiredAfterDays}d` : ""}`}
                {t.carryForwardAllowed && " · carries forward"}
                {t.encashable && " · encashable"}
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs shrink-0">
              <input
                type="checkbox"
                checked={t.isActive}
                disabled={busyId === t.id || (t.isSystem && t.isActive)}
                onChange={(e) => patch(t, { isActive: e.target.checked })}
              />
              {t.isActive ? "On" : "Off"}
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}
