import { FormEvent, useEffect, useState } from "react";
import type {
  ShiftView,
  WorkScheduleAssignmentRuleView,
  WorkScheduleRuleCondition,
  WorkScheduleRuleExpression,
  WorkScheduleRuleOperator,
} from "@boostfactor/shared-types";
import { api, ApiError } from "../../api/client";
import { CONDITION_FIELDS, CONDITION_FIELD_LABELS } from "./conditionLabels";

/**
 * Section 15's Assignment Rule authoring UI (WS-023, "Assignment
 * Administration") — the second real Rules Engine consumer
 * (`work_schedule_assignment_rules`, shipped 2026-09-18) had a real,
 * tested, live-verified API from day one but no admin screen.
 *
 * Deliberate scope decision, consistent with the Rules Engine's own
 * "don't build a general authoring UI ahead of real demand" discipline:
 * this editor builds only a FLAT AND-of-conditions expression (the exact
 * shape Employee Groups' own condition matcher already uses, now backed
 * by the same engine) — not a full nested AND/OR/NOT tree builder. The
 * engine and the API both support arbitrary nesting; nothing has named a
 * real need for it in an assignment rule yet, and a rule created with
 * nested logic via direct API use still displays correctly here (as a
 * read-only summary), it just can't be edited from this screen without
 * being reduced back to a flat AND first.
 */

const OPERATORS: WorkScheduleRuleOperator[] = ["equals", "notEquals", "in", "notIn", "isEmpty", "isNotEmpty"];
const OPERATOR_LABELS: Record<WorkScheduleRuleOperator, string> = {
  equals: "is",
  notEquals: "is not",
  in: "is one of",
  notIn: "is not one of",
  greaterThan: "is greater than",
  greaterThanOrEqual: "is at least",
  lessThan: "is less than",
  lessThanOrEqual: "is at most",
  between: "is between",
  contains: "contains",
  isEmpty: "is empty",
  isNotEmpty: "is not empty",
};

function needsValue(operator: WorkScheduleRuleOperator): boolean {
  return operator !== "isEmpty" && operator !== "isNotEmpty";
}

function isFlatAll(expr: WorkScheduleRuleExpression): expr is { all: WorkScheduleRuleCondition[] } {
  return (
    typeof expr === "object" &&
    expr !== null &&
    "all" in expr &&
    Array.isArray((expr as { all: unknown[] }).all) &&
    (expr as { all: unknown[] }).all.every(
      (c) => typeof c === "object" && c !== null && "field" in c && "operator" in c && !("all" in c) && !("any" in c) && !("not" in c)
    )
  );
}

function conditionValueText(c: WorkScheduleRuleCondition): string {
  if (!needsValue(c.operator)) return "";
  if (Array.isArray(c.value)) return c.value.join(", ");
  return c.value === undefined || c.value === null ? "" : String(c.value);
}

function conditionSummary(c: WorkScheduleRuleCondition): string {
  const label = CONDITION_FIELD_LABELS[c.field as keyof typeof CONDITION_FIELD_LABELS] ?? c.field;
  return needsValue(c.operator) ? `${label} ${OPERATOR_LABELS[c.operator]} ${conditionValueText(c)}` : `${label} ${OPERATOR_LABELS[c.operator]}`;
}

type ConditionDraft = { field: string; operator: WorkScheduleRuleOperator; value: string };

type RuleFormValue = {
  name: string;
  priority: string;
  scheduleId: string;
  isActive: boolean;
  conditions: ConditionDraft[];
};

function emptyForm(shifts: ShiftView[], initial?: WorkScheduleAssignmentRuleView): RuleFormValue {
  const conditions: ConditionDraft[] =
    initial && isFlatAll(initial.conditionExpression)
      ? initial.conditionExpression.all.map((c) => ({ field: c.field, operator: c.operator, value: conditionValueText(c) }))
      : [{ field: "department", operator: "equals", value: "" }];
  return {
    name: initial?.name ?? "",
    priority: String(initial?.priority ?? 100),
    scheduleId: initial?.scheduleId ?? shifts[0]?.id ?? "",
    isActive: initial?.isActive ?? true,
    conditions,
  };
}

function toExpression(conditions: ConditionDraft[]): WorkScheduleRuleExpression {
  return {
    all: conditions.map((c): WorkScheduleRuleCondition => {
      if (!needsValue(c.operator)) return { field: c.field, operator: c.operator };
      if (c.operator === "in" || c.operator === "notIn") {
        return { field: c.field, operator: c.operator, value: c.value.split(",").map((v) => v.trim()).filter(Boolean) };
      }
      return { field: c.field, operator: c.operator, value: c.value };
    }),
  };
}

function RuleForm({
  shifts,
  initial,
  onCancel,
  onSaved,
}: {
  shifts: ShiftView[];
  initial?: WorkScheduleAssignmentRuleView;
  onCancel: () => void;
  onSaved: (rule: WorkScheduleAssignmentRuleView) => void;
}) {
  const [value, setValue] = useState<RuleFormValue>(() => emptyForm(shifts, initial));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function updateCondition(index: number, patch: Partial<ConditionDraft>) {
    setValue((v) => ({ ...v, conditions: v.conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)) }));
  }

  function addCondition() {
    setValue((v) => ({ ...v, conditions: [...v.conditions, { field: "department", operator: "equals", value: "" }] }));
  }

  function removeCondition(index: number) {
    setValue((v) => ({ ...v, conditions: v.conditions.filter((_, i) => i !== index) }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const payload = {
        name: value.name,
        priority: Number(value.priority) || 100,
        scheduleId: value.scheduleId,
        isActive: value.isActive,
        conditionExpression: toExpression(value.conditions),
      };
      const saved = initial ? await api.updateAssignmentRule(initial.id, payload) : await api.createAssignmentRule(payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this rule.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-black/5 rounded-lg p-4">
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Name</label>
          <input
            required
            value={value.name}
            onChange={(e) => setValue((v) => ({ ...v, name: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Priority (lower wins ties)</label>
          <input
            type="number"
            value={value.priority}
            onChange={(e) => setValue((v) => ({ ...v, priority: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Applies schedule</label>
          <select
            required
            value={value.scheduleId}
            onChange={(e) => setValue((v) => ({ ...v, scheduleId: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="" disabled>
              Select a schedule…
            </option>
            {shifts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium">Conditions — an employee must match every one</label>
          <button type="button" onClick={addCondition} className="text-xs font-semibold text-accent hover:underline">
            + Add condition
          </button>
        </div>
        <div className="space-y-2">
          {value.conditions.map((condition, i) => (
            <div key={i} className="flex gap-2 items-center flex-wrap">
              <select
                value={condition.field}
                onChange={(e) => updateCondition(i, { field: e.target.value })}
                className="rounded-lg border border-black/10 px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              >
                {CONDITION_FIELDS.map((f) => (
                  <option key={f} value={f}>
                    {CONDITION_FIELD_LABELS[f]}
                  </option>
                ))}
              </select>
              <select
                value={condition.operator}
                onChange={(e) => updateCondition(i, { operator: e.target.value as WorkScheduleRuleOperator })}
                className="rounded-lg border border-black/10 px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              >
                {OPERATORS.map((op) => (
                  <option key={op} value={op}>
                    {OPERATOR_LABELS[op]}
                  </option>
                ))}
              </select>
              {needsValue(condition.operator) && (
                <input
                  required
                  value={condition.value}
                  onChange={(e) => updateCondition(i, { value: e.target.value })}
                  placeholder={condition.operator === "in" || condition.operator === "notIn" ? "e.g. Lahore, Karachi" : "e.g. Engineering"}
                  className="flex-1 min-w-[10rem] rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
              )}
              {value.conditions.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeCondition(i)}
                  aria-label="Remove condition"
                  className="text-label-tertiary hover:text-danger px-1"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.isActive}
          onChange={(e) => setValue((v) => ({ ...v, isActive: e.target.checked }))}
          className="rounded border-black/20"
        />
        Active
      </label>

      {error && <div className="text-danger text-sm">{error}</div>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting || shifts.length === 0}
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {submitting ? "Saving…" : initial ? "Save changes" : "Create rule"}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function RuleRow({
  rule,
  shifts,
  onChanged,
}: {
  rule: WorkScheduleAssignmentRuleView;
  shifts: ShiftView[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDelete() {
    if (!window.confirm(`Delete the "${rule.name}" assignment rule? This cannot be undone.`)) return;
    setDeleteError(null);
    try {
      await api.deleteAssignmentRule(rule.id);
      onChanged();
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Could not delete this rule.");
    }
  }

  if (editing) {
    return (
      <div className="bg-card rounded-card p-5 shadow-sm">
        <RuleForm
          shifts={shifts}
          initial={rule}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      </div>
    );
  }

  const conditions = isFlatAll(rule.conditionExpression) ? rule.conditionExpression.all : null;

  return (
    <div className="bg-card rounded-card p-5 shadow-sm">
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">{rule.name}</h3>
            {!rule.isActive && (
              <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-black/5 text-label-tertiary">
                Inactive
              </span>
            )}
          </div>
          <p className="text-sm text-label-tertiary mt-0.5">
            Priority {rule.priority} · assigns <span className="font-medium text-label-secondary">{rule.scheduleName}</span>
          </p>
        </div>
        <div className="flex gap-3 shrink-0">
          <button onClick={() => setEditing(true)} className="text-xs font-semibold text-accent hover:underline">
            Edit
          </button>
          <button onClick={handleDelete} className="text-xs font-medium text-label-tertiary hover:text-danger">
            Delete
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {conditions ? (
          conditions.map((c, i) => (
            <span key={i} className="inline-block px-2.5 py-0.5 rounded-full text-xs font-medium bg-black/5 text-label-secondary">
              {conditionSummary(c)}
            </span>
          ))
        ) : (
          <span className="text-xs text-label-tertiary italic">
            Complex condition set (created outside this screen) — edit via the API.
          </span>
        )}
      </div>
      {deleteError && <p className="text-xs text-danger mt-2">{deleteError}</p>}
    </div>
  );
}

export function WorkScheduleAssignmentRulesPanel({ shifts }: { shifts: ShiftView[] }) {
  const [rules, setRules] = useState<WorkScheduleAssignmentRuleView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  function load() {
    api.listAssignmentRules().then(setRules).catch((err) => setError(err instanceof ApiError ? err.message : "Could not load assignment rules."));
  }

  useEffect(load, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Assignment rules</h2>
          <p className="text-sm text-label-tertiary mt-0.5">
            Give an employee a schedule automatically by attribute — e.g. "Department is Engineering" — instead of
            (or on top of) a direct per-employee assignment. When more than one rule matches, the most specific one
            wins; a direct assignment always wins over any rule.
          </p>
        </div>
        {!creating && shifts.length > 0 && (
          <button
            onClick={() => setCreating(true)}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold shrink-0 ml-4"
          >
            New Rule
          </button>
        )}
      </div>

      {error && <div className="bg-card rounded-card p-4 shadow-sm text-sm text-label-secondary">{error}</div>}

      {creating && (
        <div className="bg-card rounded-card p-5 shadow-sm">
          <RuleForm
            shifts={shifts}
            onCancel={() => setCreating(false)}
            onSaved={() => {
              setCreating(false);
              load();
            }}
          />
        </div>
      )}

      {rules === null && !error && <div className="text-label-tertiary text-sm">Loading…</div>}

      {rules && rules.length === 0 && !creating && (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
          No assignment rules yet. Employees fall back to a direct assignment, or the company default schedule.
        </div>
      )}

      {rules && rules.map((rule) => <RuleRow key={rule.id} rule={rule} shifts={shifts} onChanged={load} />)}
    </div>
  );
}
