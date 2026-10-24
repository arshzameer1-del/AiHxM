import type { LeaveConditionField, LeaveConditionOperator, LeaveRuleCondition, LeaveRuleConditionGroup } from "@aihxm/shared-types";
import {
  CONDITION_FIELDS,
  OPERATOR_LABELS,
  WEEKDAYS,
  changeField,
  changeOperator,
  clockToMinutes,
  describeGroup,
  emptyGroup,
  fieldInfo,
  groupDepth,
  isCondition,
  minutesToClock,
  newCondition,
  operatorsFor,
  updateAt,
} from "./leaveRules";

const inputCls = "rounded-lg border border-black/10 px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-accent";

/** One value box: a number, a time of day, a weekday, a yes/no or free text, depending on the field. */
function ValueInput({ condition, index, onChange, leaveTypes, label }: { condition: LeaveRuleCondition; index?: number; onChange: (v: string | number | boolean) => void; leaveTypes: Array<{ code: string; name: string }>; label: string }) {
  const kind = fieldInfo(condition.field).kind;
  const raw = Array.isArray(condition.value) ? condition.value[index ?? 0] : condition.value;
  if (kind === "bool") {
    return (
      <select aria-label={label} value={raw ? "yes" : "no"} onChange={(e) => onChange(e.target.value === "yes")} className={inputCls}>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    );
  }
  if (kind === "weekday") {
    return (
      <select aria-label={label} value={String(raw ?? 0)} onChange={(e) => onChange(Number(e.target.value))} className={inputCls}>
        {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
      </select>
    );
  }
  if (kind === "time") {
    return <input aria-label={label} type="time" value={minutesToClock(Number(raw ?? 0))} onChange={(e) => { const m = clockToMinutes(e.target.value); if (m !== null) onChange(m); }} className={inputCls} />;
  }
  if (kind === "number") {
    return <input aria-label={label} type="number" value={String(raw ?? 0)} onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))} className={`${inputCls} w-28`} />;
  }
  if (condition.field === "leaveType") {
    return (
      <select aria-label={label} value={String(raw ?? "")} onChange={(e) => onChange(e.target.value)} className={inputCls}>
        <option value="">Choose…</option>
        {leaveTypes.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
      </select>
    );
  }
  return <input aria-label={label} type="text" value={String(raw ?? "")} onChange={(e) => onChange(e.target.value)} className={`${inputCls} w-40`} placeholder="e.g. permanent" />;
}

function ConditionRow({ condition, leaveTypes, onChange, onRemove, n }: { condition: LeaveRuleCondition; leaveTypes: Array<{ code: string; name: string }>; onChange: (c: LeaveRuleCondition) => void; onRemove: () => void; n: number }) {
  const kind = fieldInfo(condition.field).kind;
  const isList = condition.operator === "in" || condition.operator === "not_in";
  const isBetween = condition.operator === "between";
  const list = Array.isArray(condition.value) ? condition.value : [];
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="condition-row">
      <select aria-label={`Condition ${n} field`} value={condition.field} onChange={(e) => onChange(changeField(condition, e.target.value as LeaveConditionField))} className={inputCls}>
        {CONDITION_FIELDS.map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}
      </select>
      <select aria-label={`Condition ${n} operator`} value={condition.operator} onChange={(e) => onChange(changeOperator(condition, e.target.value as LeaveConditionOperator))} className={inputCls}>
        {operatorsFor(kind).map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>)}
      </select>
      {isBetween ? (
        <>
          <ValueInput condition={condition} index={0} label={`Condition ${n} from`} leaveTypes={leaveTypes} onChange={(v) => onChange({ ...condition, value: [v as number, (list[1] ?? v) as number] })} />
          <span className="text-xs text-label-secondary">and</span>
          <ValueInput condition={condition} index={1} label={`Condition ${n} to`} leaveTypes={leaveTypes} onChange={(v) => onChange({ ...condition, value: [(list[0] ?? v) as number, v as number] })} />
        </>
      ) : isList ? (
        kind === "weekday" ? (
          <div className="flex flex-wrap gap-2 text-xs" role="group" aria-label={`Condition ${n} days`}>
            {WEEKDAYS.map((d, i) => (
              <label key={d} className="flex items-center gap-1">
                <input type="checkbox" checked={list.includes(i)} onChange={(e) => onChange({ ...condition, value: e.target.checked ? [...list, i] : list.filter((x) => x !== i) })} /> {d.slice(0, 3)}
              </label>
            ))}
          </div>
        ) : (
          <input
            aria-label={`Condition ${n} values`}
            type="text"
            value={list.join(", ")}
            onChange={(e) => onChange({ ...condition, value: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
            placeholder="separate with commas"
            className={`${inputCls} w-56`}
          />
        )
      ) : (
        <ValueInput condition={condition} label={`Condition ${n} value`} leaveTypes={leaveTypes} onChange={(v) => onChange({ ...condition, value: v })} />
      )}
      <button type="button" onClick={onRemove} className="text-xs font-semibold text-danger hover:underline" aria-label={`Remove condition ${n}`}>Remove</button>
    </div>
  );
}

/**
 * BACKLOG58 - the AND / OR condition editor. Conditions are picked from lists (field, operator, value); there is no place
 * to type code, SQL or an expression. Groups can be nested three levels deep and a rule holds at most 20 conditions.
 */
export function LeaveConditionBuilder({ root, onChange, leaveTypes }: { root: LeaveRuleConditionGroup; onChange: (g: LeaveRuleConditionGroup) => void; leaveTypes: Array<{ code: string; name: string }> }) {
  let counter = 0;
  const render = (group: LeaveRuleConditionGroup, path: number[]) => {
    const depth = path.length;
    return (
      <div className={`rounded-lg border border-black/10 p-3 space-y-2 ${depth > 0 ? "bg-black/[0.03]" : "bg-white"}`} data-testid="condition-group">
        <div className="flex items-center gap-2 text-sm">
          <span>Match</span>
          <select aria-label={depth === 0 ? "Match all or any" : "Match all or any in group"} value={group.op} onChange={(e) => onChange(updateAt(root, path, (n) => ({ ...(n as LeaveRuleConditionGroup), op: e.target.value as "and" | "or" })))} className={inputCls}>
            <option value="and">all of these (AND)</option>
            <option value="or">any of these (OR)</option>
          </select>
          {depth > 0 && (
            <button type="button" className="ml-auto text-xs font-semibold text-danger hover:underline" onClick={() => onChange(updateAt(root, path, () => null))}>Remove group</button>
          )}
        </div>
        {group.children.length === 0 && <p className="text-xs text-label-tertiary">No conditions: the rule applies to every request in its scope.</p>}
        {group.children.map((child, i) =>
          isCondition(child) ? (
            <ConditionRow
              key={i}
              n={++counter}
              condition={child}
              leaveTypes={leaveTypes}
              onChange={(c) => onChange(updateAt(root, [...path, i], () => c))}
              onRemove={() => onChange(updateAt(root, [...path, i], () => null))}
            />
          ) : (
            <div key={i}>{render(child, [...path, i])}</div>
          )
        )}
        <div className="flex gap-3 text-xs font-semibold">
          <button type="button" className="text-accent hover:underline" onClick={() => onChange(updateAt(root, path, (n) => ({ ...(n as LeaveRuleConditionGroup), children: [...(n as LeaveRuleConditionGroup).children, newCondition()] })))}>
            + Add condition
          </button>
          {groupDepth(root) < 4 && depth < 3 && (
            <button type="button" className="text-accent hover:underline" onClick={() => onChange(updateAt(root, path, (n) => ({ ...(n as LeaveRuleConditionGroup), children: [...(n as LeaveRuleConditionGroup).children, emptyGroup()] })))}>
              + Add group
            </button>
          )}
        </div>
      </div>
    );
  };
  return (
    <div data-testid="condition-builder">
      {render(root, [])}
      <p className="text-xs text-label-secondary mt-2" data-testid="condition-sentence">{describeGroup(root)}</p>
    </div>
  );
}
