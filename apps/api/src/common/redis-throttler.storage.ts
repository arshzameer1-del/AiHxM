import type { ThrottlerStorage } from "@nestjs/throttler";
import type { ThrottlerStorageRecord } from "@nestjs/throttler/dist/throttler-storage-record.interface";
import Redis from "ioredis";

/**
 * Shared rate-limit counters. The default store lives in one process's memory, so a second API instance would double every
 * limit. With REDIS_URL set every instance counts in Redis; if Redis is unreachable a request is counted in memory instead
 * (never failing the request because the limiter is down).
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly redis: Redis;
  private readonly local = new Map<string, { hits: number; expiresAt: number }>();

  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true, retryStrategy: (n) => (n > 3 ? null : n * 200) });
    this.redis.on("error", () => undefined);
    this.redis.connect().catch(() => undefined);
  }

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    const k = `throttle:${throttlerName}:${key}`;
    let hits: number;
    let ttlMs: number;
    try {
      const res = await this.redis.multi().incr(k).pttl(k).exec();
      hits = Number(res?.[0]?.[1]);
      ttlMs = Number(res?.[1]?.[1]);
      if (!Number.isFinite(hits)) throw new Error("redis unavailable");
      if (ttlMs < 0) {
        await this.redis.pexpire(k, ttl);
        ttlMs = ttl;
      }
    } catch {
      const now = Date.now();
      const cur = this.local.get(k);
      if (!cur || cur.expiresAt <= now) this.local.set(k, { hits: 1, expiresAt: now + ttl });
      else cur.hits += 1;
      const rec = this.local.get(k)!;
      hits = rec.hits;
      ttlMs = rec.expiresAt - now;
    }
    const blocked = hits > limit;
    return {
      totalHits: hits,
      timeToExpire: Math.ceil(ttlMs / 1000),
      isBlocked: blocked,
      timeToBlockExpire: blocked ? Math.ceil((blockDuration > 0 ? blockDuration : ttlMs) / 1000) : 0,
    };
  }
}
