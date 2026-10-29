import test from "node:test";
import assert from "node:assert/strict";
import { dataUrlBytes, scaledSize } from "./selfie";

test("a large photo is scaled so its longest side is 320 px, keeping the shape", () => {
  assert.deepEqual(scaledSize(4000, 3000), { width: 320, height: 240 });
  assert.deepEqual(scaledSize(3000, 4000), { width: 240, height: 320 });
});

test("a small photo is never enlarged", () => {
  assert.deepEqual(scaledSize(200, 100), { width: 200, height: 100 });
});

test("the size of a data URL is read from its base64", () => {
  assert.equal(dataUrlBytes("data:image/jpeg;base64,AAAA"), 3);
  assert.equal(dataUrlBytes("data:image/jpeg;base64,AAA="), 2);
  assert.equal(dataUrlBytes("data:image/jpeg;base64,AA=="), 1);
});
