import assert from "node:assert/strict";
import { test } from "node:test";
import { amountInWordsPKR, DEFAULT_PAYSLIP_DESIGN, normalizePayslipDesign, PAYSLIP_DESIGN_PRESETS, PAYSLIP_SECTION_KEYS, payslipDesignPreset } from "@aihxm/shared-types";

test("an empty design becomes the default with no problems", () => {
  const r = normalizePayslipDesign({});
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.design, DEFAULT_PAYSLIP_DESIGN);
});

test("every preset is a valid design", () => {
  for (const key of PAYSLIP_DESIGN_PRESETS) {
    const r = normalizePayslipDesign(payslipDesignPreset(key));
    assert.deepEqual(r.problems, [], key);
    assert.equal(r.design.sections.length, PAYSLIP_SECTION_KEYS.length);
  }
});

test("bad values are reported by path and replaced by the default", () => {
  const r = normalizePayslipDesign({ page: { size: "A3", marginMm: 99 }, colors: { accent: "blue" }, sections: [{ key: "details", enabled: true }], lines: { decimals: 1 } });
  const paths = r.problems.map((p) => p.path).sort();
  assert.deepEqual(paths, ["colors.accent", "lines.decimals", "page.marginMm", "page.size", "sections"]);
  assert.equal(r.design.page.size, "A4");
  assert.equal(r.design.colors.accent, DEFAULT_PAYSLIP_DESIGN.colors.accent);
});

test("a section listed twice or text that is too long is refused", () => {
  const dup = payslipDesignPreset("classic").sections.map((s, i) => (i === 1 ? { ...s, key: "details" as const } : s));
  assert.ok(normalizePayslipDesign({ sections: dup }).problems.some((p) => p.path === "sections"));
  assert.ok(normalizePayslipDesign({ header: { title: "x".repeat(41) } }).problems.some((p) => p.path === "header.title"));
  assert.ok(normalizePayslipDesign("nope").problems.length > 0);
});

test("amounts are written in words the Pakistani way", () => {
  assert.equal(amountInWordsPKR(0), "Rupees Zero Only");
  assert.equal(amountInWordsPKR(163350), "Rupees One Lakh Sixty-Three Thousand Three Hundred Fifty Only");
  assert.equal(amountInWordsPKR(1250075.5), "Rupees Twelve Lakh Fifty Thousand Seventy-Five and Paisa Fifty Only");
  assert.equal(amountInWordsPKR(25000000), "Rupees Two Crore Fifty Lakh Only");
});
