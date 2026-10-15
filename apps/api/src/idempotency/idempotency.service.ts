import { ConflictException, Injectable } from "@nestjs/common";
import { createHash } from "crypto";
import type { PoolClient } from "pg";
import type { RequestClaims } from "../database/tenant-context";
import { currentCorrelationId } from "../common/request-context";

/** Stable JSON: object keys sorted recursively so {a,b} and {b,a} hash alike. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

export function hashRequest(request: unknown): string {
  return createHash("sha256").update(stableStringify(request)).digest("hex");
}

export type IdempotentInput = {
  companyId: string;
  /** The operation, e.g. "payroll.finalize". Keys are unique per (company, scope). */
  scope: string;
  /** Client-supplied Idempotency-Key header value (8–200 chars). */
  key: string;
  /** Anything that defines "the same request": path params + body. */
  request: unknown;
  ttlHours?: number;
};

/**
 * Gap Register SEC-10. Wrap a retry-sensitive write in `execute()` from
 * INSIDE the caller's tenant transaction:
 *
 *   same key + same request   -> returns the stored result, `fn` NOT re-run
 *   same key + other request  -> 409 Conflict
 *   new key                   -> runs `fn`, stores its (JSON) result
 *
 * The idempotency row is written in the same transaction as `fn`'s own
 * writes, so either both commit or neither does — a crash can never leave
 * "done" recorded without the work (or the work without the record).
 * Concurrent duplicates serialize on the (company, scope, key) unique
 * index: the second INSERT blocks until the first commits, then sees it.
 */
@Injectable()
export class IdempotencyService {
  async execute<T>(
    client: PoolClient,
    claims: RequestClaims,
    input: IdempotentInput,
    fn: () => Promise<T>
  ): Promise<{ result: T; replayed: boolean }> {
    if (input.key.length < 8 || input.key.length > 200) {
      throw new ConflictException("Idempotency-Key must be between 8 and 200 characters.");
    }
    const requestHash = hashRequest(input.request);
    const ttl = input.ttlHours ?? 24;

    for (let attempt = 0; attempt < 2; attempt++) {
      const inserted = await client.query(
        `INSERT INTO idempotency_keys (company_id, scope, key, request_hash, created_by, correlation_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' hours')::interval)
         ON CONFLICT (company_id, scope, key) DO NOTHING
         RETURNING id`,
        [input.companyId, input.scope, input.key, requestHash, claims.sub, currentCorrelationId(), String(ttl)]
      );

      if (inserted.rowCount) {
        const result = await fn();
        await client.query(
          `UPDATE idempotency_keys
              SET status = 'completed', response_ref = $2::jsonb, response_status = 200, completed_at = now()
            WHERE id = $1`,
          [inserted.rows[0].id, JSON.stringify(result ?? null)]
        );
        return { result, replayed: false };
      }

      const existing = await client.query(
        `SELECT id, request_hash, status, response_ref, expires_at < now() AS expired
           FROM idempotency_keys WHERE company_id = $1 AND scope = $2 AND key = $3 FOR UPDATE`,
        [input.companyId, input.scope, input.key]
      );
      const row = existing.rows[0];
      if (!row) continue; // vanished between statements (purged) — try inserting again
      if (row.expired) {
        await client.query("DELETE FROM idempotency_keys WHERE id = $1", [row.id]);
        continue;
      }
      if (row.request_hash !== requestHash) {
        throw new ConflictException("This Idempotency-Key was already used for a different request.");
      }
      if (row.status !== 'completed') {
        throw new ConflictException("A request with this Idempotency-Key is still being processed.");
      }
      return { result: row.response_ref as T, replayed: true };
    }
    throw new ConflictException("Could not acquire the Idempotency-Key; please retry.");
  }

  /** Housekeeping; safe to call from a scheduled job. Returns rows removed. */
  async purgeExpired(client: PoolClient): Promise<number> {
    const r = await client.query("DELETE FROM idempotency_keys WHERE expires_at < now()");
    return r.rowCount ?? 0;
  }
}
