import assert from "node:assert/strict";
import { test } from "node:test";
import type { PayrollRunView } from "@aihxm/shared-types";
import { isGatewayTimeout, waitForRunToSettle } from "./calculationPolling";

const run = (status: string) => ({ status }) as unknown as PayrollRunView;
const nosleep = async () => undefined;

test("gateway timeouts are recognised, ordinary errors are not", () => {
  for (const s of [502, 503, 504, 0, undefined]) assert.equal(isGatewayTimeout(s), true);
  for (const s of [400, 403, 404, 409, 500]) assert.equal(isGatewayTimeout(s), false);
});

test("polls until the run has left calculating", async () => {
  const seq = ["draft", "calculating", "calculating", "calculated"];
  let i = 0;
  const done = await waitForRunToSettle(async () => run(seq[Math.min(i++, seq.length - 1)]), "draft", { sleep: nosleep });
  assert.equal(done?.status, "calculated");
});

test("a re-calculation that stays calculated is accepted once it stopped calculating", async () => {
  const seq = ["calculating", "calculated"];
  let i = 0;
  const done = await waitForRunToSettle(async () => run(seq[Math.min(i++, seq.length - 1)]), "calculated", { sleep: nosleep });
  assert.equal(done?.status, "calculated");
});

test("gives up with null when nothing changed in time", async () => {
  const done = await waitForRunToSettle(async () => run("draft"), "draft", { sleep: nosleep, intervalMs: 1000, maxMs: 3000 });
  assert.equal(done, null);
});
