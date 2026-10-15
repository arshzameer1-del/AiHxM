import { BadRequestException } from "@nestjs/common";
import type { WorkflowFieldCondition } from "@aihxm/shared-types";

const OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "not_in", "between"] as const;

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const na = asNumber(a);
  const nb = asNumber(b);
  return na !== null && nb !== null && na === nb;
}

function compare(a: unknown, b: unknown): number | null {
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null) return na - nb;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

/**
 * Evaluates a step / start condition against the record snapshot.
 * Backward compatible: `{field, equals}` keeps its original strict meaning.
 * A missing field never satisfies a comparison (it only satisfies `ne` / `not_in`).
 */
export function conditionMatches(cond: WorkflowFieldCondition | null | undefined, record: Record<string, unknown>): boolean {
  if (!cond) return true;
  if ("all" in cond) return cond.all.every((c) => conditionMatches(c, record));
  if ("any" in cond) return cond.any.some((c) => conditionMatches(c, record));
  if ("equals" in cond) return record[cond.field] === cond.equals;
  const actual = record[cond.field];
  switch (cond.op) {
    case "eq":
      return looseEquals(actual, cond.value);
    case "ne":
      return !looseEquals(actual, cond.value);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const c = compare(actual, cond.value);
      if (c === null) return false;
      return cond.op === "gt" ? c > 0 : cond.op === "gte" ? c >= 0 : cond.op === "lt" ? c < 0 : c <= 0;
    }
    case "in":
      return cond.value.some((v) => looseEquals(actual, v));
    case "not_in":
      return !cond.value.some((v) => looseEquals(actual, v));
    case "between": {
      const lo = compare(actual, cond.value[0]);
      const hi = compare(actual, cond.value[1]);
      return lo !== null && hi !== null && lo >= 0 && hi <= 0;
    }
    default:
      return false;
  }
}

/** Rejects a malformed condition when a template is saved, instead of silently never matching. */
export function validateCondition(cond: unknown, path = "condition"): void {
  if (cond === null || cond === undefined) return;
  if (typeof cond !== "object" || Array.isArray(cond)) throw new BadRequestException(`${path} must be an object`);
  const c = cond as Record<string, unknown>;
  if ("all" in c || "any" in c) {
    const list = (c.all ?? c.any) as unknown;
    if (!Array.isArray(list) || list.length === 0) throw new BadRequestException(`${path}.all/any must be a non-empty list`);
    list.forEach((x, i) => validateCondition(x, `${path}[${i}]`));
    return;
  }
  if (typeof c.field !== "string" || c.field.trim() === "") throw new BadRequestException(`${path}.field is required`);
  if ("equals" in c) return;
  if (!OPS.includes(c.op as (typeof OPS)[number])) throw new BadRequestException(`${path}.op must be one of ${OPS.join(", ")}`);
  if ((c.op === "in" || c.op === "not_in") && !Array.isArray(c.value)) throw new BadRequestException(`${path}.value must be a list`);
  if (c.op === "between" && !(Array.isArray(c.value) && c.value.length === 2 && c.value.every((v) => asNumber(v) !== null))) {
    throw new BadRequestException(`${path}.value must be [min, max] numbers`);
  }
  if (!("value" in c)) throw new BadRequestException(`${path}.value is required`);
}
