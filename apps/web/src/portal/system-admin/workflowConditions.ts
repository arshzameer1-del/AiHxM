import type { WorkflowFieldCondition } from "@aihxm/shared-types";

/**
 * BACKLOG58 - the "only when ..." builder. A condition on screen is a list of simple rules joined by "all" or "any".
 * Anything the builder cannot show (nested groups, unusual shapes) is left exactly as stored and described in words.
 */
export type RuleOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "between";
export type ConditionRule = { field: string; op: RuleOp; value: string; value2: string };
export type ConditionDraft = { mode: "all" | "any"; rules: ConditionRule[] };

export const OP_LABELS: Record<RuleOp, string> = {
  eq: "is",
  ne: "is not",
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  in: "is one of",
  between: "is between",
};

type Simple = Exclude<WorkflowFieldCondition, { all: WorkflowFieldCondition[] } | { any: WorkflowFieldCondition[] }>;

function ruleFrom(c: WorkflowFieldCondition): ConditionRule | null {
  if ("all" in c || "any" in c) return null;
  const s = c as Simple;
  if ("equals" in s) return { field: s.field, op: "eq", value: String(s.equals ?? ""), value2: "" };
  if (s.op === "between") return { field: s.field, op: "between", value: String(s.value[0]), value2: String(s.value[1]) };
  if (s.op === "in") return { field: s.field, op: "in", value: s.value.map(String).join(", "), value2: "" };
  if (s.op === "not_in") return null;
  return { field: s.field, op: s.op, value: String(s.value ?? ""), value2: "" };
}

/** The builder's view of a stored condition, or null when it cannot be shown (the caller keeps the stored one). */
export function conditionToDraft(c: WorkflowFieldCondition | null | undefined): ConditionDraft | null {
  if (!c) return { mode: "all", rules: [] };
  if ("all" in c || "any" in c) {
    const mode = "all" in c ? "all" : "any";
    const parts = "all" in c ? c.all : c.any;
    const rules = parts.map(ruleFrom);
    if (rules.some((r) => r === null)) return null;
    return { mode, rules: rules as ConditionRule[] };
  }
  const rule = ruleFrom(c);
  return rule ? { mode: "all", rules: [rule] } : null;
}

const asValue = (raw: string): string | number => {
  const t = raw.trim();
  return t !== "" && !Number.isNaN(Number(t)) ? Number(t) : t;
};

function ruleToCondition(r: ConditionRule): WorkflowFieldCondition {
  if (r.op === "eq") return { field: r.field, op: "eq", value: asValue(r.value) };
  if (r.op === "between") return { field: r.field, op: "between", value: [Number(r.value), Number(r.value2)] };
  if (r.op === "in") return { field: r.field, op: "in", value: r.value.split(",").map((x) => asValue(x)).filter((x) => x !== "") };
  return { field: r.field, op: r.op, value: asValue(r.value) };
}

/** What a draft means as a stored condition; null = no condition. */
export function draftToCondition(d: ConditionDraft): WorkflowFieldCondition | null {
  const rules = d.rules.filter((r) => r.field);
  if (rules.length === 0) return null;
  if (rules.length === 1) return ruleToCondition(rules[0]);
  const list = rules.map(ruleToCondition);
  return d.mode === "all" ? { all: list } : { any: list };
}

/** The first thing wrong with a draft, in plain words; null when it is fine. */
export function draftProblem(d: ConditionDraft): string | null {
  for (const r of d.rules) {
    if (!r.field) return "Choose what each rule looks at.";
    if (r.op === "between") {
      if (r.value.trim() === "" || r.value2.trim() === "" || Number.isNaN(Number(r.value)) || Number.isNaN(Number(r.value2))) return "\"is between\" needs two numbers.";
      if (Number(r.value) > Number(r.value2)) return "In \"is between\" the first number must not be larger than the second.";
    } else if (["gt", "gte", "lt", "lte"].includes(r.op)) {
      if (r.value.trim() === "" || Number.isNaN(Number(r.value))) return `"${OP_LABELS[r.op]}" needs a number.`;
    } else if (r.value.trim() === "") {
      return "Fill in the value of each rule.";
    }
  }
  return null;
}

/** A stored condition in words, e.g. "Amount is at least 100000 and Category is Travel". */
export function describeCondition(c: WorkflowFieldCondition | null | undefined, labelOf: (field: string) => string): string {
  if (!c) return "";
  if ("all" in c) return c.all.map((x) => describeCondition(x, labelOf)).join(" and ");
  if ("any" in c) return c.any.map((x) => describeCondition(x, labelOf)).join(" or ");
  const r = ruleFrom(c);
  if (!r) return `${labelOf((c as Simple).field)} is not one of the listed values`;
  const value = r.op === "between" ? `${r.value} and ${r.value2}` : r.value;
  return `${labelOf(r.field)} ${OP_LABELS[r.op]} ${value}`;
}

export const emptyRule = (field = ""): ConditionRule => ({ field, op: "gte", value: "", value2: "" });
