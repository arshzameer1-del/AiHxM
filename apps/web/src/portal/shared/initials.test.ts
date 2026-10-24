import assert from "node:assert/strict";
import { test } from "node:test";
import { initialsFromName } from "./initials";

test("initials come from the first and last word", () => {
  assert.equal(initialsFromName("Ayesha Khan"), "AK");
  assert.equal(initialsFromName("muhammad ali raza"), "MR");
  assert.equal(initialsFromName("Bilal"), "B");
});

test("a missing name shows a question mark", () => {
  assert.equal(initialsFromName(""), "?");
  assert.equal(initialsFromName(null), "?");
  assert.equal(initialsFromName("   "), "?");
});
