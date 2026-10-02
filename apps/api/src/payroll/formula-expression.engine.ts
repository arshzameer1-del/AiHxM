import { Injectable } from "@nestjs/common";

/**
 * A small, safely-evaluated NUMERIC expression evaluator — the
 * computational core of the Payroll Formula Engine (`payroll_formulas`,
 * migration 0105).
 *
 * Why this is a separate engine and not the Rules Engine
 * (`apps/api/src/rules-engine/rules-engine.engine.ts`):
 * the Rules Engine is a BOOLEAN predicate evaluator — its own header says
 * it owns exactly one thing: "given a JSON-shaped expression tree ...
 * decide whether the expression is true". Its grammar is conditions
 * (`equals`/`greaterThan`/`between`/...) composed by `all`/`any`/`not`,
 * and it has no notion of computing and returning a number. Payroll needs
 * the other half: "compute a currency amount from named inputs". Bolting
 * arithmetic onto the Rules Engine would turn a deliberately narrow,
 * well-tested boolean engine into a general-purpose interpreter it was
 * explicitly designed not to be, so it is left untouched. This file is
 * NOT a second copy of that engine (which the codebase's "never build
 * what already exists" principle would forbid) — no numeric evaluator
 * existed anywhere in the codebase before this one. If a future formula
 * ever needs a condition ("only if grade = M3"), the right composition is
 * the caller asking the Rules Engine for the boolean and choosing which
 * numeric expression to evaluate, not either engine absorbing the other.
 *
 * It deliberately follows the Rules Engine's own safety discipline
 * exactly:
 *  - Expressions are plain JSON data (stored as jsonb), walked by a FIXED
 *    set of operators below. There is no `eval`, no `Function(...)`, and
 *    no string-based expression parsing of any kind — a formula is never
 *    text that gets interpreted, only a tree of known node shapes.
 *  - Leaf variables are resolved from a caller-supplied, already-resolved
 *    "context object" (the Rules Engine's `RuleContext` pattern). This
 *    engine never touches SQL, RBAC, entitlements, or payroll specifics.
 *  - Anything it can't safely handle — an unknown operator, a malformed
 *    node, a missing or non-numeric variable, division by zero, a result
 *    that isn't a finite number — throws a typed `FormulaEvaluationError`
 *    (the counterpart of `RuleEvaluationError`). It never silently
 *    coerces, and never returns NaN, Infinity, or a guessed 0: a payroll
 *    amount that's quietly wrong is far worse than a loud failure.
 *
 * Grammar (every node is an object with EXACTLY ONE key):
 *   { const: number }                                  finite numeric literal
 *   { var: "name" }                                    context[name], must be a finite number
 *   { add:      [e1, e2, ...] }   (2+ operands)        e1 + e2 + ...
 *   { subtract: [e1, e2, ...] }   (2+ operands)        e1 - e2 - ... (left to right)
 *   { multiply: [e1, e2, ...] }   (2+ operands)        e1 * e2 * ...
 *   { divide:   [e1, e2, ...] }   (2+ operands)        e1 / e2 / ... (left to right; any zero divisor throws)
 *   { min:      [e1, e2, ...] }   (2+ operands)
 *   { max:      [e1, e2, ...] }   (2+ operands)
 *   { round:     { value: e, places: n } }             n an integer 0-10; same rounding every
 *                                                      stored payslip figure uses: Number(x.toFixed(n))
 *   { percentOf: { value: e, percent: p } }            e * (p / 100) — the single most common
 *                                                      payroll operation (tax, EOBI rates)
 */

export type FormulaExpression =
  | FormulaConst
  | FormulaVar
  | { add: FormulaExpression[] }
  | { subtract: FormulaExpression[] }
  | { multiply: FormulaExpression[] }
  | { divide: FormulaExpression[] }
  | { min: FormulaExpression[] }
  | { max: FormulaExpression[] }
  | { round: { value: FormulaExpression; places: number } }
  | { percentOf: { value: FormulaExpression; percent: FormulaExpression } };

export interface FormulaConst {
  const: number;
}

export interface FormulaVar {
  var: string;
}

/** Plain, already-resolved numeric facts a formula is evaluated against — e.g. a payslip's wage base and rate. */
export type FormulaContext = Readonly<Record<string, unknown>>;

export type FormulaOperator =
  | "const"
  | "var"
  | "add"
  | "subtract"
  | "multiply"
  | "divide"
  | "min"
  | "max"
  | "round"
  | "percentOf";

const ALL_OPERATORS: ReadonlySet<string> = new Set<FormulaOperator>([
  "const",
  "var",
  "add",
  "subtract",
  "multiply",
  "divide",
  "min",
  "max",
  "round",
  "percentOf",
]);

/** Guards against pathologically deep admin-authored trees (and the stack overflow walking one would cause). Real payroll formulas are a handful of levels deep. */
export const MAX_FORMULA_DEPTH = 32;
export const MAX_ROUND_PLACES = 10;

export type FormulaErrorCode =
  | "malformed_expression"
  | "unknown_operator"
  | "missing_variable"
  | "non_numeric_variable"
  | "unknown_variable"
  | "division_by_zero"
  | "non_finite_result";

/** Mirrors `RuleEvaluationError` (a plain `Error` subclass), plus a machine-readable `code` so callers/tests can tell failure kinds apart without parsing messages. */
export class FormulaEvaluationError extends Error {
  constructor(
    readonly code: FormulaErrorCode,
    message: string
  ) {
    super(message);
    this.name = "FormulaEvaluationError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The node's single operator key, or a `malformed_expression`/`unknown_operator` error. */
function operatorOf(node: unknown): FormulaOperator {
  if (!isPlainObject(node)) {
    throw new FormulaEvaluationError("malformed_expression", "A formula expression node must be an object");
  }
  const keys = Object.keys(node);
  if (keys.length !== 1) {
    throw new FormulaEvaluationError(
      "malformed_expression",
      `A formula expression node must have exactly one operator key, got ${keys.length === 0 ? "none" : keys.map((k) => `"${k}"`).join(", ")}`
    );
  }
  const op = keys[0];
  if (!ALL_OPERATORS.has(op)) {
    throw new FormulaEvaluationError("unknown_operator", `Unknown formula operator "${op}"`);
  }
  return op as FormulaOperator;
}

function finite(value: number, what: string): number {
  if (!Number.isFinite(value)) {
    throw new FormulaEvaluationError("non_finite_result", `${what} did not produce a finite number`);
  }
  return value;
}

@Injectable()
export class FormulaExpressionEngine {
  /** Walk the expression tree against `context` and return the computed number. Throws `FormulaEvaluationError` rather than guessing on anything malformed, missing, or non-finite. */
  evaluate(expression: FormulaExpression, context: FormulaContext): number {
    return this.evaluateNode(expression, context, 1);
  }

  /**
   * Validate an expression's SHAPE (and, when given, that every `var` it
   * references is one the caller actually exposes) without evaluating it
   * against any real data — the check a "save this formula" admin
   * endpoint runs before persisting, mirroring `RulesEngine.validate()`.
   * Also rejects a literal `{ const: 0 }` divisor, the one division by
   * zero knowable before evaluation.
   */
  validate(expression: unknown, allowedVariables?: ReadonlySet<string>): void {
    this.validateNode(expression, allowedVariables, 1);
  }

  private evaluateNode(node: FormulaExpression, context: FormulaContext, depth: number): number {
    if (depth > MAX_FORMULA_DEPTH) {
      throw new FormulaEvaluationError("malformed_expression", `Formula is nested deeper than ${MAX_FORMULA_DEPTH} levels`);
    }
    const op = operatorOf(node);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (node as any)[op];
    switch (op) {
      case "const":
        return this.constValue(body);
      case "var":
        return this.resolveVariable(body, context);
      case "add":
      case "subtract":
      case "multiply":
      case "divide":
      case "min":
      case "max": {
        const operands = this.operandList(op, body).map((sub) => this.evaluateNode(sub, context, depth + 1));
        return finite(this.applyNary(op, operands), `"${op}"`);
      }
      case "round": {
        const { value, places } = this.roundBody(body);
        const v = this.evaluateNode(value, context, depth + 1);
        return finite(Number(v.toFixed(places)), '"round"');
      }
      case "percentOf": {
        const { value, percent } = this.percentOfBody(body);
        const v = this.evaluateNode(value, context, depth + 1);
        const p = this.evaluateNode(percent, context, depth + 1);
        return finite(v * (p / 100), '"percentOf"');
      }
      default: {
        const exhaustive: never = op;
        throw new FormulaEvaluationError("unknown_operator", `Unknown formula operator "${String(exhaustive)}"`);
      }
    }
  }

  private applyNary(op: FormulaOperator, operands: number[]): number {
    switch (op) {
      case "add":
        return operands.reduce((a, b) => a + b);
      case "subtract":
        return operands.reduce((a, b) => a - b);
      case "multiply":
        return operands.reduce((a, b) => a * b);
      case "divide":
        return operands.reduce((a, b) => {
          if (b === 0) throw new FormulaEvaluationError("division_by_zero", '"divide" by zero');
          return a / b;
        });
      case "min":
        return Math.min(...operands);
      case "max":
        return Math.max(...operands);
      default:
        throw new FormulaEvaluationError("unknown_operator", `"${op}" is not an n-ary operator`);
    }
  }

  private validateNode(node: unknown, allowedVariables: ReadonlySet<string> | undefined, depth: number): void {
    if (depth > MAX_FORMULA_DEPTH) {
      throw new FormulaEvaluationError("malformed_expression", `Formula is nested deeper than ${MAX_FORMULA_DEPTH} levels`);
    }
    const op = operatorOf(node);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (node as any)[op];
    switch (op) {
      case "const":
        this.constValue(body);
        return;
      case "var": {
        const name = this.variableName(body);
        if (allowedVariables && !allowedVariables.has(name)) {
          throw new FormulaEvaluationError(
            "unknown_variable",
            `Variable "${name}" is not available in this formula's context (allowed: ${[...allowedVariables].join(", ")})`
          );
        }
        return;
      }
      case "add":
      case "subtract":
      case "multiply":
      case "divide":
      case "min":
      case "max": {
        const operands = this.operandList(op, body);
        operands.forEach((sub) => this.validateNode(sub, allowedVariables, depth + 1));
        if (op === "divide") {
          operands.slice(1).forEach((sub) => {
            if (isPlainObject(sub) && Object.keys(sub).length === 1 && "const" in sub && sub.const === 0) {
              throw new FormulaEvaluationError("division_by_zero", '"divide" has a literal zero divisor');
            }
          });
        }
        return;
      }
      case "round": {
        const { value } = this.roundBody(body);
        this.validateNode(value, allowedVariables, depth + 1);
        return;
      }
      case "percentOf": {
        const { value, percent } = this.percentOfBody(body);
        this.validateNode(value, allowedVariables, depth + 1);
        this.validateNode(percent, allowedVariables, depth + 1);
        return;
      }
      default: {
        const exhaustive: never = op;
        throw new FormulaEvaluationError("unknown_operator", `Unknown formula operator "${String(exhaustive)}"`);
      }
    }
  }

  private constValue(body: unknown): number {
    if (typeof body !== "number" || !Number.isFinite(body)) {
      throw new FormulaEvaluationError("malformed_expression", '"const" must be a finite number');
    }
    return body;
  }

  private variableName(body: unknown): string {
    if (typeof body !== "string" || body.length === 0) {
      throw new FormulaEvaluationError("malformed_expression", '"var" must be a non-empty variable name');
    }
    return body;
  }

  private resolveVariable(body: unknown, context: FormulaContext): number {
    const name = this.variableName(body);
    // Own properties only — `{ var: "constructor" }` / `"__proto__"` must
    // never reach Object.prototype and come back as something callable.
    if (!Object.prototype.hasOwnProperty.call(context, name)) {
      throw new FormulaEvaluationError("missing_variable", `Variable "${name}" is not present in the evaluation context`);
    }
    const value = context[name];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new FormulaEvaluationError(
        "non_numeric_variable",
        `Variable "${name}" must resolve to a finite number, got ${value === null ? "null" : typeof value}`
      );
    }
    return value;
  }

  private operandList(op: FormulaOperator, body: unknown): FormulaExpression[] {
    if (!Array.isArray(body) || body.length < 2) {
      throw new FormulaEvaluationError("malformed_expression", `"${op}" requires an array of at least two operands`);
    }
    return body as FormulaExpression[];
  }

  private roundBody(body: unknown): { value: FormulaExpression; places: number } {
    if (!isPlainObject(body) || !("value" in body) || !("places" in body) || Object.keys(body).length !== 2) {
      throw new FormulaEvaluationError("malformed_expression", '"round" requires exactly { value, places }');
    }
    const places = body.places;
    if (typeof places !== "number" || !Number.isInteger(places) || places < 0 || places > MAX_ROUND_PLACES) {
      throw new FormulaEvaluationError("malformed_expression", `"round" places must be an integer from 0 to ${MAX_ROUND_PLACES}`);
    }
    return { value: body.value as FormulaExpression, places };
  }

  private percentOfBody(body: unknown): { value: FormulaExpression; percent: FormulaExpression } {
    if (!isPlainObject(body) || !("value" in body) || !("percent" in body) || Object.keys(body).length !== 2) {
      throw new FormulaEvaluationError("malformed_expression", '"percentOf" requires exactly { value, percent }');
    }
    return { value: body.value as FormulaExpression, percent: body.percent as FormulaExpression };
  }
}
