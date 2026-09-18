import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";

/**
 * Phase 14: Caching layer for hot-path, read-heavy, rarely-changing
 * data — tenant module entitlements, RBAC role->permission maps, leave
 * policy configs. These are read on nearly every authenticated request
 * (guards check entitlements + permissions before the controller even
 * runs) but only change when an HR/system admin edits configuration,
 * so a short TTL cache removes most of that DB round-trip cost without
 * meaningfully risking staleness.
 *
 * Backed by Redis when `REDIS_URL` is set and reachable, so cache state
 * is shared across API instances behind a load balancer (required once
 * we're running more than one node — a per-process in-memory cache
 * would let instances disagree about a tenant's enabled modules).
 * Falls back to an in-process Map when Redis is unavailable (local dev,
 * CI, or a transient Redis outage) so the app degrades to "slower" —
 * every read misses and falls through to Postgres — rather than
 * failing closed. Never a source of truth: every read path here must
 * have a DB fallback on miss, and callers must call `invalidate` (or a
 * namespaced `invalidatePattern`) inside the same transaction/handler
 * that writes the underlying row, so a stale cache entry lives for at
 * most its TTL.
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private redis: Redis | null = null;
  private redisAvailable = false;
  private readonly memoryCache = new Map<string, { value: string; expiresAt: number }>();
  private memoryCacheSweepTimer: NodeJS.Timeout | null = null;

  // Metrics for cache effectiveness monitoring (exposed via getStats()).
  private hits = 0;
  private misses = 0;

  constructor() {
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl) {
      this.redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
        lazyConnect: true,
      });
      this.redis.on("error", (err) => {
        if (this.redisAvailable) {
          this.logger.warn(`Redis connection lost, falling back to in-memory cache: ${err.message}`);
        }
        this.redisAvailable = false;
      });
      this.redis.on("connect", () => {
        this.redisAvailable = true;
        this.logger.log("Redis cache connected");
      });
      this.redis.connect().catch(() => {
        this.logger.warn("Redis unreachable at startup — using in-memory cache fallback");
      });
    } else {
      this.logger.log("REDIS_URL not set — using in-memory cache only");
    }

    // Periodic sweep so the in-memory fallback map doesn't grow unbounded
    // when Redis is absent for an extended period (long-running dev/CI process).
    this.memoryCacheSweepTimer = setInterval(() => this.sweepExpiredMemoryEntries(), 60_000);
    this.memoryCacheSweepTimer.unref?.();
  }

  async onModuleDestroy() {
    if (this.memoryCacheSweepTimer) clearInterval(this.memoryCacheSweepTimer);
    if (this.redis) await this.redis.quit().catch(() => undefined);
  }

  /** Get a cached value, JSON-deserialized. Returns null on miss or parse failure. */
  async get<T>(key: string): Promise<T | null> {
    let raw: string | null = null;

    if (this.redis && this.redisAvailable) {
      try {
        raw = await this.redis.get(key);
      } catch {
        this.redisAvailable = false;
      }
    }

    if (raw === null) {
      raw = this.getFromMemory(key);
    }

    if (raw === null) {
      this.misses++;
      return null;
    }

    this.hits++;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /** Set a value with a TTL in seconds. Writes to Redis and the in-memory fallback so a mid-flight Redis outage doesn't lose the entry entirely. */
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const serialized = JSON.stringify(value);

    if (this.redis && this.redisAvailable) {
      try {
        await this.redis.set(key, serialized, "EX", ttlSeconds);
      } catch {
        this.redisAvailable = false;
      }
    }

    this.setInMemory(key, serialized, ttlSeconds);
  }

  /** Invalidate a single key. Called by the write path immediately after a mutation commits. */
  async invalidate(key: string): Promise<void> {
    if (this.redis && this.redisAvailable) {
      try {
        await this.redis.del(key);
      } catch {
        this.redisAvailable = false;
      }
    }
    this.memoryCache.delete(key);
  }

  /** Invalidate every key matching a prefix, e.g. `entitlements:company-123:*`. Used when a whole tenant's config changes (e.g. package tier change resets all module entitlements at once). */
  async invalidatePattern(prefix: string): Promise<void> {
    if (this.redis && this.redisAvailable) {
      try {
        const stream = this.redis.scanStream({ match: `${prefix}*`, count: 100 });
        const keysToDelete: string[] = [];
        await new Promise<void>((resolve, reject) => {
          stream.on("data", (keys: string[]) => keysToDelete.push(...keys));
          stream.on("end", () => resolve());
          stream.on("error", reject);
        });
        if (keysToDelete.length > 0) {
          await this.redis.del(...keysToDelete);
        }
      } catch {
        this.redisAvailable = false;
      }
    }

    for (const key of this.memoryCache.keys()) {
      if (key.startsWith(prefix)) this.memoryCache.delete(key);
    }
  }

  /**
   * Read-through helper: return the cached value if present, otherwise
   * call `loader`, cache its result, and return it. The common shape
   * for every caller (entitlements, RBAC permissions, leave policies).
   */
  async getOrLoad<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const loaded = await loader();
    await this.set(key, loaded, ttlSeconds);
    return loaded;
  }

  getStats(): { hits: number; misses: number; hitRate: number; backend: "redis" | "memory" } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
      backend: this.redisAvailable ? "redis" : "memory",
    };
  }

  isRedisAvailable(): boolean {
    return this.redisAvailable;
  }

  private getFromMemory(key: string): string | null {
    const entry = this.memoryCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.memoryCache.delete(key);
      return null;
    }
    return entry.value;
  }

  private setInMemory(key: string, value: string, ttlSeconds: number): void {
    this.memoryCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  private sweepExpiredMemoryEntries(): void {
    const now = Date.now();
    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.expiresAt < now) this.memoryCache.delete(key);
    }
  }
}
