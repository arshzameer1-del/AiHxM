import { BadRequestException } from "@nestjs/common";
import { formByKey } from "./form-catalog";
import { conditionHolds, describeCondition, validateLayout, visibleKeys } from "./form-layout.rules";

const form = formByKey("employee_profile")!;
const all = form.fields.map((f) => ({ key: f.key }));
const one = (extra: object = {}) => ({ sections: [{ key: "main", title: "", fields: all, ...extra }] });
const msg = (fn: () => unknown) => {
  try { fn(); } catch (e) { return JSON.stringify((e as BadRequestException).getResponse()); }
  return "";
};

describe("form layout rules", () => {
  it("accepts the default layout and a grouped one", () => {
    expect(() => validateLayout(one(), form, new Set())).not.toThrow();
    const grouped = { sections: [
      { key: "a", title: "Personal", fields: all.slice(0, 8) },
      { key: "b", title: "Work", fields: all.slice(8) },
    ] };
    expect(validateLayout(grouped, form, new Set()).sections).toHaveLength(2);
  });

  it.each([
    ["no sections", { sections: [] }, "at least one section"],
    ["a field twice", { sections: [{ key: "a", title: "A", fields: [...all, { key: "phone" }] }] }, "placed twice"],
    ["an unknown field", { sections: [{ key: "a", title: "A", fields: [...all, { key: "nope" }] }] }, "not a field of this form"],
    ["an unknown custom field", { sections: [{ key: "a", title: "A", fields: [...all, { key: "ghost", custom: true }] }] }, "not one of your custom fields"],
    ["an always-needed field removed", { sections: [{ key: "a", title: "A", fields: all.filter((f) => f.key !== "firstName") }] }, "cannot be removed"],
    ["a bad section key", { sections: [{ key: "Bad Key", title: "A", fields: all }] }, "not valid"],
    ["a blank title with two sections", { sections: [{ key: "a", title: "", fields: all.slice(0, 8) }, { key: "b", title: "B", fields: all.slice(8) }] }, "needs a title"],
  ])("refuses %s", (_n, layout, expected) => {
    expect(msg(() => validateLayout(layout, form, new Set()))).toContain(expected);
  });

  it("refuses a show condition on an always-needed field, a self reference, a missing target and a loop", () => {
    const withCond = (key: string, extra: object) => ({ sections: [{ key: "a", title: "", fields: all.map((f) => (f.key === key ? { ...f, ...extra } : f)) }] });
    expect(msg(() => validateLayout(withCond("firstName", { showWhen: { field: "gender", op: "filled" } }), form, new Set()))).toContain("shown only sometimes");
    expect(msg(() => validateLayout(withCond("cnic", { showWhen: { field: "cnic", op: "filled" } }), form, new Set()))).toContain("depend on itself");
    expect(msg(() => validateLayout(withCond("cnic", { showWhen: { field: "ghost", op: "filled" } }), form, new Set()))).toContain("not on the form");
    expect(msg(() => validateLayout(withCond("cnic", { showWhen: { field: "gender", op: "equals" } }), form, new Set()))).toContain("needs a value");
    const loop = { sections: [{ key: "a", title: "", fields: all.map((f) => (f.key === "cnic" ? { ...f, showWhen: { field: "salaryBand", op: "filled" } } : f.key === "salaryBand" ? { ...f, showWhen: { field: "cnic", op: "filled" } } : f)) }] };
    expect(msg(() => validateLayout(loop, form, new Set()))).toContain("loop");
  });

  it("required-when only where a field can be required", () => {
    const fixedReq = { sections: [{ key: "a", title: "", fields: all.map((f) => (f.key === "firstName" ? { ...f, requiredWhen: { field: "cnic", op: "filled" } } : f)) }] };
    expect(msg(() => validateLayout(fixedReq, form, new Set()))).toContain("always required");
  });

  it("conditions compare text without case and treat empty as empty", () => {
    expect(conditionHolds({ field: "g", op: "equals", value: "Female" }, { g: "female" })).toBe(true);
    expect(conditionHolds({ field: "g", op: "notEquals", value: "female" }, {})).toBe(true);
    expect(conditionHolds({ field: "g", op: "filled" }, { g: "  " })).toBe(false);
    expect(conditionHolds({ field: "g", op: "empty" }, { g: null })).toBe(true);
    expect(describeCondition({ field: "gender", op: "equals", value: "male" }, (k) => k.toUpperCase())).toBe('GENDER is "male"');
  });

  it("visibleKeys hides a field whose condition fails, and anything that depends on a hidden field", () => {
    const layout = { sections: [{ key: "a", title: "", fields: [{ key: "x" }, { key: "y", showWhen: { field: "x", op: "equals" as const, value: "1" } }, { key: "z", showWhen: { field: "y", op: "filled" as const } }] }] };
    expect([...visibleKeys(layout, { x: "2", y: "v" })]).toEqual(["x"]);
    expect([...visibleKeys(layout, { x: "1", y: "v" })].sort()).toEqual(["x", "y", "z"]);
  });
});
