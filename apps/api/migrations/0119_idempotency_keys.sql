-- Gap Register SEC-10 (Step 1): a general idempotency store.
--
-- Before this, only hire completion had ad-hoc idempotency (0082 header:
-- "no separate idempotency-key table"). Payroll finalize/release, payment
-- batches, imports and any retry-sensitive write could double-execute on a
-- client retry or a proxy replay. `idempotency_keys` is the shared store:
-- one row per (company, scope, key) holding a hash of the request, so
--   * same key + same request  -> replay the stored response, do not re-run
--   * same key + DIFFERENT request -> reject (409), never silently re-run
--   * same key while the first is still in flight -> reject (409)
-- Rows expire (default 24h; purgeable by IdempotencyService.purgeExpired()).
--
-- Internal infrastructure table: written only by IdempotencyService inside
-- the caller's transaction; no end-user API, hence no RBAC permission seed
-- (register A2.6 applies to user-facing tenant objects). Tenant isolation is
-- by RLS identical to every other tenant table.
--
-- ROLLBACK: DROP TABLE idempotency_keys;

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- the operation, e.g. 'hire.complete', 'payroll.finalize', 'import.commit'
  scope           text NOT NULL,
  key             text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  request_hash    text NOT NULL,
  status          text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  -- small JSON-able result, or a pointer ({ "table": "...", "id": "..." })
  response_ref    jsonb,
  response_status int,
  created_by      text,
  correlation_id  uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  UNIQUE (company_id, scope, key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires ON idempotency_keys (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO app_role;

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY idempotency_keys_all ON idempotency_keys FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
