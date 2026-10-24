import assert from "node:assert/strict";
import { test } from "node:test";
import { describeDevice, passwordProblem, recoveryCodesText } from "./accountForm";

test("passwordProblem checks current, length, difference and confirmation", () => {
  assert.match(passwordProblem("", "long-enough-1", "long-enough-1") ?? "", /current password/);
  assert.match(passwordProblem("old", "short", "short") ?? "", /at least 10/);
  assert.match(passwordProblem("same-password-1", "same-password-1", "same-password-1") ?? "", /different/);
  assert.match(passwordProblem("old", "long-enough-1", "long-enough-2") ?? "", /do not match/);
  assert.equal(passwordProblem("old", "long-enough-1", "long-enough-1"), null);
});

test("describeDevice names the browser and system", () => {
  assert.equal(describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"), "Chrome on Windows");
  assert.equal(describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17 Safari/604"), "Safari on iPhone / iPad");
  assert.equal(describeDevice("Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0"), "Firefox on Linux");
  assert.equal(describeDevice(null), "Unknown device");
});

test("recoveryCodesText lists every code once", () => {
  const text = recoveryCodesText(["AAAAA-BBBBB", "CCCCC-DDDDD"]);
  assert.ok(text.includes("AAAAA-BBBBB") && text.includes("CCCCC-DDDDD"));
});
