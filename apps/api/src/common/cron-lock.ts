import type { Pool } from "pg";
import { Logger } from "@nestjs/common";

/**
 * Scheduled jobs run inside every API process. With more than one instance (or an overlapping slow run) the same job would
 * run twice. `@ExclusiveCron("name")` wraps a scheduled method in a Postgres session advisory lock: whoever gets the lock
 * runs, everyone else skips this tick quietly. Put it directly BELOW `@Cron(...)` (decorators apply bottom-up, and the
 * schedule must see the wrapped function).
 *
 * When no database pool has been registered (unit tests that build a scheduler by hand) the method simply runs.
 */
let lockPool: Pool | null = null;
const logger = new Logger("CronLock");

export function registerCronLockPool(pool: Pool | null): void {
  lockPool = pool;
}

export async function runExclusive<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (!lockPool) return fn();
  let client;
  try {
    client = await lockPool.connect();
  } catch (err) {
    // Database unreachable: do not pile up errors from every job, the readiness check already shows it.
    logger.warn(`Skipped "${name}": database not reachable (${(err as Error).message})`);
    return undefined;
  }
  let locked = false;
  try {
    const res = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1, 91)) AS ok", [`cron:${name}`]);
    locked = res.rows[0]?.ok === true;
    if (!locked) return undefined;
    return await fn();
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 91))", [`cron:${name}`]).catch(() => undefined);
    client.release();
  }
}

export function ExclusiveCron(name: string): MethodDecorator {
  return (_target, _key, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: unknown[]) => Promise<unknown>;
    descriptor.value = function (this: unknown, ...args: unknown[]) {
      return runExclusive(name, () => Promise.resolve(original.apply(this, args)));
    };
    return descriptor;
  };
}
