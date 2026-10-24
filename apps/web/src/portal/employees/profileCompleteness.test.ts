import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProfileCompletenessItem } from "@aihxm/shared-types";
import { completenessLink, completenessTone, missingItems } from "./profileCompleteness";
import { profileTabFromParam } from "./profileTabs";

const item = (key: string, done: boolean, tab: ProfileCompletenessItem["tab"] = "contact"): ProfileCompletenessItem => ({ key, label: key, tab, done, hint: done ? "" : `add ${key}` });

test("tone follows the score", () => {
  assert.equal(completenessTone(100), "good");
  assert.equal(completenessTone(90), "good");
  assert.equal(completenessTone(75), "warn");
  assert.equal(completenessTone(30), "bad");
});

test("missingItems keeps the checked order and honours the limit", () => {
  const items = [item("a", true), item("b", false), item("c", false), item("d", true), item("e", false)];
  assert.deepEqual(missingItems(items, 2).map((i) => i.key), ["b", "c"]);
  assert.deepEqual(missingItems(items).map((i) => i.key), ["b", "c", "e"]);
});

test("every tab the server can name opens a real My Profile tab", () => {
  for (const tab of ["personal", "contact", "addresses", "family", "bank", "documents"] as const) {
    const param = completenessLink(tab).split("tab=")[1];
    assert.equal(profileTabFromParam(param) !== "Personal Information" || tab === "personal", true, tab);
  }
});
