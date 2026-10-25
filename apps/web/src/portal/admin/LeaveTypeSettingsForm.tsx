import { FormEvent, useState } from "react";
import type { AccrualMethod, CreateLeaveTypeRequest, LeaveBalanceUnit, LeaveDurationMode, LeaveGenderRestriction, LeaveTypeView } from "@aihxm/shared-types";

const ACCRUAL: Record<AccrualMethod, string> = { upfront: "Whole year up front", monthly: "Accrues monthly", none: "Earned (no automatic grant)" };
const MODES: Record<LeaveDurationMode, string> = {
  full_day: "Full days only", half_day: "Full or half days", short_hours: "Short hours (start and end time)", hourly: "By the hour", flexible_partial: "Flexible (days, half days or hours)",
};
const UNITS: Record<LeaveBalanceUnit, string> = { days: "Days", hours: "Hours", minutes: "Minutes" };

export type LeaveTypeDraft = {
  code: string; name: string; description: string; isPaid: boolean; tracksBalance: boolean; accrualMethod: AccrualMethod;
  genderRestriction: LeaveGenderRestriction; durationMode: LeaveDurationMode; balanceUnit: LeaveBalanceUnit; halfDayAllowed: boolean;
  minServiceMonths: string; maxConsecutiveDays: string; carryForwardAllowed: boolean; carryForwardCapDays: string; carryForwardExpiryMonths: string;
  encashable: boolean; documentRequired: boolean; documentRequiredAfterDays: string; sortOrder: string;
};

export function emptyLeaveTypeDraft(): LeaveTypeDraft {
  return {
    code: "", name: "", description: "", isPaid: true, tracksBalance: true, accrualMethod: "upfront", genderRestriction: "any", durationMode: "full_day", balanceUnit: "days",
    halfDayAllowed: true, minServiceMonths: "0", maxConsecutiveDays: "", carryForwardAllowed: false, carryForwardCapDays: "", carryForwardExpiryMonths: "",
    encashable: false, documentRequired: false, documentRequiredAfterDays: "0", sortOrder: "100",
  };
}

export function draftFromLeaveType(t: LeaveTypeView): LeaveTypeDraft {
  const s = (n: number | null) => (n === null || n === undefined ? "" : String(n));
  return {
    code: t.code, name: t.name, description: t.description ?? "", isPaid: t.isPaid, tracksBalance: t.tracksBalance, accrualMethod: t.accrualMethod,
    genderRestriction: t.genderRestriction, durationMode: t.durationMode, balanceUnit: t.balanceUnit, halfDayAllowed: t.halfDayAllowed,
    minServiceMonths: String(t.minServiceMonths), maxConsecutiveDays: s(t.maxConsecutiveDays), carryForwardAllowed: t.carryForwardAllowed,
    carryForwardCapDays: s(t.carryForwardCapDays), carryForwardExpiryMonths: s(t.carryForwardExpiryMonths), encashable: t.encashable,
    documentRequired: t.documentRequired, documentRequiredAfterDays: String(t.documentRequiredAfterDays), sortOrder: String(t.sortOrder),
  };
}

/** Turns the draft into the API body; returns an error message when a number is not a number. */
export function leaveTypeRequestFromDraft(d: LeaveTypeDraft): { body: Omit<CreateLeaveTypeRequest, "code">; error: string | null } {
  const num = (label: string, v: string, opts: { nullable?: boolean; integer?: boolean } = {}): { value: number | null; error?: string } => {
    if (v.trim() === "") return opts.nullable ? { value: null } : { value: 0 };
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return { value: 0, error: `${label} must be a number, zero or more.` };
    if (opts.integer && !Number.isInteger(n)) return { value: 0, error: `${label} must be a whole number.` };
    return { value: n };
  };
  const checks = [
    num("Minimum service (months)", d.minServiceMonths, { integer: true }),
    num("Longest request (days)", d.maxConsecutiveDays, { nullable: true }),
    num("Carry-forward limit (days)", d.carryForwardCapDays, { nullable: true }),
    num("Carry-forward expiry (months)", d.carryForwardExpiryMonths, { nullable: true, integer: true }),
    num("Document needed above (days)", d.documentRequiredAfterDays),
    num("Display order", d.sortOrder, { integer: true }),
  ];
  const bad = checks.find((c) => c.error);
  const [svc, maxDays, cap, expiry, docDays, order] = checks.map((c) => c.value);
  return {
    error: bad?.error ?? null,
    body: {
      name: d.name.trim(), description: d.description.trim() || null, isPaid: d.isPaid, tracksBalance: d.tracksBalance, accrualMethod: d.accrualMethod,
      genderRestriction: d.genderRestriction, durationMode: d.durationMode, balanceUnit: d.balanceUnit, halfDayAllowed: d.halfDayAllowed,
      minServiceMonths: svc ?? 0, maxConsecutiveDays: maxDays, carryForwardAllowed: d.carryForwardAllowed,
      carryForwardCapDays: d.carryForwardAllowed ? cap : null, carryForwardExpiryMonths: d.carryForwardAllowed ? expiry : null,
      encashable: d.encashable, documentRequired: d.documentRequired, documentRequiredAfterDays: d.documentRequired ? docDays ?? 0 : 0, sortOrder: order ?? 100,
    },
  };
}

const INPUT = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm";

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-label-tertiary mt-1">{hint}</p>}
    </div>
  );
}

/**
 * Every setting of a leave type in one form - used to create a type and to edit one. Nothing here is hidden behind code:
 * who can take it, how it is requested, the balance, carry-forward / encashment, the supporting document and the limits.
 */
export function LeaveTypeSettingsForm({ idPrefix, initial, isNew, isSystem, submitLabel, onSubmit, onCancel }: {
  idPrefix: string; initial: LeaveTypeDraft; isNew: boolean; isSystem: boolean; submitLabel: string;
  onSubmit: (draft: LeaveTypeDraft) => Promise<void> | void; onCancel?: () => void;
}) {
  const [d, setD] = useState<LeaveTypeDraft>(initial);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof LeaveTypeDraft>(key: K, value: LeaveTypeDraft[K]) => setD((cur) => ({ ...cur, [key]: value }));
  const id = (k: string) => `${idPrefix}-${k}`;
  const timed = d.durationMode === "short_hours" || d.durationMode === "hourly" || d.durationMode === "flexible_partial";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try { await onSubmit(d); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="bg-black/5 rounded-lg p-4 grid grid-cols-1 md:grid-cols-2 gap-4" data-testid={`${idPrefix}-form`}>
      {isNew && (
        <Field id={id("code")} label="Code" hint="Lower-case letters, digits and underscores. Cannot be changed later.">
          <input id={id("code")} required value={d.code} onChange={(e) => set("code", e.target.value)} placeholder="study_leave" className={`${INPUT} font-mono`} />
        </Field>
      )}
      <Field id={id("name")} label="Name">
        <input id={id("name")} required value={d.name} onChange={(e) => set("name", e.target.value)} className={INPUT} />
      </Field>
      <div className="md:col-span-2">
        <Field id={id("description")} label="Description" hint="Shown to employees when they pick this leave type.">
          <input id={id("description")} value={d.description} onChange={(e) => set("description", e.target.value)} className={INPUT} />
        </Field>
      </div>

      <Field id={id("mode")} label="How it is requested">
        <select id={id("mode")} value={d.durationMode} onChange={(e) => set("durationMode", e.target.value as LeaveDurationMode)} className={INPUT}>
          {(Object.keys(MODES) as LeaveDurationMode[]).map((m) => <option key={m} value={m}>{MODES[m]}</option>)}
        </select>
      </Field>
      <Field id={id("unit")} label="Balance is kept in">
        <select id={id("unit")} value={d.balanceUnit} onChange={(e) => set("balanceUnit", e.target.value as LeaveBalanceUnit)} className={INPUT}>
          {(Object.keys(UNITS) as LeaveBalanceUnit[]).map((u) => <option key={u} value={u}>{UNITS[u]}</option>)}
        </select>
      </Field>
      <Field id={id("gender")} label="Available to">
        <select id={id("gender")} value={d.genderRestriction} onChange={(e) => set("genderRestriction", e.target.value as LeaveGenderRestriction)} className={INPUT}>
          <option value="any">Everyone</option>
          <option value="female">Female employees</option>
          <option value="male">Male employees</option>
        </select>
      </Field>
      <Field id={id("service")} label="Minimum service (months)" hint="0 = available from the joining date.">
        <input id={id("service")} type="number" min={0} step={1} value={d.minServiceMonths} onChange={(e) => set("minServiceMonths", e.target.value)} className={INPUT} />
      </Field>

      <Field id={id("accrual")} label="Accrual">
        <select id={id("accrual")} value={d.accrualMethod} disabled={!d.tracksBalance} onChange={(e) => set("accrualMethod", e.target.value as AccrualMethod)} className={INPUT}>
          {(Object.keys(ACCRUAL) as AccrualMethod[]).map((m) => <option key={m} value={m}>{ACCRUAL[m]}</option>)}
        </select>
      </Field>
      <Field id={id("maxdays")} label="Longest request (days)" hint={timed ? "For hour-based types set the longest request in minutes under Timing rules." : "Blank = no limit."}>
        <input id={id("maxdays")} type="number" min={0} step="0.5" value={d.maxConsecutiveDays} onChange={(e) => set("maxConsecutiveDays", e.target.value)} className={INPUT} />
      </Field>

      <div className="md:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={d.isPaid} onChange={(e) => set("isPaid", e.target.checked)} /> Paid leave</label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={d.tracksBalance} onChange={(e) => set("tracksBalance", e.target.checked)} /> Keeps a balance (entitlement is set on a Leave Policy)
        </label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={d.halfDayAllowed} onChange={(e) => set("halfDayAllowed", e.target.checked)} /> Half days allowed</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={d.encashable} onChange={(e) => set("encashable", e.target.checked)} /> Unused days can be encashed</label>
      </div>

      <fieldset className="md:col-span-2 border border-black/10 rounded-lg p-3 space-y-2">
        <legend className="px-1 text-sm font-medium">Carry forward</legend>
        <label className="flex items-center gap-2 text-sm"><input id={id("carry")} type="checkbox" checked={d.carryForwardAllowed} onChange={(e) => set("carryForwardAllowed", e.target.checked)} /> Unused balance carries into the next year</label>
        {d.carryForwardAllowed && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field id={id("carrycap")} label="Carry-forward limit (days)" hint="Blank = everything carries.">
              <input id={id("carrycap")} type="number" min={0} step="0.5" value={d.carryForwardCapDays} onChange={(e) => set("carryForwardCapDays", e.target.value)} className={INPUT} />
            </Field>
            <Field id={id("carryexp")} label="Carry-forward expiry (months)" hint="Blank = never expires.">
              <input id={id("carryexp")} type="number" min={0} step={1} value={d.carryForwardExpiryMonths} onChange={(e) => set("carryForwardExpiryMonths", e.target.value)} className={INPUT} />
            </Field>
          </div>
        )}
      </fieldset>

      <fieldset className="md:col-span-2 border border-black/10 rounded-lg p-3 space-y-2">
        <legend className="px-1 text-sm font-medium">Supporting document (attachment)</legend>
        <label className="flex items-center gap-2 text-sm"><input id={id("doc")} type="checkbox" checked={d.documentRequired} onChange={(e) => set("documentRequired", e.target.checked)} /> A supporting document must be attached</label>
        {d.documentRequired && (
          <Field id={id("docdays")} label="Only when the request is longer than (days)" hint={timed ? "0 = always. For short-hours types the threshold can also be set in minutes with an Attachment rule under Leave Rules." : "0 = always required."}>
            <input id={id("docdays")} type="number" min={0} step="0.5" value={d.documentRequiredAfterDays} onChange={(e) => set("documentRequiredAfterDays", e.target.value)} className={`${INPUT} max-w-[10rem]`} />
          </Field>
        )}
      </fieldset>

      <Field id={id("order")} label="Display order" hint="Lower numbers are listed first.">
        <input id={id("order")} type="number" min={0} step={1} value={d.sortOrder} onChange={(e) => set("sortOrder", e.target.value)} className={`${INPUT} max-w-[10rem]`} />
      </Field>
      {isSystem && <p className="text-xs text-label-tertiary self-end">Built-in type: it can be tuned but not removed or re-coded.</p>}

      <div className="md:col-span-2 flex gap-2">
        <button type="submit" disabled={busy} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60">{submitLabel}</button>
        {onCancel && <button type="button" onClick={onCancel} className="rounded-lg border border-black/10 px-4 py-2 text-sm">Cancel</button>}
      </div>
    </form>
  );
}
