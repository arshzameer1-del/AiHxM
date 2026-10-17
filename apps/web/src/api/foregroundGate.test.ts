import assert from "node:assert/strict";
import { test } from "node:test";
import { createForegroundGate } from "./foregroundGate";

test("idle resolves at once when no page call is running", async () => {
  const gate = createForegroundGate({ sleep: async () => assert.fail("should not wait") });
  await gate.idle();
});

test("idle waits while a page call is in flight and goes on when it ends", async () => {
  let release!: () => void;
  const gate = createForegroundGate({
    pollMs: 10,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  const call = gate.track(() => new Promise<void>((r) => (release = r)));
  assert.equal(gate.pending(), 1);
  let idled = false;
  const waiting = gate.idle().then(() => (idled = true));
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(idled, false);
  release();
  await call;
  await waiting;
  assert.equal(idled, true);
  assert.equal(gate.pending(), 0);
});

test("a failing page call is still uncounted, and waiting is capped", async () => {
  const gate = createForegroundGate({ pollMs: 5, maxWaitMs: 20, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
  await assert.rejects(gate.track(() => Promise.reject(new Error("x"))));
  assert.equal(gate.pending(), 0);
  void gate.track(() => new Promise<void>(() => undefined)); // never ends
  const t = Date.now();
  await gate.idle();
  assert.ok(Date.now() - t < 500);
});
