import { FormEvent, useEffect, useMemo, useState } from "react";
import type {
  EmployeeGroupView,
  EmployeeView,
  LeaveDayPart,
  LeavePolicyView,
  LeaveRuleHistoryEntry,
  LeaveRulePreviewResponse,
  LeaveTypeView,
  LeaveValidationFinding,
  LeaveValidationResult,
  LeaveValidationRuleView,
  LeaveValidationSeverity,
  LeaveValidationTypeInfo,
} from "@aihxm/shared-types";
import { LoadingNote } from "../shared/PageChrome";
import { api, ApiError } from "../../api/client";
import { LeaveConditionBuilder } from "./LeaveConditionBuilder";
import { PARAM_META, SEVERITY_LABELS, describeGroup, draftFromRule, draftToRequest, ruleProblem, scopeSummary, type RuleDraft } from "./leaveRules";
import { formatMinutes, formatUnits } from "../leave/leaveUnits";

const inputCls = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent";
const SEVERITY_TONE: Record<LeaveValidationSeverity, string> = {
  block: "bg-danger/10 text-danger",
  warning: "bg-amber-100 text-amber-900",
  info: "bg-black/5 text-label-secondary",
};

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Leave module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to manage leave rules.";
    return err.message;
  }
  return "Something went wrong.";
}

function SeverityPill({ severity }: { severity: LeaveValidationSeverity }) {
  return <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${SEVERITY_TONE[severity]}`}>{SEVERITY_LABELS[severity]}</span>;
}

function FindingList({ title, result, testId }: { title: string; result: LeaveValidationResult; testId: string }) {
  const rows: LeaveValidationFinding[] = [...result.blocking, ...result.warnings, ...result.info];
  return (
    <div className="rounded-lg border border-black/10 p-3 bg-white" data-testid={testId}>
      <div className="text-sm font-semibold mb-1">{title}</div>
      <div className="text-xs text-label-secondary mb-2">
        {result.canSubmit ? "Would be accepted" : result.blocking.length > 0 ? "Would be refused" : "Needs a confirmation"}
        {result.duration ? ` · ${formatMinutes(result.duration.durationMinutes)} · ${formatUnits(result.duration.balanceUnits, result.duration.balanceUnit)}` : ""}
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-label-tertiary">No messages.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((f, i) => (
            <li key={`${f.ruleCode}-${i}`} className="text-xs flex items-start gap-2">
              <SeverityPill severity={f.severity} />
              <span>
                {f.message} <span className="text-label-tertiary font-mono">({f.code})</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Tries the rule as drafted against a sample request, next to what happens without it. Nothing is saved or submitted. */
function RulePreview({ draft, info }: { draft: RuleDraft; info: LeaveValidationTypeInfo | undefined }) {
  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [types, setTypes] = useState<LeaveTypeView[]>([]);
  const [form, setForm] = useState({ employeeId: "", leaveType: "", date: "", dayPart: "full" as LeaveDayPart, startTime: "", endTime: "", reason: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [out, setOut] = useState<LeaveRulePreviewResponse | null>(null);
  useEffect(() => {
    api.listEmployees().then(setEmployees).catch(() => undefined);
    api.listLeaveTypes().then(setTypes).catch(() => undefined);
  }, []);

  async function run(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.employeeId || !form.leaveType || !form.date) return setError("Choose an employee, a leave type and a date.");
    if (form.dayPart === "hours" && (!form.startTime || !form.endTime)) return setError("Enter the start and end time.");
    const allowed = info?.paramKeys ?? [];
    const problem = ruleProblem(draft, allowed as string[]);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      const res = await api.previewLeaveValidationRule({
        rule: { ...draftToRequest(draft, allowed as string[]), ...(draft.id ? { code: draft.code } : {}) },
        request: {
          employeeId: form.employeeId,
          leaveType: form.leaveType,
          startDate: form.date,
          endDate: form.date,
          dayPart: form.dayPart === "full" ? undefined : form.dayPart,
          startTime: form.dayPart === "hours" ? form.startTime : undefined,
          endTime: form.dayPart === "hours" ? form.endTime : undefined,
          reason: form.reason || undefined,
        },
      });
      setOut(res);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3" aria-label="Test this rule" data-testid="rule-preview">
      <h4 className="text-sm font-semibold">Test this rule</h4>
      <p className="text-xs text-label-secondary">Pick a sample request. Nothing is saved or submitted; you see what the employee would see with and without this rule.</p>
      <form onSubmit={run} className="grid sm:grid-cols-3 gap-3">
        <div>
          <label htmlFor="pv-emp" className="block text-xs font-medium mb-1">Employee</label>
          <select id="pv-emp" value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })} className={inputCls}>
            <option value="">Choose…</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName} ({e.employeeNumber})</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="pv-type" className="block text-xs font-medium mb-1">Leave type</label>
          <select id="pv-type" value={form.leaveType} onChange={(e) => setForm({ ...form, leaveType: e.target.value })} className={inputCls}>
            <option value="">Choose…</option>
            {types.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="pv-date" className="block text-xs font-medium mb-1">Date</label>
          <input id="pv-date" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className={inputCls} />
        </div>
        <div>
          <label htmlFor="pv-part" className="block text-xs font-medium mb-1">Length</label>
          <select id="pv-part" value={form.dayPart} onChange={(e) => setForm({ ...form, dayPart: e.target.value as LeaveDayPart })} className={inputCls}>
            <option value="full">Full day</option>
            <option value="first_half">First half</option>
            <option value="second_half">Second half</option>
            <option value="hours">By hours</option>
          </select>
        </div>
        {form.dayPart === "hours" && (
          <>
            <div>
              <label htmlFor="pv-start" className="block text-xs font-medium mb-1">Start time</label>
              <input id="pv-start" type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label htmlFor="pv-end" className="block text-xs font-medium mb-1">End time</label>
              <input id="pv-end" type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} className={inputCls} />
            </div>
          </>
        )}
        <div className="sm:col-span-3">
          <label htmlFor="pv-reason" className="block text-xs font-medium mb-1">Reason (optional)</label>
          <input id="pv-reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className={inputCls} />
        </div>
        <div className="sm:col-span-3">
          <button type="submit" disabled={busy} className="border border-accent text-accent rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">{busy ? "Testing…" : "Run test"}</button>
        </div>
      </form>
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      {out && (
        <div className="space-y-2">
          <p className="text-sm font-medium" data-testid="preview-verdict">
            {out.draftFired ? "This rule fires for the sample request." : "This rule does not fire for the sample request."}
          </p>
          <div className="grid md:grid-cols-2 gap-3">
            <FindingList title="With this rule" result={out.withDraft} testId="preview-with" />
            <FindingList title="Without it (rules as saved)" result={out.withoutDraft} testId="preview-without" />
          </div>
        </div>
      )}
    </section>
  );
}

function RuleHistory({ ruleId }: { ruleId: string }) {
  const [rows, setRows] = useState<LeaveRuleHistoryEntry[] | null>(null);
  useEffect(() => {
    api.leaveValidationRuleHistory(ruleId).then(setRows).catch(() => setRows([]));
  }, [ruleId]);
  return (
    <details data-testid="rule-history">
      <summary className="cursor-pointer text-sm font-semibold">Change history</summary>
      {!rows ? <LoadingNote /> : rows.length === 0 ? <p className="text-xs text-label-tertiary mt-2">No changes recorded.</p> : (
        <ul className="mt-2 space-y-1 text-xs text-label-secondary">
          {rows.map((h) => (
            <li key={h.id}>
              {new Date(h.changedAt).toLocaleString()} · version {h.version} · {h.action}
              {typeof h.snapshot.severity === "string" ? ` · ${h.snapshot.severity}` : ""}
              {typeof h.snapshot.isActive === "boolean" ? (h.snapshot.isActive ? " · on" : " · off") : ""}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function CheckList({ legend, items, selected, onChange }: { legend: string; items: Array<{ id: string; name: string }>; selected: string[]; onChange: (ids: string[]) => void }) {
  if (items.length === 0) return null;
  return (
    <fieldset>
      <legend className="text-sm font-medium mb-1">{legend}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {items.map((i) => (
          <label key={i.id} className="flex items-center gap-1.5">
            <input type="checkbox" checked={selected.includes(i.id)} onChange={(e) => onChange(e.target.checked ? [...selected, i.id] : selected.filter((x) => x !== i.id))} /> {i.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function RuleEditor({
  rule,
  catalog,
  types,
  policies,
  groups,
  onSaved,
  onCancel,
}: {
  rule: LeaveValidationRuleView | null;
  catalog: LeaveValidationTypeInfo[];
  types: LeaveTypeView[];
  policies: LeavePolicyView[];
  groups: EmployeeGroupView[];
  onSaved: (notices?: string[]) => void;
  onCancel: () => void;
}) {
  const first = catalog.find((c) => !c.locked) ?? catalog[0];
  const [draft, setDraft] = useState<RuleDraft>(() => draftFromRule(rule, { validationType: first.type, message: first.defaultMessage, severity: first.defaultSeverity }));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const info = catalog.find((c) => c.type === draft.validationType);
  const allowed = (info?.paramKeys ?? []) as string[];
  const set = <K extends keyof RuleDraft>(k: K, v: RuleDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const locked = draft.isLocked || Boolean(info?.locked);

  function changeType(type: string) {
    const next = catalog.find((c) => c.type === type);
    if (!next) return;
    setDraft((d) => ({ ...d, validationType: type, message: next.defaultMessage, severity: next.defaultSeverity, params: {}, isLocked: next.locked }));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const problem = ruleProblem(draft, allowed);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      const body = draftToRequest(draft, allowed);
      const saved = draft.id ? await api.updateLeaveValidationRule(draft.id, body) : await api.createLeaveValidationRule(body);
      onSaved(saved.notices);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!draft.id) return;
    setBusy(true);
    try {
      await api.deleteLeaveValidationRule(draft.id);
      onSaved();
    } catch (err) {
      setError(describe(err));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6" data-testid="rule-editor">
      <form onSubmit={save} className="space-y-4 bg-black/5 rounded-lg p-4" aria-label={draft.id ? "Edit leave rule" : "New leave rule"}>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="rule-name" className="block text-sm font-medium mb-1">Rule name</label>
            <input id="rule-name" value={draft.name} onChange={(e) => set("name", e.target.value)} className={inputCls} />
          </div>
          <div>
            <label htmlFor="rule-type" className="block text-sm font-medium mb-1">What it checks</label>
            <select id="rule-type" value={draft.validationType} disabled={Boolean(draft.id)} onChange={(e) => changeType(e.target.value)} className={inputCls}>
              {catalog.map((c) => <option key={c.type} value={c.type}>{c.number}. {c.label}{c.locked ? " (always blocks)" : ""}</option>)}
            </select>
            {info && <p className="text-xs text-label-tertiary mt-1">{info.description}</p>}
          </div>
          <div>
            <label htmlFor="rule-severity" className="block text-sm font-medium mb-1">When it fails</label>
            <select id="rule-severity" value={locked ? "block" : draft.severity} disabled={locked} onChange={(e) => set("severity", e.target.value as LeaveValidationSeverity)} className={inputCls}>
              <option value="block">Block - the request cannot be submitted</option>
              <option value="warning">Warning - the employee can confirm and submit</option>
              <option value="info">Info - a notice only</option>
            </select>
            {locked && <p className="text-xs text-label-tertiary mt-1">This check protects the request itself, so it always blocks and cannot be switched off. You can reword its message.</p>}
          </div>
          <div>
            <label htmlFor="rule-priority" className="block text-sm font-medium mb-1">Priority</label>
            <input id="rule-priority" type="number" min={1} value={draft.priority} onChange={(e) => set("priority", e.target.value)} className={inputCls} />
            <p className="text-xs text-label-tertiary mt-1">Lower numbers are tried first; the first rule of a kind that fires gives the message.</p>
          </div>
        </div>

        <div>
          <label htmlFor="rule-message" className="block text-sm font-medium mb-1">Message the employee sees</label>
          <textarea id="rule-message" rows={2} value={draft.message} onChange={(e) => set("message", e.target.value)} className={inputCls} />
          {info && info.placeholders.length > 0 && (
            <p className="text-xs text-label-tertiary mt-1">
              You can insert:{" "}
              {info.placeholders.map((p) => (
                <button key={p} type="button" className="font-mono text-accent hover:underline mr-2" onClick={() => set("message", `${draft.message} {{${p}}}`.trim())}>{`{{${p}}}`}</button>
              ))}
            </p>
          )}
        </div>

        <fieldset>
          <legend className="text-sm font-medium mb-1">Translations</legend>
          {draft.messages.map((m, i) => (
            <div key={i} className="flex gap-2 mb-2">
              <input aria-label={`Translation ${i + 1} language`} value={m.locale} onChange={(e) => set("messages", draft.messages.map((x, j) => (j === i ? { ...x, locale: e.target.value } : x)))} placeholder="ur" className={`${inputCls} w-20`} />
              <input aria-label={`Translation ${i + 1} text`} value={m.text} onChange={(e) => set("messages", draft.messages.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} className={inputCls} />
              <button type="button" className="text-xs font-semibold text-danger hover:underline" onClick={() => set("messages", draft.messages.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <button type="button" className="text-xs font-semibold text-accent hover:underline" onClick={() => set("messages", [...draft.messages, { locale: "", text: "" }])}>+ Add a translation</button>
        </fieldset>

        <div>
          <label htmlFor="rule-explain" className="block text-sm font-medium mb-1">Note for administrators</label>
          <textarea id="rule-explain" rows={2} value={draft.adminExplanation} onChange={(e) => set("adminExplanation", e.target.value)} className={inputCls} placeholder="Why this rule exists. Employees do not see this." />
        </div>

        {allowed.length > 0 && (
          <fieldset className="grid sm:grid-cols-3 gap-4">
            <legend className="text-sm font-medium mb-1">Limits for this rule</legend>
            {PARAM_META.filter((m) => allowed.includes(m.key)).map((m) => (
              <div key={m.key}>
                <label htmlFor={`param-${m.key}`} className="block text-xs font-medium mb-1">{m.label}</label>
                {m.kind === "period" ? (
                  <select id={`param-${m.key}`} value={draft.params[m.key] ?? ""} onChange={(e) => set("params", { ...draft.params, [m.key]: e.target.value })} className={inputCls}>
                    <option value="">Use the leave type's rules</option>
                    <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option><option value="year">Year</option>
                  </select>
                ) : m.kind === "holiday" ? (
                  <select id={`param-${m.key}`} value={draft.params[m.key] ?? ""} onChange={(e) => set("params", { ...draft.params, [m.key]: e.target.value })} className={inputCls}>
                    <option value="">Only when nothing is left to charge</option>
                    <option value="any_in_range">Any holiday inside the request</option>
                  </select>
                ) : (
                  <input id={`param-${m.key}`} type={m.kind === "number" ? "number" : "text"} min={m.kind === "number" ? 0 : undefined} value={draft.params[m.key] ?? ""} onChange={(e) => set("params", { ...draft.params, [m.key]: e.target.value })} className={inputCls} />
                )}
                {m.hint && <p className="text-xs text-label-tertiary mt-1">{m.hint}</p>}
              </div>
            ))}
          </fieldset>
        )}

        <div className="space-y-3">
          <h4 className="text-sm font-semibold">Who and what it applies to</h4>
          <CheckList legend="Leave types (none ticked = all)" items={types.map((t) => ({ id: t.code, name: t.name }))} selected={draft.leaveTypes} onChange={(v) => set("leaveTypes", v)} />
          <CheckList legend="Leave policies (none ticked = all)" items={policies.map((p) => ({ id: p.id, name: p.name }))} selected={draft.policyIds} onChange={(v) => set("policyIds", v)} />
          <CheckList legend="Employee groups (none ticked = all)" items={groups.map((g) => ({ id: g.id, name: g.name }))} selected={draft.employeeGroupIds} onChange={(v) => set("employeeGroupIds", v)} />
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="rule-from" className="block text-xs font-medium mb-1">Effective from</label>
              <input id="rule-from" type="date" value={draft.effectiveFrom} onChange={(e) => set("effectiveFrom", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label htmlFor="rule-to" className="block text-xs font-medium mb-1">Effective until</label>
              <input id="rule-to" type="date" value={draft.effectiveTo} onChange={(e) => set("effectiveTo", e.target.value)} className={inputCls} />
            </div>
          </div>
        </div>

        <div>
          <h4 className="text-sm font-semibold mb-1">Only when (optional)</h4>
          <LeaveConditionBuilder root={draft.conditions} onChange={(g) => set("conditions", g)} leaveTypes={types.map((t) => ({ code: t.code, name: t.name }))} />
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={locked ? true : draft.isActive} disabled={locked} onChange={(e) => set("isActive", e.target.checked)} /> Rule is active</label>
          {draft.severity === "warning" && !locked && (
            <label className="flex items-center gap-2"><input type="checkbox" checked={draft.allowProceed} onChange={(e) => set("allowProceed", e.target.checked)} /> Employee may submit after confirming the warning</label>
          )}
        </div>

        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
        <div className="flex items-center gap-3">
          <button type="submit" disabled={busy} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">{busy ? "Saving…" : draft.id ? "Save rule" : "Create rule"}</button>
          <button type="button" onClick={onCancel} className="text-sm font-semibold text-label-secondary hover:underline">Close</button>
          {draft.id && !draft.isSystem && <button type="button" disabled={busy} onClick={() => void remove()} className="ml-auto text-sm font-semibold text-danger hover:underline">Delete rule</button>}
        </div>
      </form>

      <RulePreview draft={draft} info={info} />
      {draft.id && <RuleHistory ruleId={draft.id} />}
    </div>
  );
}

/**
 * BACKLOG58 - the leave validation rules. Every company has one built-in rule for each of the twenty checks; an
 * administrator rewords them, re-orders them, scopes them to a leave type, policy or group, lowers the ones that are not
 * safety checks to a warning, or adds more rules of the same kinds. Nothing here accepts code, SQL or an expression.
 */
export function LeaveRulesPanel() {
  const [rules, setRules] = useState<LeaveValidationRuleView[] | null>(null);
  const [catalog, setCatalog] = useState<LeaveValidationTypeInfo[]>([]);
  const [types, setTypes] = useState<LeaveTypeView[]>([]);
  const [policies, setPolicies] = useState<LeavePolicyView[]>([]);
  const [groups, setGroups] = useState<EmployeeGroupView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<LeaveValidationRuleView | "new" | null>(null);
  const [filter, setFilter] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saveNotices, setSaveNotices] = useState<string[]>([]);

  function load() {
    api.listLeaveValidationRules().then(setRules).catch((err) => setError(describe(err)));
  }
  useEffect(() => {
    load();
    api.leaveValidationCatalog().then(setCatalog).catch((err) => setError(describe(err)));
    api.listLeaveTypes(true).then(setTypes).catch(() => undefined);
    api.listLeavePolicies().then(setPolicies).catch(() => undefined);
    api.listEmployeeGroups().then(setGroups).catch(() => undefined);
  }, []);

  const typeName = (code: string) => types.find((t) => t.code === code)?.name ?? code;
  const labelOf = (type: string) => catalog.find((c) => c.type === type);
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (rules ?? [])
      .filter((r) => needle === "" || `${r.name} ${r.code} ${labelOf(r.validationType)?.label ?? ""}`.toLowerCase().includes(needle))
      .sort((a, b) => (labelOf(a.validationType)?.number ?? 99) - (labelOf(b.validationType)?.number ?? 99) || a.priority - b.priority);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules, filter, catalog]);

  async function toggle(r: LeaveValidationRuleView) {
    setBusyId(r.id);
    setError(null);
    try {
      await api.updateLeaveValidationRule(r.id, { isActive: !r.isActive });
      load();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusyId(null);
    }
  }

  if (error && !rules) return <p className="text-sm text-danger">{error}</p>;
  if (!rules || catalog.length === 0) return <LoadingNote />;

  if (editing) {
    return (
      <div className="space-y-3">
        <button type="button" onClick={() => setEditing(null)} className="text-sm font-semibold text-accent hover:underline">← All leave rules</button>
        <RuleEditor
          key={editing === "new" ? "new" : editing.id}
          rule={editing === "new" ? null : editing}
          catalog={catalog}
          types={types}
          policies={policies}
          groups={groups}
          onSaved={(notices) => { setEditing(null); setSaveNotices(notices ?? []); load(); }}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="leave-rules-panel">
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      {saveNotices.length > 0 && (
        <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 space-y-1" data-testid="rule-priority-notice">
          <div className="font-semibold">Saved. Please check the order of your rules:</div>
          {saveNotices.map((n) => (
            <p key={n}>{n}</p>
          ))}
          <button type="button" onClick={() => setSaveNotices([])} className="text-xs font-semibold underline">Dismiss</button>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-label-secondary max-w-2xl">
          The checks every leave request goes through before it can be submitted. Each company starts with one rule per check; reword them, scope them to a leave type, policy or group, or add your own. A <b>block</b> stops the request, a <b>warning</b> lets the employee confirm and continue, an <b>info</b> is just a notice.
        </p>
        <div className="flex items-center gap-2">
          <label htmlFor="rules-filter" className="sr-only">Search rules</label>
          <input id="rules-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search rules" className="rounded-lg border border-black/10 px-3 py-1.5 text-sm" />
          <button type="button" onClick={() => setEditing("new")} className="bg-accent text-white rounded-lg px-3 py-1.5 text-sm font-semibold">New rule</button>
        </div>
      </div>

      <div className="bg-card rounded-card shadow-sm overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead>
            <tr className="text-left text-xs text-label-tertiary border-b border-black/10">
              <th className="py-2 px-4 font-medium">Rule</th>
              <th className="py-2 pr-3 font-medium">Applies to</th>
              <th className="py-2 pr-3 font-medium">Priority</th>
              <th className="py-2 pr-3 font-medium">When it fails</th>
              <th className="py-2 pr-3 font-medium">Active</th>
              <th className="py-2 pr-4" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="border-b border-black/5 last:border-0 align-top" data-testid={`rule-row-${r.code}`}>
                <td className="py-2.5 px-4">
                  <div className="font-medium">{r.name}{r.isSystem && <span className="ml-2 text-[11px] uppercase tracking-wide text-label-tertiary">built-in</span>}</div>
                  <div className="text-xs text-label-secondary">{labelOf(r.validationType)?.number}. {labelOf(r.validationType)?.label}{r.conditions && r.conditions.children.length > 0 ? ` · ${describeGroup(r.conditions)}` : ""}</div>
                </td>
                <td className="py-2.5 pr-3 text-label-secondary">{scopeSummary(r, typeName)}</td>
                <td className="py-2.5 pr-3 tabular-nums">{r.priority}</td>
                <td className="py-2.5 pr-3"><SeverityPill severity={r.severity} />{r.isLocked && <span className="ml-1 text-[11px] text-label-tertiary">fixed</span>}</td>
                <td className="py-2.5 pr-3">
                  <input type="checkbox" aria-label={`${r.name} active`} checked={r.isActive} disabled={r.isLocked || busyId === r.id} onChange={() => void toggle(r)} />
                </td>
                <td className="py-2.5 pr-4 text-right">
                  <button type="button" onClick={() => setEditing(r)} className="text-xs font-semibold text-accent hover:underline" aria-label={`Edit ${r.name}`}>Edit</button>
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr><td colSpan={6} className="py-4 px-4 text-label-tertiary">No rules match.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
