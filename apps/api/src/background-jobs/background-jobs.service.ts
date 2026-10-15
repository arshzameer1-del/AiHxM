import { Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { RequestClaims } from "../database/tenant-context";
import { currentCorrelationId } from "../common/request-context";

export type BackgroundJob = {
  id: string;
  companyId: string;
  jobType: string;
  payload: Record<string, unknown>;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  idempotencyKey: string | null;
  progressPercent: number;
  progressNote: string | null;
  attempts: number;
  maxAttempts: number;
  deadLettered: boolean;
  runAfter: string;
  result: unknown;
  lastError: string | null;
  correlationId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toJob(r: any): BackgroundJob {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : ((v as string | null) ?? null));
  return {
    id: r.id,
    companyId: r.company_id,
    jobType: r.job_type,
    payload: r.payload,
    status: r.status,
    idempotencyKey: r.idempotency_key,
    progressPercent: r.progress_percent,
    progressNote: r.progress_note,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    deadLettered: r.dead_lettered,
    runAfter: iso(r.run_after) as string,
    result: r.result,
    lastError: r.last_error,
    correlationId: r.correlation_id,
    createdAt: iso(r.created_at) as string,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  };
}

/** Exponential backoff: 30s, 60s, 2m, 4m ... capped at 1 hour. */
export function jobBackoffSeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(attempts - 1, 0), 3600);
}

/**
 * Gap Register PLT-03 — the generic durable job queue (table background_jobs).
 * Every method runs on the caller's client so enqueueing commits atomically
 * with the business change that caused it. Workers must call claimNext() with
 * is_service claims (it deliberately spans tenants).
 */
@Injectable()
export class BackgroundJobsService {
  async enqueue(
    client: PoolClient,
    claims: RequestClaims,
    input: {
      companyId: string;
      jobType: string;
      payload?: Record<string, unknown>;
      idempotencyKey?: string;
      maxAttempts?: number;
      runAfter?: Date;
    }
  ): Promise<BackgroundJob> {
    const inserted = await client.query(
      `INSERT INTO background_jobs (company_id, job_type, payload, idempotency_key, max_attempts, run_after, correlation_id, created_by)
       VALUES ($1, $2, $3::jsonb, $4, $5, COALESCE($6, now()), $7, $8)
       ON CONFLICT (company_id, job_type, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING *`,
      [
        input.companyId,
        input.jobType,
        JSON.stringify(input.payload ?? {}),
        input.idempotencyKey ?? null,
        input.maxAttempts ?? 3,
        input.runAfter ?? null,
        currentCorrelationId(),
        claims.sub,
      ]
    );
    if (inserted.rowCount) return toJob(inserted.rows[0]);
    // Same idempotency key already enqueued: return that job, do not enqueue twice.
    const existing = await client.query(
      "SELECT * FROM background_jobs WHERE company_id = $1 AND job_type = $2 AND idempotency_key = $3",
      [input.companyId, input.jobType, input.idempotencyKey]
    );
    return toJob(existing.rows[0]);
  }

  /**
   * Atomically leases the next runnable job. Picks queued jobs whose
   * run_after has passed, and `running` jobs whose lease expired (crashed
   * worker). FOR UPDATE SKIP LOCKED => concurrent workers never share a job.
   */
  async claimNext(
    client: PoolClient,
    workerId: string,
    opts: { jobTypes?: string[]; leaseSeconds?: number } = {}
  ): Promise<BackgroundJob | null> {
    const r = await client.query(
      `WITH next AS (
         SELECT id FROM background_jobs
          WHERE ((status = 'queued' AND run_after <= now()) OR (status = 'running' AND locked_until < now()))
            AND ($1::text[] IS NULL OR job_type = ANY($1))
          ORDER BY run_after
          LIMIT 1
          FOR UPDATE SKIP LOCKED)
       UPDATE background_jobs j
          SET status = 'running', attempts = j.attempts + 1, locked_by = $2,
              locked_until = now() + ($3 || ' seconds')::interval,
              started_at = COALESCE(j.started_at, now())
         FROM next WHERE j.id = next.id
       RETURNING j.*`,
      [opts.jobTypes ?? null, workerId, String(opts.leaseSeconds ?? 300)]
    );
    return r.rowCount ? toJob(r.rows[0]) : null;
  }

  async reportProgress(client: PoolClient, jobId: string, percent: number, note?: string, extendLeaseSeconds = 300) {
    await client.query(
      `UPDATE background_jobs
          SET progress_percent = $2, progress_note = COALESCE($3, progress_note),
              locked_until = now() + ($4 || ' seconds')::interval
        WHERE id = $1 AND status = 'running'`,
      [jobId, Math.max(0, Math.min(100, Math.round(percent))), note ?? null, String(extendLeaseSeconds)]
    );
  }

  async complete(client: PoolClient, jobId: string, result?: unknown): Promise<BackgroundJob> {
    const r = await client.query(
      `UPDATE background_jobs
          SET status = 'completed', progress_percent = 100, result = $2::jsonb, finished_at = now(),
              locked_by = NULL, locked_until = NULL, last_error = NULL
        WHERE id = $1 AND status = 'running' RETURNING *`,
      [jobId, JSON.stringify(result ?? null)]
    );
    if (!r.rowCount) throw new NotFoundException("Job is not running.");
    return toJob(r.rows[0]);
  }

  /**
   * Records a failure. Attempts left -> back to `queued` with exponential
   * backoff; exhausted -> `failed` + dead_lettered (needs a human / retry()).
   */
  async fail(client: PoolClient, jobId: string, error: string): Promise<BackgroundJob> {
    const r = await client.query(
      `UPDATE background_jobs
          SET last_error = left($2, 2000), locked_by = NULL, locked_until = NULL,
              status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
              dead_lettered = (attempts >= max_attempts),
              finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
              run_after = CASE WHEN attempts >= max_attempts THEN run_after
                               ELSE now() + (LEAST(30 * power(2, GREATEST(attempts - 1, 0)), 3600) || ' seconds')::interval END
        WHERE id = $1 AND status = 'running' RETURNING *`,
      [jobId, error]
    );
    if (!r.rowCount) throw new NotFoundException("Job is not running.");
    return toJob(r.rows[0]);
  }

  /** Cancels a job that has not started running. */
  async cancel(client: PoolClient, jobId: string): Promise<BackgroundJob> {
    const r = await client.query(
      `UPDATE background_jobs SET status = 'cancelled', finished_at = now()
        WHERE id = $1 AND status = 'queued' RETURNING *`,
      [jobId]
    );
    if (!r.rowCount) throw new NotFoundException("Only queued jobs can be cancelled.");
    return toJob(r.rows[0]);
  }

  /** Re-queues a dead-lettered (or failed) job with a fresh attempt budget. */
  async retry(client: PoolClient, jobId: string): Promise<BackgroundJob> {
    const r = await client.query(
      `UPDATE background_jobs
          SET status = 'queued', dead_lettered = false, attempts = 0, run_after = now(),
              finished_at = NULL, last_error = NULL
        WHERE id = $1 AND status = 'failed' RETURNING *`,
      [jobId]
    );
    if (!r.rowCount) throw new NotFoundException("Only failed jobs can be retried.");
    return toJob(r.rows[0]);
  }

  async get(client: PoolClient, jobId: string): Promise<BackgroundJob> {
    const r = await client.query("SELECT * FROM background_jobs WHERE id = $1", [jobId]);
    if (!r.rowCount) throw new NotFoundException("Job not found.");
    return toJob(r.rows[0]);
  }

  async list(client: PoolClient, filters: { companyId?: string; status?: string; jobType?: string; limit?: number } = {}) {
    const r = await client.query(
      `SELECT * FROM background_jobs
        WHERE ($1::uuid IS NULL OR company_id = $1) AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR job_type = $3)
        ORDER BY created_at DESC LIMIT $4`,
      [filters.companyId ?? null, filters.status ?? null, filters.jobType ?? null, Math.min(filters.limit ?? 50, 200)]
    );
    return r.rows.map(toJob);
  }
}
