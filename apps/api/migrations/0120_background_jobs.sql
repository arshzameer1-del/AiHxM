-- Gap Register PLT-03 (Step 1): generic async job table.
--
-- Named `background_jobs` because `jobs` is already the Organization
-- Management job-catalogue table (0068). One durable queue for imports,
-- exports, payroll partitions, report runs and integrations: a job carries a
-- type, a JSON payload, an idempotency key (so enqueuing the same work twice
-- is a no-op), status, progress, attempt counters with a max, a dead-letter
-- flag, a correlation id and a lease (locked_until) so a crashed worker's job
-- is picked up again. Workers claim with FOR UPDATE SKIP LOCKED
-- (JobsService.claimNext) so several workers never run the same job.
--
-- Statuses: queued, running, completed, failed, cancelled. A failed job with
-- attempts left goes back to 'queued' with a backoff `run_after`; when
-- attempts are exhausted it stays 'failed' with dead_lettered = true.
--
-- Internal infrastructure (no end-user API yet) -> RLS only, no RBAC seed;
-- a "Job Monitor" screen is deferred by Kumail (register A4).
--
-- ROLLBACK: DROP TABLE background_jobs;

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

CREATE TABLE IF NOT EXISTS background_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  job_type         text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  idempotency_key  text,
  progress_percent int NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  progress_note    text,
  attempts         int NOT NULL DEFAULT 0,
  max_attempts     int NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  dead_lettered    boolean NOT NULL DEFAULT false,
  run_after        timestamptz NOT NULL DEFAULT now(),
  locked_by        text,
  locked_until     timestamptz,
  result           jsonb,
  last_error       text,
  correlation_id   uuid,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  CONSTRAINT background_jobs_dead_letter_only_when_failed CHECK (NOT dead_lettered OR status = 'failed')
);

-- one live job per (company, type, idempotency key)
CREATE UNIQUE INDEX IF NOT EXISTS idx_background_jobs_idem
  ON background_jobs (company_id, job_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_background_jobs_claim
  ON background_jobs (run_after) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_background_jobs_company_status
  ON background_jobs (company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_background_jobs_correlation
  ON background_jobs (correlation_id) WHERE correlation_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON background_jobs TO app_role;

ALTER TABLE background_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE background_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY background_jobs_all ON background_jobs FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
