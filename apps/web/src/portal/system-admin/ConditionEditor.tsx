import { OP_LABELS, emptyRule, type ConditionDraft, type RuleOp } from "./workflowConditions";
import type { WorkflowField } from "./workflowTemplateOptions";

const SELECT = "rounded-lg border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent";

/** "Only when ..." rules over the facts a request carries (amount, days, leave type ...). */
export function ConditionEditor({
  value,
  fields,
  onChange,
  testId,
  intro,
}: {
  value: ConditionDraft;
  fields: WorkflowField[];
  onChange: (next: ConditionDraft) => void;
  testId: string;
  intro: string;
}) {
  const kindOf = (field: string) => fields.find((f) => f.key === field)?.kind ?? "text";
  const opsFor = (field: string): RuleOp[] => (kindOf(field) === "number" ? ["gte", "gt", "lte", "lt", "between", "eq", "ne"] : ["eq", "ne", "in"]);
  const setRule = (i: number, patch: Partial<ConditionDraft["rules"][number]>) =>
    onChange({ ...value, rules: value.rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) });

  return (
    <div className="space-y-2" data-testid={testId}>
      <p className="text-xs text-label-tertiary">{intro}</p>
      {fields.length === 0 && value.rules.length === 0 ? (
        <p className="text-xs text-label-tertiary">This kind of request carries no facts to choose from, so it cannot be limited by a condition.</p>
      ) : (
        <>
          {value.rules.length > 1 && (
            <label className="text-xs inline-flex items-center gap-2">
              Needs
              <select aria-label="Match all or any" value={value.mode} onChange={(e) => onChange({ ...value, mode: e.target.value as "all" | "any" })} className={SELECT}>
                <option value="all">all of these</option>
                <option value="any">any one of these</option>
              </select>
            </label>
          )}
          {value.rules.map((rule, i) => {
            const known = fields.some((f) => f.key === rule.field);
            return (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <select aria-label="Condition field" value={rule.field} onChange={(e) => setRule(i, { field: e.target.value, op: kindOf(e.target.value) === "number" ? "gte" : "eq", value: "", value2: "" })} className={SELECT}>
                  <option value="">Choose…</option>
                  {!known && rule.field && <option value={rule.field}>{rule.field}</option>}
                  {fields.map((f) => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                </select>
                <select aria-label="Condition operator" value={rule.op} onChange={(e) => setRule(i, { op: e.target.value as RuleOp })} className={SELECT}>
                  {opsFor(rule.field).concat(opsFor(rule.field).includes(rule.op) ? [] : [rule.op]).map((op) => (
                    <option key={op} value={op}>{OP_LABELS[op]}</option>
                  ))}
                </select>
                <input
                  aria-label="Condition value"
                  type={kindOf(rule.field) === "number" && rule.op !== "in" ? "number" : "text"}
                  placeholder={rule.op === "in" ? "a, b, c" : "Value"}
                  value={rule.value}
                  onChange={(e) => setRule(i, { value: e.target.value })}
                  className={`${SELECT} w-28`}
                />
                {rule.op === "between" && (
                  <>
                    <span className="text-xs text-label-tertiary">and</span>
                    <input aria-label="Condition upper value" type="number" value={rule.value2} onChange={(e) => setRule(i, { value2: e.target.value })} className={`${SELECT} w-24`} />
                  </>
                )}
                <button type="button" aria-label="Remove rule" onClick={() => onChange({ ...value, rules: value.rules.filter((_, idx) => idx !== i) })} className="text-label-tertiary hover:text-danger px-1 text-xs">
                  ✕
                </button>
              </div>
            );
          })}
          {fields.length > 0 && (
            <button type="button" onClick={() => onChange({ ...value, rules: [...value.rules, emptyRule(fields[0].key)] })} className="text-xs font-semibold text-accent hover:underline">
              + Add a rule
            </button>
          )}
        </>
      )}
    </div>
  );
}
