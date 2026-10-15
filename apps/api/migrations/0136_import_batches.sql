-- Gap Register LIF-11 (Step 5E). ADDITIVE.
--
-- Bulk hiring becomes a two-phase, resumable batch:
--   1. DRY RUN  parse + validate every row, store the result per row (nothing
--               is created). The batch records a hash of the configuration it
--               was validated against (employee-numbering policy, hiring
--               card definitions, required-field rules).
--   2. EXECUTE  a background job (background_jobs, job_type 'employee_import')
--               creates the valid rows one by one, each in its own
--               transaction, advancing `checkpoint_row` so a crashed worker
--               resumes where it stopped. Row failures are recorded per row
--               and never abort the batch. Execution is refused if the
--               configuration changed since the dry run.
--
-- import_batches.idempotency_key makes a retried upload / execute return the
-- same batch instead of importing twice. import_rows.payload holds the parsed
-- row (PII); sensitive keys are nulled out when the batch finishes.
-- The legacy synchronous POST /employees/bulk-import is unchanged.
--
-- ROLLBACK: DROP TABLE import_rows, import_batches;
--   DELETE FROM background_jobs WHERE job_type = 'employee_import';

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

CREATE TABLE IF NOT EXISTS import_batches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  import_type         text NOT NULL DEFAULT 'employees' CHECK (import_type IN ('employees')),
  status              text NOT NULL DEFAULT 'dry_run_complete' CHECK (status IN
                        ('dry_run_complete', 'queued', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled')),
  file_name           text,
  source_hash         text NOT NULL,
  config_hash         text NOT NULL,
  config_snapshot     jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_rows          integer NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  valid_rows          integer NOT NULL DEFAULT 0 CHECK (valid_rows >= 0),
  invalid_rows        integer NOT NULL DEFAULT 0 CHECK (invalid_rows >= 0),
  imported_rows       integer NOT NULL DEFAULT 0 CHECK (imported_rows >= 0),
  failed_rows         integer NOT NULL DEFAULT 0 CHECK (failed_rows >= 0),
  checkpoint_row      integer NOT NULL DEFAULT 0 CHECK (checkpoint_row >= 0),
  allow_partial       boolean NOT NULL DEFAULT false,
  idempotency_key     text,
  background_job_id   uuid REFERENCES background_jobs(id) ON DELETE SET NULL,
  created_by_user_account_id uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  executed_by_user_account_id uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  executed_at         timestamptz,
  started_at          timestamptz,
  finished_at         timestamptz,
  last_error          text,
  CONSTRAINT import_batches_counts CHECK (valid_rows + invalid_rows <= total_rows)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_import_batches_idem
  ON import_batches (company_id, import_type, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_import_batches_company ON import_batches (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_batches_job ON import_batches (background_job_id) WHERE background_job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS import_rows (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id      uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  row_number    integer NOT NULL CHECK (row_number >= 2),
  status        text NOT NULL CHECK (status IN ('valid', 'invalid', 'imported', 'failed')),
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  errors        jsonb NOT NULL DEFAULT '[]'::jsonb,
  employee_id   uuid REFERENCES employees(id) ON DELETE SET NULL,
  processed_at  timestamptz,
  CONSTRAINT import_rows_unique UNIQUE (batch_id, row_number)
);
CREATE INDEX IF NOT EXISTS idx_import_rows_status ON import_rows (batch_id, status);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['import_batches', 'import_rows'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format($p$CREATE POLICY %I ON %I
      USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
      WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())$p$, t || '_all', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON import_batches, import_rows TO app_role;
