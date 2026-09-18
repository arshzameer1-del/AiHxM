import { RuleEvaluationError, RuleExpression, RulesEngine, allEqual } from "./rules-engine.engine";

/**
 * Pure unit tests — no Postgres needed, unlike almost everything else in
 * this codebase's test suite (Decision: "real Postgres, no mocks" only
 * applies to code that actually touches the database; this engine
 * deliberately never does). Coverage goal: every operator, both true and
 * false outcomes, the three composition forms (all/any/not) nested
 * together, and the specific error cases the engine promises to throw
 * on rather than silently misevaluate.
 */
describe("RulesEngine", () => {
  const engine = new RulesEngine();

  describe("leaf operators", () => {
    it("equals / notEquals", () => {
      expect(engine.evaluate({ field: "department", operator: "equals", value: "Engineering" }, { department: "Engineering" })).toBe(
        true
      );
      expect(engine.evaluate({ field: "department", operator: "equals", value: "Engineering" }, { department: "Sales" })).toBe(false);
      expect(engine.evaluate({ field: "department", operator: "notEquals", value: "Engineering" }, { department: "Sales" })).toBe(true);
    });

    it("in / notIn", () => {
      const expr: RuleExpression = { field: "location", operator: "in", value: ["Karachi", "Lahore"] };
      expect(engine.evaluate(expr, { location: "Lahore" })).toBe(true);
      expect(engine.evaluate(expr, { location: "Islamabad" })).toBe(false);
      expect(engine.evaluate({ field: "location", operator: "notIn", value: ["Karachi", "Lahore"] }, { location: "Islamabad" })).toBe(
        true
      );
    });

    it("greaterThan / greaterThanOrEqual / lessThan / lessThanOrEqual on numbers", () => {
      expect(engine.evaluate({ field: "tenureYears", operator: "greaterThan", value: 5 }, { tenureYears: 6 })).toBe(true);
      expect(engine.evaluate({ field: "tenureYears", operator: "greaterThan", value: 5 }, { tenureYears: 5 })).toBe(false);
      expect(engine.evaluate({ field: "tenureYears", operator: "greaterThanOrEqual", value: 5 }, { tenureYears: 5 })).toBe(true);
      expect(engine.evaluate({ field: "tenureYears", operator: "lessThan", value: 5 }, { tenureYears: 4 })).toBe(true);
      expect(engine.evaluate({ field: "tenureYears", operator: "lessThanOrEqual", value: 5 }, { tenureYears: 5 })).toBe(true);
    });

    it("greaterThan on ISO date strings, relying on lexicographic ordering", () => {
      expect(
        engine.evaluate({ field: "hireDate", operator: "greaterThan", value: "2020-01-01" }, { hireDate: "2021-06-15" })
      ).toBe(true);
      expect(
        engine.evaluate({ field: "hireDate", operator: "lessThan", value: "2020-01-01" }, { hireDate: "2021-06-15" })
      ).toBe(false);
    });

    it("between (inclusive on both ends)", () => {
      const expr: RuleExpression = { field: "monthlySalary", operator: "between", value: [50000, 100000] };
      expect(engine.evaluate(expr, { monthlySalary: 50000 })).toBe(true);
      expect(engine.evaluate(expr, { monthlySalary: 100000 })).toBe(true);
      expect(engine.evaluate(expr, { monthlySalary: 49999 })).toBe(false);
      expect(engine.evaluate(expr, { monthlySalary: 100001 })).toBe(false);
    });

    it("contains checks membership in an array-valued field", () => {
      const expr: RuleExpression = { field: "skills", operator: "contains", value: "payroll" };
      expect(engine.evaluate(expr, { skills: ["payroll", "leave"] })).toBe(true);
      expect(engine.evaluate(expr, { skills: ["leave"] })).toBe(false);
    });

    it("isEmpty / isNotEmpty across null, undefined, empty string, empty array, and populated values", () => {
      const isEmpty: RuleExpression = { field: "middleName", operator: "isEmpty" };
      expect(engine.evaluate(isEmpty, { middleName: null })).toBe(true);
      expect(engine.evaluate(isEmpty, { middleName: undefined })).toBe(true);
      expect(engine.evaluate(isEmpty, { middleName: "" })).toBe(true);
      expect(engine.evaluate(isEmpty, { middleName: [] })).toBe(true);
      expect(engine.evaluate(isEmpty, { middleName: "Khan" })).toBe(false);
      expect(engine.evaluate({ field: "middleName", operator: "isNotEmpty" }, { middleName: "Khan" })).toBe(true);
    });
  });

  describe("composition: all / any / not", () => {
    it("all (AND) requires every sub-expression to hold", () => {
      const expr: RuleExpression = {
        all: [
          { field: "department", operator: "equals", value: "Engineering" },
          { field: "location", operator: "equals", value: "Lahore" },
        ],
      };
      expect(engine.evaluate(expr, { department: "Engineering", location: "Lahore" })).toBe(true);
      expect(engine.evaluate(expr, { department: "Engineering", location: "Karachi" })).toBe(false);
    });

    it("any (OR) requires at least one sub-expression to hold", () => {
      const expr: RuleExpression = {
        any: [
          { field: "department", operator: "equals", value: "Engineering" },
          { field: "department", operator: "equals", value: "Sales" },
        ],
      };
      expect(engine.evaluate(expr, { department: "Sales" })).toBe(true);
      expect(engine.evaluate(expr, { department: "HR" })).toBe(false);
    });

    it("not inverts its sub-expression", () => {
      const expr: RuleExpression = { not: { field: "employmentStatus", operator: "equals", value: "terminated" } };
      expect(engine.evaluate(expr, { employmentStatus: "active" })).toBe(true);
      expect(engine.evaluate(expr, { employmentStatus: "terminated" })).toBe(false);
    });

    it("nests all/any/not together, matching a real eligibility-style rule", () => {
      // "Engineering or Product, based in Lahore or Karachi, NOT on probation"
      const expr: RuleExpression = {
        all: [
          { any: [{ field: "department", operator: "equals", value: "Engineering" }, { field: "department", operator: "equals", value: "Product" }] },
          { any: [{ field: "location", operator: "equals", value: "Lahore" }, { field: "location", operator: "equals", value: "Karachi" }] },
          { not: { field: "employmentStatus", operator: "equals", value: "probation" } },
        ],
      };
      expect(engine.evaluate(expr, { department: "Product", location: "Karachi", employmentStatus: "active" })).toBe(true);
      expect(engine.evaluate(expr, { department: "Product", location: "Karachi", employmentStatus: "probation" })).toBe(false);
      expect(engine.evaluate(expr, { department: "Sales", location: "Karachi", employmentStatus: "active" })).toBe(false);
    });
  });

  describe("error handling — loud failures, never silent misevaluation", () => {
    it("throws on an unknown operator", () => {
      const bad = { field: "x", operator: "does_not_exist" } as unknown as RuleExpression;
      expect(() => engine.evaluate(bad, {})).toThrow(RuleEvaluationError);
    });

    it("throws when a comparison operator's field resolves to an unsupported type", () => {
      expect(() => engine.evaluate({ field: "x", operator: "greaterThan", value: 5 }, { x: { nested: true } })).toThrow(
        RuleEvaluationError
      );
    });

    it("throws when comparing mismatched types (number field, string bound)", () => {
      expect(() => engine.evaluate({ field: "x", operator: "greaterThan", value: "5" }, { x: 10 })).toThrow(RuleEvaluationError);
    });

    it("throws on 'in' with a non-array value", () => {
      expect(() => engine.evaluate({ field: "x", operator: "in", value: "not-an-array" }, { x: "a" })).toThrow(RuleEvaluationError);
    });

    it("throws on 'between' with a malformed bound", () => {
      expect(() => engine.evaluate({ field: "x", operator: "between", value: [1] } as unknown as RuleExpression, { x: 5 })).toThrow(
        RuleEvaluationError
      );
    });

    it("throws on 'contains' against a non-array field", () => {
      expect(() => engine.evaluate({ field: "x", operator: "contains", value: "a" }, { x: "not-an-array" })).toThrow(
        RuleEvaluationError
      );
    });

    it("throws on an empty 'all'/'any' list rather than vacuously returning true/false", () => {
      expect(() => engine.evaluate({ all: [] }, {})).toThrow(RuleEvaluationError);
      expect(() => engine.evaluate({ any: [] }, {})).toThrow(RuleEvaluationError);
    });
  });

  describe("validate() — shape/field checking without evaluating against real data", () => {
    it("accepts a well-formed expression", () => {
      expect(() =>
        engine.validate({
          all: [
            { field: "department", operator: "equals", value: "Engineering" },
            { not: { field: "employmentStatus", operator: "equals", value: "terminated" } },
          ],
        })
      ).not.toThrow();
    });

    it("rejects a field outside the caller's allow-list", () => {
      const allowed = new Set(["department", "location"]);
      expect(() => engine.validate({ field: "salary", operator: "equals", value: 1 }, allowed)).toThrow(RuleEvaluationError);
      expect(() => engine.validate({ field: "department", operator: "equals", value: "Engineering" }, allowed)).not.toThrow();
    });

    it("rejects an unknown operator and a missing field name", () => {
      expect(() => engine.validate({ field: "x", operator: "bogus" } as unknown as RuleExpression)).toThrow(RuleEvaluationError);
      expect(() => engine.validate({ field: "", operator: "equals", value: 1 })).toThrow(RuleEvaluationError);
    });

    it("rejects 'in'/'between' with a value shape that could never evaluate safely", () => {
      expect(() => engine.validate({ field: "x", operator: "in", value: "not-an-array" })).toThrow(RuleEvaluationError);
      expect(() => engine.validate({ field: "x", operator: "between", value: [1, 2, 3] })).toThrow(RuleEvaluationError);
    });
  });

  describe("allEqual() — the exact shape Employee Groups' condition matcher needs", () => {
    it("builds an AND-of-equals expression from {field, equals} pairs and evaluates identically to the old .every() matcher", () => {
      const conditions = [
        { field: "department", equals: "Engineering" },
        { field: "employmentType", equals: "full_time" },
      ];
      const expr = allEqual(conditions);
      expect(engine.evaluate(expr, { department: "Engineering", employmentType: "full_time" })).toBe(true);
      expect(engine.evaluate(expr, { department: "Engineering", employmentType: "contractor" })).toBe(false);
    });

    it("a group with zero conditions matches nothing under allEqual (mirrors the old .every() on an empty array being vacuously true — deliberately guarded against elsewhere, since EmployeeGroupsService rejects zero-condition groups at creation)", () => {
      // allEqual([]) itself produces { all: [] }, which the engine's own
      // "no vacuous all/any" rule now rejects outright — this is a strictly
      // SAFER outcome than the old hand-written `.every()` (which would have
      // silently returned true for zero conditions), and is never reachable
      // in practice because EmployeeGroupsService's own assertConditionsValid
      // already requires at least one condition before a group can be saved.
      expect(() => engine.evaluate(allEqual([]), {})).toThrow(RuleEvaluationError);
    });
  });
});
