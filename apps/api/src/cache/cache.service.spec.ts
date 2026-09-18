import { CacheService } from "./cache.service";

/**
 * Phase 14: Cache service tests.
 *
 * Run without REDIS_URL set (the default test environment), so these
 * exercise the in-memory fallback path exclusively — that path is what
 * CI and most local dev actually run on, and it must behave correctly
 * on its own since Redis is an optional accelerator, not a dependency.
 * A separate manual verification against a live Redis (see
 * REDIS_URL=redis://localhost:6379 npm test) confirms the Redis path
 * mirrors this behavior; that one isn't part of the default CI run
 * since it requires a running Redis server.
 */
describe("CacheService", () => {
  let originalRedisUrl: string | undefined;

  beforeAll(() => {
    // Force in-memory fallback mode for deterministic, dependency-free tests.
    originalRedisUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
  });

  afterAll(() => {
    if (originalRedisUrl) process.env.REDIS_URL = originalRedisUrl;
  });

  let cache: CacheService;

  beforeEach(() => {
    cache = new CacheService();
  });

  afterEach(async () => {
    await cache.onModuleDestroy();
  });

  describe("get/set", () => {
    it("returns null for a key that was never set", async () => {
      const result = await cache.get("nonexistent-key");
      expect(result).toBeNull();
    });

    it("returns the value that was set", async () => {
      await cache.set("my-key", { foo: "bar" }, 60);
      const result = await cache.get<{ foo: string }>("my-key");
      expect(result).toEqual({ foo: "bar" });
    });

    it("round-trips primitives, arrays, and nested objects", async () => {
      await cache.set("string-key", "hello", 60);
      await cache.set("number-key", 42, 60);
      await cache.set("array-key", [1, 2, 3], 60);
      await cache.set("nested-key", { a: { b: { c: [1, "x"] } } }, 60);

      expect(await cache.get("string-key")).toBe("hello");
      expect(await cache.get("number-key")).toBe(42);
      expect(await cache.get("array-key")).toEqual([1, 2, 3]);
      expect(await cache.get("nested-key")).toEqual({ a: { b: { c: [1, "x"] } } });
    });

    it("expires a value after its TTL elapses", async () => {
      await cache.set("short-lived", "value", 0); // 0-second TTL: already expired
      // A 0s TTL sets expiresAt to "now", so an immediate read may race;
      // wait a tick to be deterministic.
      await new Promise((r) => setTimeout(r, 10));
      const result = await cache.get("short-lived");
      expect(result).toBeNull();
    });

    it("keeps a value alive within its TTL window", async () => {
      await cache.set("long-lived", "value", 60);
      await new Promise((r) => setTimeout(r, 10));
      const result = await cache.get("long-lived");
      expect(result).toBe("value");
    });
  });

  describe("invalidate", () => {
    it("removes a single key so a subsequent get misses", async () => {
      await cache.set("to-invalidate", "value", 60);
      expect(await cache.get("to-invalidate")).toBe("value");

      await cache.invalidate("to-invalidate");

      expect(await cache.get("to-invalidate")).toBeNull();
    });

    it("is a no-op when invalidating a key that doesn't exist", async () => {
      await expect(cache.invalidate("never-set")).resolves.not.toThrow();
    });
  });

  describe("invalidatePattern", () => {
    it("removes every key sharing a prefix, leaving other keys intact", async () => {
      await cache.set("entitlements:company-A:module-x", "a1", 60);
      await cache.set("entitlements:company-A:module-y", "a2", 60);
      await cache.set("entitlements:company-B:module-x", "b1", 60);

      await cache.invalidatePattern("entitlements:company-A:");

      expect(await cache.get("entitlements:company-A:module-x")).toBeNull();
      expect(await cache.get("entitlements:company-A:module-y")).toBeNull();
      // Company B's entry is untouched — this is what makes the pattern
      // scoping safe for multi-tenant invalidation (editing one tenant's
      // config never evicts another tenant's cache entries).
      expect(await cache.get("entitlements:company-B:module-x")).toBe("b1");
    });
  });

  describe("getOrLoad", () => {
    it("calls the loader on a miss and caches the result", async () => {
      const loader = jest.fn().mockResolvedValue("loaded-value");

      const result = await cache.getOrLoad("computed-key", 60, loader);

      expect(result).toBe("loaded-value");
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it("does not call the loader again on a subsequent hit", async () => {
      const loader = jest.fn().mockResolvedValue("loaded-value");

      await cache.getOrLoad("computed-key-2", 60, loader);
      await cache.getOrLoad("computed-key-2", 60, loader);
      await cache.getOrLoad("computed-key-2", 60, loader);

      expect(loader).toHaveBeenCalledTimes(1);
    });

    it("calls the loader again after invalidation", async () => {
      const loader = jest.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");

      const first = await cache.getOrLoad("computed-key-3", 60, loader);
      await cache.invalidate("computed-key-3");
      const second = await cache.getOrLoad("computed-key-3", 60, loader);

      expect(first).toBe("first");
      expect(second).toBe("second");
      expect(loader).toHaveBeenCalledTimes(2);
    });

    it("re-invokes the loader once the TTL has elapsed", async () => {
      const loader = jest.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");

      const first = await cache.getOrLoad("computed-key-4", 0, loader);
      await new Promise((r) => setTimeout(r, 10));
      const second = await cache.getOrLoad("computed-key-4", 60, loader);

      expect(first).toBe("first");
      expect(second).toBe("second");
      expect(loader).toHaveBeenCalledTimes(2);
    });

    it("propagates a loader rejection without caching it", async () => {
      const loader = jest.fn().mockRejectedValue(new Error("load failed"));

      await expect(cache.getOrLoad("failing-key", 60, loader)).rejects.toThrow("load failed");

      // A failed load must not poison the cache with a bad/empty entry —
      // the next call should retry the loader, not return a cached failure.
      const secondLoader = jest.fn().mockResolvedValue("recovered");
      const result = await cache.getOrLoad("failing-key", 60, secondLoader);
      expect(result).toBe("recovered");
    });
  });

  describe("getStats", () => {
    it("tracks hits and misses and computes hit rate", async () => {
      await cache.set("stats-key", "value", 60);

      await cache.get("stats-key"); // hit
      await cache.get("stats-key"); // hit
      await cache.get("stats-missing"); // miss

      const stats = cache.getStats();

      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(2 / 3, 5);
    });

    it("reports the in-memory backend when Redis is not configured", () => {
      const stats = cache.getStats();
      expect(stats.backend).toBe("memory");
    });
  });

  describe("isRedisAvailable", () => {
    it("reports false when REDIS_URL is not set", () => {
      expect(cache.isRedisAvailable()).toBe(false);
    });
  });

  describe("graceful degradation", () => {
    it("continues to serve from memory when constructed without REDIS_URL", async () => {
      // This is the core resilience property of Phase 14's caching design:
      // the app must not fail when Redis is absent, only get slower.
      await cache.set("degraded-key", "still-works", 60);
      const result = await cache.get("degraded-key");
      expect(result).toBe("still-works");
    });
  });
});
