import { FormEvent, useEffect, useState } from "react";
import type {
  LeaveBreakTreatment,
  LeaveDurationSettingsView,
  LeaveFrequencyPeriod,
  LeaveSameDayPolicy,
  LeaveSelectionMethod,
  SetLeaveDurationSettingsRequest,
  WorkflowTemplate,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

/**
 * BACKLOG58 - the timing rules of one leave type, or of one leave policy's override of them. Every field starts empty:
 * an empty limit means "no limit". Nothing here is a built-in default; the numbers an administrator types are the rules.
 */

type Draft = {
  selectionMethod: LeaveSelectionMethod;
  earliestStartTime: string;
  latestEndTime: string;
  fixedStartTime: string;
  fixedEndTime: string;
  minDurationMinutes: string;
  maxDurationMinutes: string;
  incrementMinutes: string;
  breakTreatment: LeaveBreakTreatment;
  validateAgainstSchedule: boolean;
  allowOvernight: boolean;
  sameDayPolicy: LeaveSameDayPolicy;
  minNoticeMinutes: string;
  backdateDaysAllowed: string;
  dailyLimitMinutes: string;
  monthlyLimitMinutes: string;
  frequencyMaxRequests: string;
  frequencyPeriod: LeaveFrequencyPeriod | "";
  dayEquivalentMinutes: string;
  workflowTemplateKey: string;
  isActive: boolean;
};

const num = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
const time = (v: string | null | undefined) => (v ? v.slice(0, 5) : "");

export function toDraft(s: LeaveDurationSettingsView | null): Draft {
  return {
    selectionMethod: s?.selectionMethod ?? "employee_selected",
    earliestStartTime: time(s?.earliestStartTime),
    latestEndTime: time(s?.latestEndTime),
    fixedStartTime: time(s?.fixedStartTime),
    fixedEndTime: time(s?.fixedEndTime),
    minDurationMinutes: num(s?.minDurationMinutes),
    maxDurationMinutes: num(s?.maxDurationMinutes),
    incrementMinutes: num(s?.incrementMinutes),
    breakTreatment: s?.breakTreatment ?? "exclude_unpaid",
    validateAgainstSchedule: s?.validateAgainstSchedule ?? true,
    allowOvernight: s?.allowOvernight ?? false,
    sameDayPolicy: s?.sameDayPolicy ?? "unrestricted",
    minNoticeMinutes: num(s?.minNoticeMinutes),
    backdateDaysAllowed: num(s?.backdateDaysAllowed),
    dailyLimitMinutes: num(s?.dailyLimitMinutes),
    monthlyLimitMinutes: num(s?.monthlyLimitMinutes),
    frequencyMaxRequests: num(s?.frequencyMaxRequests),
    frequencyPeriod: s?.frequencyPeriod ?? "",
    dayEquivalentMinutes: num(s?.dayEquivalentMinutes),
    workflowTemplateKey: s?.workflowTemplateKey ?? "",
    isActive: s?.isActive ?? true,
  };
}

const orNull = (v: string): number | null => (v.trim() === "" ? null : Number(v));
const timeOrNull = (v: string): string | null => (v.trim() === "" ? null : v);

export function toRequest(d: Draft): SetLeaveDurationSettingsRequest {
  return {
    selectionMethod: d.selectionMethod,
    earliestStartTime: timeOrNull(d.earliestStartTime),
    latestEndTime: timeOrNull(d.latestEndTime),
    fixedStartTime: timeOrNull(d.fixedStartTime),
    fixedEndTime: timeOrNull(d.fixedEndTime),
    minDurationMinutes: orNull(d.minDurationMinutes),
    maxDurationMinutes: orNull(d.maxDurationMinutes),
    incrementMinutes: orNull(d.incrementMinutes),
    breakTreatment: d.breakTreatment,
    validateAgainstSchedule: d.validateAgainstSchedule,
    allowOvernight: d.allowOvernight,
    sameDayPolicy: d.sameDayPolicy,
    minNoticeMinutes: orNull(d.minNoticeMinutes),
    backdateDaysAllowed: orNull(d.backdateDaysAllowed),
    dailyLimitMinutes: orNull(d.dailyLimitMinutes),
    monthlyLimitMinutes: orNull(d.monthlyLimitMinutes),
    frequencyMaxRequests: orNull(d.frequencyMaxRequests),
    frequencyPeriod: d.frequencyPeriod === "" ? null : d.frequencyPeriod,
    dayEquivalentMinutes: orNull(d.dayEquivalentMinutes),
    workflowTemplateKey: d.workflowTemplateKey.trim() === "" ? null : d.workflowTemplateKey,
    isActive: d.isActive,
  };
}

/** Problems found before anything is sent; the server checks the same things again. */
export function draftProblem(d: Draft): string | null {
  const min = orNull(d.minDurationMinutes);
  const max = orNull(d.maxDurationMinutes);
  if (min !== null && max !== null && min > max) return "The minimum duration cannot be longer than the maximum.";
  for (const [label, v] of [["Minimum duration", min], ["Maximum duration", max], ["Increment", orNull(d.incrementMinutes)], ["Daily limit", orNull(d.dailyLimitMinutes)], ["Monthly limit", orNull(d.monthlyLimitMinutes)], ["Minimum notice", orNull(d.minNoticeMinutes)], ["Backdating", orNull(d.backdateDaysAllowed)], ["Requests per period", orNull(d.frequencyMaxRequests)], ["Minutes in a working day", orNull(d.dayEquivalentMinutes)]] as const) {
    if (v !== null && (!Number.isFinite(v) || v < 0)) return `${label} must be a number, zero or more.`;
  }
  const inc = orNull(d.incrementMinutes);
  if (inc !== null && inc < 1) return "The increment must be at least 1 minute (or empty).";
  if (d.selectionMethod === "fixed_window" && (!d.fixedStartTime || !d.fixedEndTime)) return "A fixed window needs a start and an end time.";
  if (d.selectionMethod === "fixed_window" && d.fixedStartTime >= d.fixedEndTime && !d.allowOvernight) return "The fixed window must end after it starts.";
  if (d.earliestStartTime && d.latestEndTime && d.earliestStartTime >= d.latestEndTime && !d.allowOvernight) return "The latest end must be after the earliest start.";
  if ((orNull(d.frequencyMaxRequests) !== null) !== (d.frequencyPeriod !== "")) return "Set both the number of requests and the period, or neither.";
  return null;
}

const inputCls = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent";

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-label-tertiary mt-1">{hint}</p>}
    </div>
  );
}

export function LeaveDurationSettingsEditor({
  code,
  policyId,
  policyName,
  initial,
  onSaved,
  onRemoved,
  idPrefix,
}: {
  code: string;
  policyId: string | null;
  policyName?: string;
  initial: LeaveDurationSettingsView | null;
  onSaved: (saved: LeaveDurationSettingsView) => void;
  onRemoved?: () => void;
  idPrefix: string;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(toDraft(initial)), [initial]);
  useEffect(() => {
    api.listWorkflowTemplates().then((all) => setTemplates(all.filter((t) => t.objectKey === "leave_request" && t.isActive))).catch(() => undefined);
  }, []);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const id = (name: string) => `${idPrefix}-${name}`;

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const problem = draftProblem(draft);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      const saved = policyId ? await api.setPolicyLeaveDurationSettings(code, policyId, toRequest(draft)) : await api.setLeaveDurationSettings(code, toRequest(draft));
      setNotice(`Saved (version ${saved.version}).`);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save these rules.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!policyId) return;
    setBusy(true);
    setError(null);
    try {
      await api.removePolicyLeaveDurationSettings(code, policyId);
      onRemoved?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove this override.");
    } finally {
      setBusy(false);
    }
  }

  const fixed = draft.selectionMethod === "fixed_window";
  return (
    <form onSubmit={save} className="space-y-4 bg-black/5 rounded-lg p-4" aria-label={policyId ? `Timing rules for ${policyName ?? "policy"}` : "Timing rules"} data-testid="duration-settings-form">
      <p className="text-xs text-label-secondary">
        {policyId
          ? `These rules replace the leave type's own rules for employees on the policy "${policyName ?? ""}". Leave a field empty for no limit.`
          : "Leave a field empty for no limit. Durations are in minutes; times are 24-hour wall-clock times in the employee's work-schedule time zone."}
      </p>

      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="How the times are chosen" htmlFor={id("method")}>
          <select id={id("method")} value={draft.selectionMethod} onChange={(e) => set("selectionMethod", e.target.value as LeaveSelectionMethod)} className={inputCls}>
            <option value="employee_selected">Employee picks start and end</option>
            <option value="fixed_window">One fixed window</option>
          </select>
        </Field>
        <Field label="Request step (minutes)" htmlFor={id("increment")} hint="Start and end must fall on this step, e.g. 15 = quarter hours.">
          <input id={id("increment")} type="number" min={1} value={draft.incrementMinutes} onChange={(e) => set("incrementMinutes", e.target.value)} className={inputCls} />
        </Field>

        {fixed ? (
          <>
            <Field label="Fixed window starts" htmlFor={id("fixed-start")}>
              <input id={id("fixed-start")} type="time" value={draft.fixedStartTime} onChange={(e) => set("fixedStartTime", e.target.value)} className={inputCls} />
            </Field>
            <Field label="Fixed window ends" htmlFor={id("fixed-end")}>
              <input id={id("fixed-end")} type="time" value={draft.fixedEndTime} onChange={(e) => set("fixedEndTime", e.target.value)} className={inputCls} />
            </Field>
          </>
        ) : (
          <>
            <Field label="Earliest start" htmlFor={id("earliest")}>
              <input id={id("earliest")} type="time" value={draft.earliestStartTime} onChange={(e) => set("earliestStartTime", e.target.value)} className={inputCls} />
            </Field>
            <Field label="Latest end" htmlFor={id("latest")}>
              <input id={id("latest")} type="time" value={draft.latestEndTime} onChange={(e) => set("latestEndTime", e.target.value)} className={inputCls} />
            </Field>
          </>
        )}

        <Field label="Shortest request (minutes)" htmlFor={id("min")}>
          <input id={id("min")} type="number" min={0} value={draft.minDurationMinutes} onChange={(e) => set("minDurationMinutes", e.target.value)} className={inputCls} />
        </Field>
        <Field label="Longest request (minutes)" htmlFor={id("max")}>
          <input id={id("max")} type="number" min={0} value={draft.maxDurationMinutes} onChange={(e) => set("maxDurationMinutes", e.target.value)} className={inputCls} />
        </Field>

        <Field label="Breaks inside the request" htmlFor={id("breaks")}>
          <select id={id("breaks")} value={draft.breakTreatment} onChange={(e) => set("breakTreatment", e.target.value as LeaveBreakTreatment)} className={inputCls}>
            <option value="exclude_unpaid">Do not count unpaid breaks</option>
            <option value="exclude_all">Do not count any break</option>
            <option value="include">Count breaks as leave</option>
          </select>
        </Field>
        <Field label="Which days" htmlFor={id("sameday")}>
          <select id={id("sameday")} value={draft.sameDayPolicy} onChange={(e) => set("sameDayPolicy", e.target.value as LeaveSameDayPolicy)} className={inputCls}>
            <option value="unrestricted">Any day</option>
            <option value="same_day_only">Same day only</option>
            <option value="future_only">Future days only (not today)</option>
          </select>
        </Field>

        <Field label="Minimum notice (minutes)" htmlFor={id("notice")}>
          <input id={id("notice")} type="number" min={0} value={draft.minNoticeMinutes} onChange={(e) => set("minNoticeMinutes", e.target.value)} className={inputCls} />
        </Field>
        <Field label="Backdating allowed (days)" htmlFor={id("backdate")} hint="Empty = nothing in the past.">
          <input id={id("backdate")} type="number" min={0} value={draft.backdateDaysAllowed} onChange={(e) => set("backdateDaysAllowed", e.target.value)} className={inputCls} />
        </Field>

        <Field label="Daily limit (minutes)" htmlFor={id("daily")}>
          <input id={id("daily")} type="number" min={0} value={draft.dailyLimitMinutes} onChange={(e) => set("dailyLimitMinutes", e.target.value)} className={inputCls} />
        </Field>
        <Field label="Monthly limit (minutes)" htmlFor={id("monthly")}>
          <input id={id("monthly")} type="number" min={0} value={draft.monthlyLimitMinutes} onChange={(e) => set("monthlyLimitMinutes", e.target.value)} className={inputCls} />
        </Field>

        <Field label="At most … requests" htmlFor={id("freq")}>
          <input id={id("freq")} type="number" min={0} value={draft.frequencyMaxRequests} onChange={(e) => set("frequencyMaxRequests", e.target.value)} className={inputCls} />
        </Field>
        <Field label="… per" htmlFor={id("period")}>
          <select id={id("period")} value={draft.frequencyPeriod} onChange={(e) => set("frequencyPeriod", e.target.value as LeaveFrequencyPeriod | "")} className={inputCls}>
            <option value="">No frequency limit</option>
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
            <option value="year">Year</option>
          </select>
        </Field>

        <Field label="Minutes in a working day" htmlFor={id("dayminutes")} hint="Used to turn hours into days. Empty = the employee's own shift length.">
          <input id={id("dayminutes")} type="number" min={1} value={draft.dayEquivalentMinutes} onChange={(e) => set("dayEquivalentMinutes", e.target.value)} className={inputCls} />
        </Field>
        <Field label="Approval route" htmlFor={id("workflow")} hint="Empty = the standard leave request route.">
          <select id={id("workflow")} value={draft.workflowTemplateKey} onChange={(e) => set("workflowTemplateKey", e.target.value)} className={inputCls}>
            <option value="">Standard leave request route</option>
            {templates.map((t) => (
              <option key={t.key} value={t.key}>{t.name}</option>
            ))}
          </select>
        </Field>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={draft.validateAgainstSchedule} onChange={(e) => set("validateAgainstSchedule", e.target.checked)} /> Must fall inside the employee&apos;s shift</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={draft.allowOvernight} onChange={(e) => set("allowOvernight", e.target.checked)} /> Allow requests that run past midnight</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={draft.isActive} onChange={(e) => set("isActive", e.target.checked)} /> These rules are active</label>
      </div>

      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      {notice && <p className="text-sm text-label-secondary" role="status">{notice}</p>}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">{busy ? "Saving…" : "Save timing rules"}</button>
        {policyId && (
          <button type="button" disabled={busy} onClick={() => void remove()} className="text-sm font-semibold text-danger hover:underline">Remove this override</button>
        )}
      </div>
    </form>
  );
}
