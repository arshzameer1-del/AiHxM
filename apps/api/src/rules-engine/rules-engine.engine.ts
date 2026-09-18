import { Injectable } from "@nestjs/common";

/**
 * A single, shared, safely-evaluated condition engine — Foundation's
 * second extraction after the Effective-Dating Engine (see
 * claude/aihxm-master-audit-and-roadmap.md Part 4, "Rules Engine" entries
 * for the full reasoning). It generalizes the one narrow condition
 * matcher this codebase had before it existed —
 * `EmployeeGroupsService`'s AND-only, five-fixed-field, equals-only
 * matcher (0012_employee_groups_leave_policy.sql) — into a real
 * expression grammar (AND/OR/NOT composition, more operators, arbitrary
 * field names) that the Payroll Formula Engine and every other
 * "eligibility rule" named throughout the roadmap can build on, instead
 * of each hand-rolling its own `.every(...)` matcher the way Employee
 * Groups did.
 *
 * Deliberately NOT a rule storage/lifecycle engine — no table, no
 * admin UI, no versioning here. This module owns exactly one thing:
 * given a JSON-shaped expression tree and a plain "resolved facts"
 * context object, decide whether the expression is true. Callers own
 * resolving whatever `field`s their own domain needs into that context
 * object (the same way `EmployeeGroupsService` already resolves
 * `department`/`location`/etc. off a real `employees` row) — this
 * engine never touches SQL, RBAC, or entitlements, matching the
 * Effective-Dating Engine's own "thin, explicit, no ORM" discipline.
 *
 * Safety: expressions are plain JSON data, evaluated by walking a fixed
 * set of operators below — there is no `eval`, no `Function(...)`, no
 * arbitrary code path of any kind. An expression that names an unknown
 * operator, or that applies an operator to a value shape it can't
 * safely handle (e.g. "between" without a two-element bound, a numeric
 * comparison against a non-number/non-date), throws a clear
 * `RuleEvaluationError` rather than silently coercing or guessing —
 * admin-authored rules deserve a loud failure at evaluation/validation
 * time, not a quietly-wrong `true`/`false`.
 */

export type RuleOperator =
  | "equals"
  | "notEquals"
  | "in"
  | "notIn"
  | "greaterThan"
  | "greaterThanOrEqual"
  | "lessThan"
  | "lessThanOrEqual"
  | "between"
  | "contains"
  | "isEmpty"
  | "isNotEmpty";

const ALL_OPERATORS: ReadonlySet<string> = new Set<RuleOperator>([
  "equals",
  "notEquals",
  "in",
  "notIn",
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
  "between",
  "contains",
  "isEmpty",
  "isNotEmpty",
]);

/** A single leaf test: does `context[field]` satisfy `operator` against `value`? */
export interface RuleCondition {
  field: string;
  operator: RuleOperator;
  /** Omitted for "isEmpty"/"isNotEmpty", which need no comparison value. */
  value?: unknown;
}

export interface RuleAllOf {
  all: RuleExpression[];
}

export interface RuleAnyOf {
  any: RuleExpression[];
}

export interface RuleNot {
  not: RuleExpression;
}

/** The full expression grammar: AND / OR / NOT composed over leaf conditions. */
export type RuleExpression = RuleAllOf | RuleAnyOf | RuleNot | RuleCondition;

/** Plain, already-resolved facts a rule is evaluated against — e.g. an employee's department/location/tenure. */
export type RuleContext = Record<string, unknown>;

export class RuleEvaluationError extends Error {}

function isAllOf(expr: RuleExpression): expr is RuleAllOf {
  return typeof expr === "object" && expr !== null && "all" in expr;
}

function isAnyOf(expr: RuleExpression): expr is RuleAnyOf {
  return typeof expr === "object" && expr !== null && "any" in expr;
}

function isNot(expr: RuleExpression): expr is RuleNot {
  return typeof expr === "object" && expr !== null && "not" in expr;
}

/** Build an AND-of-equals expression from the shape Employee Groups' `employee_group_conditions` table already stores — the exact retrofit shape this engine's first real consumer needs. */
export function allEqual(conditions: ReadonlyArray<{ field: string; equals: unknown }>): RuleExpression {
  return { all: conditions.map((c) => ({ field: c.field, operator: "equals" as const, value: c.equals })) };
}

@Injectable()
export class RulesEngine {
  /** Walk the expression tree against `context` and return whether it's satisfied. Throws `RuleEvaluationError` rather than guessing on any malformed or type-mismatched condition. */
  evaluate(expression: RuleExpression, context: RuleContext): boolean {
    if (isAllOf(expression)) {
      if (expression.all.length === 0) {
        throw new RuleEvaluationError('"all" requires at least one sub-expression');
      }
      return expression.all.every((sub) => this.evaluate(sub, context));
    }
    if (isAnyOf(expression)) {
      if (expression.any.length === 0) {
        throw new RuleEvaluationError('"any" requires at least one sub-expression');
      }
      return expression.any.some((sub) => this.evaluate(sub, context));
    }
    if (isNot(expression)) {
      return !this.evaluate(expression.not, context);
    }
    return this.evaluateCondition(expression, context);
  }

  /**
   * Validate an expression's SHAPE (and, when given, that every leaf's
   * `field` is one the caller actually allows) without evaluating it
   * against any real data — the check a "save this rule" admin endpoint
   * would run before ever persisting an admin-authored expression.
   */
  validate(expression: RuleExpression, allowedFields?: ReadonlySet<string>): void {
    if (typeof expression !== "object" || expression === null) {
      throw new RuleEvaluationError("A rule expression must be an object");
    }
    if (isAllOf(expression) || isAnyOf(expression)) {
      const list = isAllOf(expression) ? expression.all : (expression as RuleAnyOf).any;
      if (!Array.isArray(list) || list.length === 0) {
        throw new RuleEvaluationError('"all"/"any" must be a non-empty array of sub-expressions');
      }
      for (const sub of list) this.validate(sub, allowedFields);
      return;
    }
    if (isNot(expression)) {
      this.validate(expression.not, allowedFields);
      return;
    }
    const condition = expression as RuleCondition;
    if (typeof condition.field !== "string" || condition.field.length === 0) {
      throw new RuleEvaluationError('A rule condition requires a non-empty "field"');
    }
    if (!ALL_OPERATORS.has(condition.operator)) {
      throw new RuleEvaluationError(`Unknown operator "${String(condition.operator)}"`);
    }
    if (allowedFields && !allowedFields.has(condition.field)) {
      throw new RuleEvaluationError(`Field "${condition.field}" is not allowed in this rule's context`);
    }
    if ((condition.operator === "in" || condition.operator === "notIn") && !Array.isArray(condition.value)) {
      throw new RuleEvaluationError(`"${condition.operator}" on field "${condition.field}" requires an array value`);
    }
    if (condition.operator === "between" && (!Array.isArray(condition.value) || condition.value.length !== 2)) {
      throw new RuleEvaluationError(`"between" on field "${condition.field}" requires a [min, max] value`);
    }
  }

  private evaluateCondition(condition: RuleCondition, context: RuleContext): boolean {
    const actual = context[condition.field];
    switch (condition.operator) {
      case "equals":
        return actual === condition.value;
      case "notEquals":
        return actual !== condition.value;
      case "in":
        return this.asArray(condition).includes(actual);
      case "notIn":
        return !this.asArray(condition).includes(actual);
      case "isEmpty":
        return this.isEmptyValue(actual);
      case "isNotEmpty":
        return !this.isEmptyValue(actual);
      case "contains": {
        if (!Array.isArray(actual)) {
          throw new RuleEvaluationError(
            `"contains" requires field "${condition.field}" to resolve to an array, got ${typeof actual}`
          );
        }
        return actual.includes(condition.value);
      }
      case "greaterThan": {
        const [a, b] = this.toComparablePair(actual, condition.value, condition);
        return a > b;
      }
      case "greaterThanOrEqual": {
        const [a, b] = this.toComparablePair(actual, condition.value, condition);
        return a >= b;
      }
      case "lessThan": {
        const [a, b] = this.toComparablePair(actual, condition.value, condition);
        return a < b;
      }
      case "lessThanOrEqual": {
        const [a, b] = this.toComparablePair(actual, condition.value, condition);
        return a <= b;
      }
      case "between": {
        if (!Array.isArray(condition.value) || condition.value.length !== 2) {
          throw new RuleEvaluationError(`"between" on field "${condition.field}" requires a [min, max] value`);
        }
        const a = this.toComparable(actual, condition.field);
        const [lowRaw, highRaw] = condition.value as [unknown, unknown];
        const low = this.toComparable(lowRaw, condition.field);
        const high = this.toComparable(highRaw, condition.field);
        if (typeof a !== typeof low || typeof a !== typeof high) {
          throw new RuleEvaluationError(`Field "${condition.field}": "between" bounds must be the same type as the field's value`);
        }
        return a >= low && a <= high;
      }
      default: {
        const exhaustive: never = condition.operator;
        throw new RuleEvaluationError(`Unknown operator: ${String(exhaustive)}`);
      }
    }
  }

  private asArray(condition: RuleCondition): unknown[] {
    if (!Array.isArray(condition.value)) {
      throw new RuleEvaluationError(`"${condition.operator}" on field "${condition.field}" requires an array value`);
    }
    return condition.value;
  }

  private isEmptyValue(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value === "string") return value.length === 0;
    if (Array.isArray(value)) return value.length === 0;
    return false;
  }

  /** Numbers compare as numbers; strings (including ISO 8601 dates, which this codebase already relies on sorting lexicographically — see effective-dating.engine.ts) and Dates compare as strings. Anything else is a clear evaluation error, never a silent coercion. */
  private toComparable(value: unknown, field: string): number | string {
    if (typeof value === "number") return value;
    if (typeof value === "string") return value;
    if (value instanceof Date) return value.toISOString();
    throw new RuleEvaluationError(
      `Field "${field}" must resolve to a number, string, or Date for a comparison operator, got ${typeof value}`
    );
  }

  private toComparablePair(actual: unknown, other: unknown, condition: RuleCondition): [number | string, number | string] {
    const a = this.toComparable(actual, condition.field);
    const b = this.toComparable(other, condition.field);
    if (typeof a !== typeof b) {
      throw new RuleEvaluationError(`Field "${condition.field}": cannot compare ${typeof a} to ${typeof b}`);
    }
    return [a, b];
  }
}
