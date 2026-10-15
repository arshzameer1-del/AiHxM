SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- 0145 - Step 9D: scale machinery for payroll calculation (gap register PAY-06).
--   * payroll_run_partitions : a run's population split into ranges, each with its own state and checkpoint, so a
--                              10,000+ employee calculation can be resumed after a crash instead of restarted.
--   * payroll_exceptions     : the per-employee error queue - class, error, retry state, correlation and resolution.
--   * payroll_runs           : how the calculation ran (sync / async), the background job behind it and progress.
-- The generic async "jobs" table the register asks for is the existing `background_jobs` (PLT-03); the worker uses
-- job_type 'payroll_calculation'.
--
-- ROLLBACK (additive):
--   DROP TABLE IF EXISTS payroll_exceptions, payroll_run_partitions;
--   ALTER TABLE payroll_runs DROP COLUMN IF EXISTS calculation_mode, DROP COLUMN IF EXISTS calculation_job_id,
--     DROP COLUMN IF EXISTS partition_count, DROP COLUMN IF EXISTS partitions_completed,
--     DROP COLUMN IF EXISTS calculation_started_at, DROP COLUMN IF EXISTS calculation_error;

ALTER TABLE payroll_runs
  ADD COLUMN IF NOT EXISTS calculation_mode text NOT NULL DEFAULT 'sync' CHECK (calculation_mode IN ('sync', 'async')),
  ADD COLUMN IF NOT EXISTS calculation_job_id uuid,
  ADD COLUMN IF NOT EXISTS partition_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS partitions_completed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS calculation_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS calculation_error text;

CREATE TABLE IF NOT EXISTS payroll_run_partitions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_run_id       uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  calculation_sequence integer NOT NULL,
  partition_no         integer NOT NULL,
  -- the exact employees of this partition, fixed when the partition is cut (a resume never re-selects)
  employee_ids         uuid[] NOT NULL,
  employee_count       integer NOT NULL,
  state                text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'completed', 'failed')),
  attempts             integer NOT NULL DEFAULT 0,
  checkpoint           jsonb NOT NULL DEFAULT '{}'::jsonb,
  calculated_count     integer NOT NULL DEFAULT 0,
  failed_count         integer NOT NULL DEFAULT 0,
  last_error           text,
  started_at           timestamptz,
  completed_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payroll_run_id, calculation_sequence, partition_no)
);
CREATE INDEX IF NOT EXISTS payroll_run_partitions_run_idx ON payroll_run_partitions (payroll_run_id, calculation_sequence, state);

CREATE TABLE IF NOT EXISTS payroll_exceptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_run_id       uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  payroll_partition_id uuid REFERENCES payroll_run_partitions(id) ON DELETE SET NULL,
  employee_id          uuid REFERENCES employees(id) ON DELETE CASCADE,
  calculation_sequence integer NOT NULL,
  exception_class      text NOT NULL DEFAULT 'calculation'
                         CHECK (exception_class IN ('calculation', 'data', 'duplicate_payment', 'rule_change', 'system')),
  severity             text NOT NULL DEFAULT 'error' CHECK (severity IN ('error', 'warning')),
  message              text NOT NULL,
  detail               jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- open: needs attention; resolved: retried successfully / fixed; waived: employee knowingly left out of this run;
  -- superseded: a later full calculation replaced the run's results
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'waived', 'superseded')),
  retry_count          integer NOT NULL DEFAULT 0,
  last_retry_at        timestamptz,
  resolution           text,
  resolution_note      text,
  resolved_by          uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  resolved_at          timestamptz,
  correlation_id       uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payroll_exceptions_run_idx ON payroll_exceptions (payroll_run_id, status);
CREATE INDEX IF NOT EXISTS payroll_exceptions_employee_idx ON payroll_exceptions (employee_id);
-- one live exception per employee per calculation: a repeat of the same failure updates it instead of piling up rows
CREATE UNIQUE INDEX IF NOT EXISTS payroll_exceptions_open_uq
  ON payroll_exceptions (payroll_run_id, employee_id, calculation_sequence) WHERE status = 'open' AND employee_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_run_partitions', 'payroll_exceptions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())', t || '_all', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_role', t);
  END LOOP;
END $$;
