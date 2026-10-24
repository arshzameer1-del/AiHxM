import test from "node:test";
import assert from "node:assert/strict";
import { createResponseCache, isCacheablePath, FRESH_MS } from "./responseCache";

function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    raw: m,
  };
}

function setup() {
  let t = 1_000_000;
  const storage = memStorage();
  const cache = createResponseCache({ now: () => t, storage });
  cache.setOwner("user-a");
  let calls = 0;
  const fetcher = (body: string) => async () => {
    calls++;
    return body;
  };
  return { cache, storage, advance: (ms: number) => (t += ms), calls: () => calls, fetcher };
}

test("a fresh answer is served without asking the server again", async () => {
  const s = setup();
  assert.equal(await s.cache.get("/x", s.fetcher('{"a":1}')), '{"a":1}');
  assert.equal(await s.cache.get("/x", s.fetcher('{"a":2}')), '{"a":1}');
  assert.equal(s.calls(), 1);
});

test("an old answer is never shown: the server is asked and the new answer returned", async () => {
  const s = setup();
  await s.cache.get("/x", s.fetcher("old"));
  s.advance(FRESH_MS + 1);
  assert.equal(await s.cache.get("/x", s.fetcher("new")), "new");
  assert.equal(s.calls(), 2);
});

test("a save empties the cache so the next read goes to the server", async () => {
  const s = setup();
  await s.cache.get("/x", s.fetcher("old"));
  s.cache.invalidateAll();
  assert.equal(await s.cache.get("/x", s.fetcher("new")), "new");
});

test("an answer that was on its way when a save happened is not kept", async () => {
  const s = setup();
  let release!: (v: string) => void;
  const slow = s.cache.get("/x", () => new Promise<string>((r) => (release = r)));
  s.cache.invalidateAll();
  release("before-save");
  assert.equal(await slow, "before-save");
  assert.equal(s.cache.has("/x"), false);
});

test("bypass always asks the server (polling) and keeps the answer", async () => {
  const s = setup();
  await s.cache.get("/run", s.fetcher("calculating"));
  assert.equal(await s.cache.get("/run", s.fetcher("done"), { bypass: true }), "done");
  assert.equal(await s.cache.get("/run", s.fetcher("later")), "done");
});

test("two screens asking at once share one request", async () => {
  const s = setup();
  const [a, b] = await Promise.all([s.cache.get("/x", s.fetcher("v")), s.cache.get("/x", s.fetcher("v"))]);
  assert.equal(a, b);
  assert.equal(s.calls(), 1);
});

test("a different signed-in user starts with an empty cache", async () => {
  const s = setup();
  await s.cache.get("/x", s.fetcher("a-data"));
  s.cache.setOwner("user-b");
  assert.equal(s.cache.has("/x"), false);
  assert.equal(await s.cache.get("/x", s.fetcher("b-data")), "b-data");
});

test("signing out wipes memory and the stored copy", async () => {
  const s = setup();
  await s.cache.get("/x", s.fetcher("a-data"));
  await new Promise((r) => setTimeout(r, 450));
  assert.ok(s.storage.raw.get("aihxm.swr.v1"));
  s.cache.setOwner("");
  assert.equal(s.cache.size(), 0);
  assert.equal(s.storage.raw.get("aihxm.swr.v1"), undefined);
});

test("the stored copy is reloaded for the same user and ignored for another", async () => {
  const s = setup();
  await s.cache.get("/x", s.fetcher("kept"));
  await new Promise((r) => setTimeout(r, 450));
  const t = 1_000_000;
  const same = createResponseCache({ now: () => t + 1000, storage: s.storage });
  same.setOwner("user-a");
  assert.equal(same.has("/x"), true);
  const other = createResponseCache({ now: () => t + 1000, storage: s.storage });
  other.setOwner("user-b");
  assert.equal(other.has("/x"), false);
});

test("a failed request is not cached", async () => {
  const s = setup();
  await assert.rejects(s.cache.get("/x", async () => Promise.reject(new Error("boom"))));
  assert.equal(s.cache.has("/x"), false);
  assert.equal(await s.cache.get("/x", s.fetcher("ok")), "ok");
});

test("in-use list orders recent reads first and background refresh replaces the answer", async () => {
  const s = setup();
  await s.cache.get("/a", s.fetcher("a1"));
  s.advance(1000);
  await s.cache.get("/b", s.fetcher("b1"));
  assert.deepEqual(s.cache.inUse(5), ["/b", "/a"]);
  s.advance(FRESH_MS - 10);
  await s.cache.refresh("/a", s.fetcher("a2"));
  assert.equal(await s.cache.get("/a", s.fetcher("never")), "a2");
});

test("only safe paths are cacheable", () => {
  assert.equal(isCacheablePath("/payroll/dashboard"), true);
  assert.equal(isCacheablePath("/employees?x=1"), true);
  assert.equal(isCacheablePath("/auth/me"), true);
  assert.equal(isCacheablePath("/auth/step-up"), false);
  assert.equal(isCacheablePath("/auth/mfa/verify"), false);
  assert.equal(isCacheablePath("/employees/1/documents/2"), false);
  assert.equal(isCacheablePath("/payroll/runs/1/disbursement"), true);
  assert.equal(isCacheablePath("/platform/companies/1/exports/2/download"), false);
  assert.equal(isCacheablePath("/platform/companies/1/backups"), false);
  assert.equal(isCacheablePath("/notifications/inbox"), false); // the bell must always be current
  assert.equal(isCacheablePath("/notifications/preferences"), false);
});

test("a page reload keeps only very recent answers", async () => {
  const s = setup();
  await s.cache.get("/x", s.fetcher("kept"));
  await new Promise((r) => setTimeout(r, 450));
  const later = createResponseCache({ now: () => 1_000_000 + 60_000, storage: s.storage });
  later.setOwner("user-a");
  assert.equal(later.has("/x"), false);
});
