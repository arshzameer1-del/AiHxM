import { FormulaEvaluationError, FormulaExpression, FormulaExpressionEngine, MAX_FORMULA_DEPTH } from "./formula-expression.engine";

/**
 * Pure unit tests — no Postgres needed (the engine never touches the
 * database), same convention as rules-engine.engine.spec.ts. Coverage
 * goal: every operator, nesting, and every error case the engine promises
 * to throw on (with its typed `code`) rather than silently coercing or
 * returning NaN/Infinity/0.
 */
describe("FormulaExpressionEngine", () => {
  const engine = new FormulaExpressionEngine();

  /** Asserts `fn` throws a FormulaEvaluationError carrying `code`. */
  function expectFormulaError(fn: () => unknown, code: FormulaEvaluationError["code"], messagePart?: string): void {
    let caught: unknown;
    try {
      fn();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormulaEvaluationError);
    expect((caught as FormulaEvaluationError).code).toBe(code);
    expect((caught as FormulaEvaluationError).name).toBe("FormulaEvaluationError");
    if (messagePart) expect((caught as Error).message).toContain(messagePart);
  }

  // Deliberately-malformed inputs are typed `unknown` and cast, the same
  // way admin-authored jsonb arrives at runtime.
  const bad = (x: unknown) => x as FormulaExpression;

  describe("leaves", () => {
    it("const returns the literal, including negatives and decimals", () => {
      expect(engine.evaluate({ const: 42 }, {})).toBe(42);
      expect(engine.evaluate({ const: -1.5 }, {})).toBe(-1.5);
      expect(engine.evaluate({ const: 0 }, {})).toBe(0);
    });

    it("var resolves a number from the context object", () => {
      expect(engine.evaluate({ var: "wageBase" }, { wageBase: 40700 })).toBe(40700);
      expect(engine.evaluate({ var: "zero" }, { zero: 0 })).toBe(0);
    });
  });

  describe("n-ary operators (2+ operands)", () => {
    it("add sums every operand", () => {
      expect(engine.evaluate({ add: [{ const: 1 }, { const: 2 }] }, {})).toBe(3);
      expect(engine.evaluate({ add: [{ const: 1 }, { const: 2 }, { var: "x" }] }, { x: 10 })).toBe(13);
    });

    it("subtract folds left to right", () => {
      expect(engine.evaluate({ subtract: [{ const: 10 }, { const: 3 }] }, {})).toBe(7);
      expect(engine.evaluate({ subtract: [{ const: 10 }, { const: 3 }, { const: 2 }] }, {})).toBe(5);
      expect(engine.evaluate({ subtract: [{ const: 3 }, { const: 10 }] }, {})).toBe(-7);
    });

    it("multiply multiplies every operand", () => {
      expect(engine.evaluate({ multiply: [{ const: 4 }, { const: 2.5 }] }, {})).toBe(10);
      expect(engine.evaluate({ multiply: [{ const: 2 }, { const: 3 }, { const: 4 }] }, {})).toBe(24);
    });

    it("divide folds left to right", () => {
      expect(engine.evaluate({ divide: [{ const: 10 }, { const: 4 }] }, {})).toBe(2.5);
      expect(engine.evaluate({ divide: [{ const: 100 }, { const: 5 }, { const: 2 }] }, {})).toBe(10);
      // A zero NUMERATOR is fine — only a zero divisor is an error.
      expect(engine.evaluate({ divide: [{ const: 0 }, { const: 5 }] }, {})).toBe(0);
    });

    it("min / max pick the smallest / largest operand", () => {
      expect(engine.evaluate({ min: [{ const: 3 }, { const: -1 }, { const: 2 }] }, {})).toBe(-1);
      expect(engine.evaluate({ max: [{ const: 3 }, { const: -1 }, { const: 2 }] }, {})).toBe(3);
      expect(engine.evaluate({ max: [{ const: 0 }, { subtract: [{ const: 5 }, { const: 9 }] }] }, {})).toBe(0);
    });
  });

  describe("round", () => {
    it("rounds to N decimal places with the same Number(x.toFixed(n)) rounding every stored payslip figure uses", () => {
      expect(engine.evaluate({ round: { value: { const: 1234.5678 }, places: 2 } }, {})).toBe(1234.57);
      expect(engine.evaluate({ round: { value: { const: 1234.5678 }, places: 0 } }, {})).toBe(1235);
      expect(engine.evaluate({ round: { value: { const: 2.5 }, places: 0 } }, {})).toBe(Number((2.5).toFixed(0)));
      expect(engine.evaluate({ round: { value: { const: -2.345 }, places: 1 } }, {})).toBe(Number((-2.345).toFixed(1)));
      const x = 407.123456;
      expect(engine.evaluate({ round: { value: { var: "x" }, places: 4 } }, { x })).toBe(Number(x.toFixed(4)));
    });
  });

  describe("percentOf", () => {
    it("is value * (percent / 100)", () => {
      expect(engine.evaluate({ percentOf: { value: { const: 40700 }, percent: { const: 1 } } }, {})).toBe(407);
      expect(engine.evaluate({ percentOf: { value: { var: "wageBase" }, percent: { var: "ratePercent" } } }, { wageBase: 40700, ratePercent: 5 })).toBe(
        2035
      );
      expect(engine.evaluate({ percentOf: { value: { const: 200 }, percent: { const: 12.5 } } }, {})).toBe(25);
    });
  });

  describe("nesting", () => {
    it("composes operators arbitrarily — an EOBI-style prorated contribution, rounded", () => {
      const expr: FormulaExpression = {
        round: {
          value: {
            multiply: [{ percentOf: { value: { var: "wageBase" }, percent: { var: "ratePercent" } } }, { var: "paidDaysRatio" }],
          },
          places: 2,
        },
      };
      expect(engine.evaluate(expr, { wageBase: 40700, ratePercent: 1, paidDaysRatio: 20 / 30 })).toBe(271.33);
    });

    it("a slab-style tax: max(0, base + rate% of (income - floor)) / 12, capped by min()", () => {
      const expr: FormulaExpression = {
        min: [
          {
            divide: [
              {
                max: [
                  { const: 0 },
                  {
                    add: [
                      { var: "bracketBaseTax" },
                      {
                        percentOf: {
                          value: { subtract: [{ var: "taxableAnnualIncome" }, { var: "bracketMinAnnualIncome" }] },
                          percent: { var: "bracketRatePercent" },
                        },
                      },
                    ],
                  },
                ],
              },
              { const: 12 },
            ],
          },
          { const: 50000 },
        ],
      };
      const ctx = { bracketBaseTax: 6000, taxableAnnualIncome: 1_800_000, bracketMinAnnualIncome: 1_200_000, bracketRatePercent: 11 };
      expect(engine.evaluate(expr, ctx)).toBeCloseTo((6000 + 0.11 * 600_000) / 12, 10);
      expect(engine.evaluate(expr, { ...ctx, taxableAnnualIncome: 100_000_000 })).toBe(50000);
    });

    it("never mutates the context object", () => {
      const ctx = Object.freeze({ a: 1, b: 2 });
      expect(engine.evaluate({ add: [{ var: "a" }, { var: "b" }] }, ctx)).toBe(3);
    });
  });

  describe("errors (typed, never silent)", () => {
    it("unknown operator", () => {
      expectFormulaError(() => engine.evaluate(bad({ pow: [{ const: 2 }, { const: 3 }] }), {}), "unknown_operator", '"pow"');
      expectFormulaError(() => engine.evaluate(bad({ add: [{ const: 1 }, { eval: "process.exit()" }] }), {}), "unknown_operator", '"eval"');
    });

    it("division by zero — a computed zero divisor and a later operand", () => {
      expectFormulaError(() => engine.evaluate({ divide: [{ const: 10 }, { var: "d" }] }, { d: 0 }), "division_by_zero");
      expectFormulaError(
        () => engine.evaluate({ divide: [{ const: 10 }, { const: 2 }, { subtract: [{ const: 1 }, { const: 1 }] }] }, {}),
        "division_by_zero"
      );
    });

    it("missing context variable — including names that exist on Object.prototype", () => {
      expectFormulaError(() => engine.evaluate({ var: "wageBase" }, {}), "missing_variable", '"wageBase"');
      expectFormulaError(() => engine.evaluate({ var: "constructor" }, {}), "missing_variable");
      expectFormulaError(() => engine.evaluate({ var: "toString" }, {}), "missing_variable");
      expectFormulaError(() => engine.evaluate({ var: "__proto__" }, {}), "missing_variable");
    });

    it("non-numeric / non-finite context variable is never coerced", () => {
      expectFormulaError(() => engine.evaluate({ var: "x" }, { x: "100" }), "non_numeric_variable", "string");
      expectFormulaError(() => engine.evaluate({ var: "x" }, { x: null }), "non_numeric_variable", "null");
      expectFormulaError(() => engine.evaluate({ var: "x" }, { x: undefined }), "non_numeric_variable");
      expectFormulaError(() => engine.evaluate({ var: "x" }, { x: NaN }), "non_numeric_variable");
      expectFormulaError(() => engine.evaluate({ var: "x" }, { x: Infinity }), "non_numeric_variable");
      expectFormulaError(() => engine.evaluate({ var: "x" }, { x: true }), "non_numeric_variable");
    });

    it("an overflowing intermediate result is a non_finite_result error, never Infinity", () => {
      expectFormulaError(() => engine.evaluate({ multiply: [{ const: 1e308 }, { const: 10 }] }, {}), "non_finite_result");
      expectFormulaError(() => engine.evaluate({ add: [{ const: Number.MAX_VALUE }, { const: Number.MAX_VALUE }] }, {}), "non_finite_result");
    });

    it("malformed nodes", () => {
      const cases: unknown[] = [
        null,
        42,
        "add",
        [],
        {},
        { const: 1, var: "x" }, // two operator keys — ambiguous
        { const: "1" }, // string literal is never coerced
        { const: NaN },
        { const: Infinity },
        { var: "" },
        { var: 5 },
        { add: [{ const: 1 }] }, // fewer than 2 operands
        { add: { const: 1 } },
        { min: [] },
        { round: { value: { const: 1 } } }, // missing places
        { round: { value: { const: 1 }, places: -1 } },
        { round: { value: { const: 1 }, places: 1.5 } },
        { round: { value: { const: 1 }, places: 11 } },
        { round: { value: { const: 1 }, places: 2, extra: true } },
        { percentOf: { value: { const: 1 } } }, // missing percent
        { percentOf: [{ const: 1 }, { const: 2 }] },
      ];
      for (const expr of cases) {
        expectFormulaError(() => engine.evaluate(bad(expr), {}), "malformed_expression");
      }
    });

    it("rejects trees nested deeper than MAX_FORMULA_DEPTH", () => {
      let deep: FormulaExpression = { const: 1 };
      for (let i = 0; i < MAX_FORMULA_DEPTH; i++) deep = { add: [deep, { const: 0 }] };
      expectFormulaError(() => engine.evaluate(deep, {}), "malformed_expression", "nested deeper");
      expectFormulaError(() => engine.validate(deep), "malformed_expression", "nested deeper");
    });
  });

  describe("validate()", () => {
    const allowed = new Set(["wageBase", "ratePercent"]);

    it("accepts a well-formed expression using only allowed variables, without evaluating it", () => {
      expect(() =>
        engine.validate({ percentOf: { value: { var: "wageBase" }, percent: { var: "ratePercent" } } }, allowed)
      ).not.toThrow();
      // No context needed — shape only.
      expect(() => engine.validate({ divide: [{ var: "wageBase" }, { var: "ratePercent" }] })).not.toThrow();
    });

    it("rejects a variable outside the allowed set with unknown_variable", () => {
      expectFormulaError(() => engine.validate({ var: "salary" }, allowed), "unknown_variable", '"salary"');
      expectFormulaError(
        () => engine.validate({ round: { value: { add: [{ var: "wageBase" }, { var: "bonus" }] }, places: 2 } }, allowed),
        "unknown_variable",
        '"bonus"'
      );
    });

    it("rejects unknown operators and malformed nodes anywhere in the tree", () => {
      expectFormulaError(() => engine.validate({ add: [{ const: 1 }, { sqrt: { const: 4 } }] }), "unknown_operator");
      expectFormulaError(() => engine.validate({ max: [{ const: 1 }, { round: { value: { const: 1 }, places: 99 } }] }), "malformed_expression");
      expectFormulaError(() => engine.validate("{\"const\": 1}"), "malformed_expression");
    });

    it("rejects a literal { const: 0 } divisor up front (but not a zero numerator)", () => {
      expectFormulaError(() => engine.validate({ divide: [{ var: "wageBase" }, { const: 0 }] }), "division_by_zero");
      expect(() => engine.validate({ divide: [{ const: 0 }, { var: "wageBase" }] })).not.toThrow();
    });
  });
});
