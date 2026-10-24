import assert from "node:assert/strict";
import { test } from "node:test";
import { bannerBackground, colourProblem } from "./appearance";

test("the standard banner draws nothing of its own", () => {
  assert.equal(bannerBackground({ bannerMode: "default", bannerPreset: null, bannerColor: null }, null), undefined);
  assert.equal(bannerBackground(null, null), undefined);
});

test("a preset uses its own two colours", () => {
  const css = bannerBackground({ bannerMode: "preset", bannerPreset: "ocean", bannerColor: null }, null)!;
  assert.ok(css.includes("#0f4c75") && css.includes("#1b262c"));
});

test("a colour is used only when white text is readable on it", () => {
  assert.ok(bannerBackground({ bannerMode: "color", bannerColor: "#1e3a8a", bannerPreset: null }, null)!.includes("#1e3a8a"));
  assert.equal(bannerBackground({ bannerMode: "color", bannerColor: "#ffff00", bannerPreset: null }, null), undefined);
});

test("a picture gets a dark layer over it, and falls back to the standard banner until it has loaded", () => {
  const css = bannerBackground({ bannerMode: "image", bannerPreset: null, bannerColor: null }, "blob:abc")!;
  assert.ok(css.includes("blob:abc") && css.includes("rgb(10 12 30 / 0.5)"));
  assert.equal(bannerBackground({ bannerMode: "image", bannerPreset: null, bannerColor: null }, null), undefined);
});

test("colour problems are said in plain words", () => {
  assert.match(colourProblem("blue")!, /#1e3a8a/);
  assert.match(colourProblem("#ffffff")!, /too light/);
  assert.equal(colourProblem("#1e3a8a"), null);
});
