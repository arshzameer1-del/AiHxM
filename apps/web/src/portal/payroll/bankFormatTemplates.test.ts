import assert from "node:assert/strict";
import { test } from "node:test";
import { BANK_FORMAT_TEMPLATES } from "./bankFormatTemplates";

test("every template has unique codes, no repeated column, and names only columns it uses", () => {
  const codes = BANK_FORMAT_TEMPLATES.map((t) => t.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const t of BANK_FORMAT_TEMPLATES) {
    assert.equal(new Set(t.columns).size, t.columns.length, t.key);
    assert.ok(t.columns.includes("netPay"), `${t.key} carries the amount`);
    for (const k of Object.keys(t.headerLabels)) assert.ok(t.columns.includes(k as never), `${t.key}: label for a column that is not in the file (${k})`);
    assert.match(t.code, /^[a-z0-9_]+$/);
  }
});
