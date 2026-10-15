-- Gap Register Step 9A: PAY-01 (run state machine), PAY-02 (pinned inputs, totals, idempotency,
-- duplicate-run rule), PAY-19 (reversal / reopen / cancel entities), PAY-23 (manual overrides).
--
-- WHAT EXISTED: payroll_runs.status was draft | calculated | pending_approval | approved | finalized |
-- reversed, changed by plain UPDATEs from several code paths; a run recorded neither the rule versions it
-- was calculated with nor its totals; a reversal was three columns on the run; manual overrides did not exist.
-- [VERIFY PAY-02] the duplicate-run rule already exists as the partial unique index
-- payroll_runs_active_period_key (company, period, area) for REGULAR runs (0094/0101/0113); off-cycle runs are
-- deliberately outside it. It is kept, and widened here so cancelled runs and simulations never block a period.
--
-- ROLLBACK (additive only): DROP TABLE payroll_overrides, payroll_run_reopens, payroll_reversals,
-- payroll_run_events, payroll_rule_snapshots; DROP TRIGGER payroll_runs_status_guard ON payroll_runs;
-- DROP FUNCTION app.payroll_run_transition_allowed(text, text); drop the columns added to payroll_runs;
-- restore payroll_runs_status_check to the six original values and recreate the two unique indexes with
-- "status <> 'reversed'" only; DELETE the three permissions added below.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- ---------------------------------------------------------------- PAY-01: states
ALTER TABLE payroll_runs DROP CONSTRAINT IF EXISTS payroll_runs_status_check;
ALTER TABLE payroll_runs ADD CONSTRAINT payroll_runs_status_check CHECK (status IN (
  'draft', 'pre_validated', 'calculating', 'calculated', 'validated', 'pending_approval', 'approved',
  'finalized', 'accounting', 'payment_released', 'reconciled', 'closed', 'reopened', 'reversed', 'cancelled'
));

-- One definition of the legal moves, enforced by a trigger so no code path (or manual SQL) can skip a step.
-- The application keeps an identical copy for friendly error messages; a spec compares the two.
CREATE OR REPLACE FUNCTION app.payroll_run_transition_allowed(from_status text, to_status text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT from_status = to_status OR (from_status, to_status) IN (VALUES
    ('draft', 'pre_validated'), ('draft', 'calculating'), ('draft', 'calculated'), ('draft', 'cancelled'),
    ('pre_validated', 'draft'), ('pre_validated', 'calculating'), ('pre_validated', 'calculated'), ('pre_validated', 'cancelled'),
    ('calculating', 'calculated'), ('calculating', 'draft'), ('calculating', 'cancelled'),
    ('calculated', 'calculating'), ('calculated', 'validated'), ('calculated', 'pending_approval'), ('calculated', 'cancelled'),
    ('validated', 'calculating'), ('validated', 'calculated'), ('validated', 'pending_approval'), ('validated', 'cancelled'),
    ('pending_approval', 'approved'), ('pending_approval', 'calculated'),
    ('approved', 'finalized'), ('approved', 'calculated'), ('approved', 'cancelled'),
    ('finalized', 'accounting'), ('finalized', 'payment_released'), ('finalized', 'reconciled'), ('finalized', 'closed'), ('finalized', 'reversed'),
    ('accounting', 'payment_released'), ('accounting', 'reconciled'), ('accounting', 'closed'), ('accounting', 'reversed'),
    ('payment_released', 'accounting'), ('payment_released', 'reconciled'), ('payment_released', 'closed'), ('payment_released', 'reversed'),
    ('reconciled', 'closed'), ('reconciled', 'reversed'),
    ('closed', 'reopened'),
    ('reopened', 'accounting'), ('reopened', 'payment_released'), ('reopened', 'reconciled'), ('reopened', 'closed'), ('reopened', 'reversed')
  )
$$;

CREATE OR REPLACE FUNCTION app.payroll_runs_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT app.payroll_run_transition_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'Payroll run cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS payroll_runs_status_guard ON payroll_runs;
CREATE TRIGGER payroll_runs_status_guard BEFORE UPDATE OF status ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION app.payroll_runs_status_guard();

-- ---------------------------------------------------------------- PAY-02: pinned inputs, totals, counters
ALTER TABLE payroll_runs
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS correlation_id uuid,
  ADD COLUMN IF NOT EXISTS is_simulation boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS currency_code text NOT NULL DEFAULT 'PKR',
  ADD COLUMN IF NOT EXISTS rounding_precision smallint NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS rule_snapshot_id uuid,
  ADD COLUMN IF NOT EXISTS calculation_sequence integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS calculated_at timestamptz,
  ADD COLUMN IF NOT EXISTS total_gross numeric(16,2),
  ADD COLUMN IF NOT EXISTS total_net numeric(16,2),
  ADD COLUMN IF NOT EXISTS total_income_tax numeric(16,2),
  ADD COLUMN IF NOT EXISTS total_employee_deductions numeric(16,2),
  ADD COLUMN IF NOT EXISTS total_employer_contributions numeric(16,2),
  ADD COLUMN IF NOT EXISTS total_employer_cost numeric(16,2),
  ADD COLUMN IF NOT EXISTS population_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS calculated_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS warning_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by_user_account_id uuid REFERENCES user_accounts(id),
  ADD COLUMN IF NOT EXISTS cancel_reason text,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_by_user_account_id uuid REFERENCES user_accounts(id);

ALTER TABLE payroll_runs DROP CONSTRAINT IF EXISTS payroll_runs_currency_check;
ALTER TABLE payroll_runs ADD CONSTRAINT payroll_runs_currency_check CHECK (currency_code ~ '^[A-Z]{3}$');
ALTER TABLE payroll_runs DROP CONSTRAINT IF EXISTS payroll_runs_precision_check;
ALTER TABLE payroll_runs ADD CONSTRAINT payroll_runs_precision_check CHECK (rounding_precision BETWEEN 0 AND 4);
ALTER TABLE payroll_runs DROP CONSTRAINT IF EXISTS payroll_runs_simulation_status_check;
ALTER TABLE payroll_runs ADD CONSTRAINT payroll_runs_simulation_status_check
  CHECK (NOT is_simulation OR status IN ('draft', 'pre_validated', 'calculating', 'calculated', 'validated', 'cancelled'));

CREATE UNIQUE INDEX IF NOT EXISTS payroll_runs_idempotency_key
  ON payroll_runs (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

DROP INDEX IF EXISTS payroll_runs_active_period_key;
CREATE UNIQUE INDEX payroll_runs_active_period_key
  ON payroll_runs (company_id, period_start, period_end, COALESCE(payroll_area_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status NOT IN ('reversed', 'cancelled') AND run_type = 'regular' AND is_simulation = false;
DROP INDEX IF EXISTS payroll_runs_one_final_settlement_per_employee;
CREATE UNIQUE INDEX payroll_runs_one_final_settlement_per_employee
  ON payroll_runs (target_employee_id)
  WHERE off_cycle_reason = 'final_settlement' AND status NOT IN ('reversed', 'cancelled') AND is_simulation = false;

-- The frozen copy of everything a calculation read besides the employee rows themselves.
CREATE TABLE IF NOT EXISTS payroll_rule_snapshots (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_run_id        uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  calculation_sequence  integer NOT NULL,
  as_of_date            date NOT NULL,
  engine_version        text NOT NULL,
  settings_row_id       uuid,
  tax_slab_ids          uuid[] NOT NULL DEFAULT '{}',
  formula_ids           uuid[] NOT NULL DEFAULT '{}',
  settings              jsonb NOT NULL,
  tax_slabs             jsonb NOT NULL,
  formulas              jsonb NOT NULL,
  content_hash          text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payroll_run_id, calculation_sequence)
);
CREATE INDEX IF NOT EXISTS idx_payroll_rule_snapshots_company ON payroll_rule_snapshots (company_id);
ALTER TABLE payroll_runs DROP CONSTRAINT IF EXISTS payroll_runs_rule_snapshot_fk;
ALTER TABLE payroll_runs ADD CONSTRAINT payroll_runs_rule_snapshot_fk
  FOREIGN KEY (rule_snapshot_id) REFERENCES payroll_rule_snapshots(id) ON DELETE SET NULL;

-- Backfill totals/counters for runs that already have payslips (unambiguous: plain sums of their own rows).
UPDATE payroll_runs r SET
  total_gross = s.gross, total_net = s.net, total_income_tax = s.tax,
  total_employee_deductions = s.gross - s.net - s.tax,
  total_employer_contributions = s.employer, total_employer_cost = s.gross + s.employer,
  population_count = s.n, calculated_count = s.n,
  calculation_sequence = 1, calculated_at = COALESCE(r.finalized_at, r.updated_at)
FROM (
  SELECT payroll_run_id, count(*)::int AS n, sum(gross_pay) AS gross, sum(net_pay) AS net, sum(income_tax_monthly) AS tax,
         sum(eobi_employer_contribution + social_security_employer_contribution) AS employer
    FROM payslips GROUP BY payroll_run_id
) s
WHERE s.payroll_run_id = r.id AND r.calculation_sequence = 0;

-- ---------------------------------------------------------------- PAY-01: audited transitions
CREATE TABLE IF NOT EXISTS payroll_run_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_run_id        uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  from_status           text,
  to_status             text NOT NULL,
  action                text NOT NULL,
  actor_user_account_id uuid,
  reason                text,
  correlation_id        uuid,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payroll_run_events_run ON payroll_run_events (payroll_run_id, created_at);

-- Append-only. Direct UPDATE / DELETE is refused; deleting a run or company still cascades.
CREATE OR REPLACE FUNCTION app.payroll_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS payroll_run_events_append_only ON payroll_run_events;
CREATE TRIGGER payroll_run_events_append_only BEFORE UPDATE OR DELETE ON payroll_run_events
  FOR EACH ROW EXECUTE FUNCTION app.payroll_append_only_guard();

INSERT INTO payroll_run_events (company_id, payroll_run_id, from_status, to_status, action, actor_user_account_id, reason, metadata, created_at)
SELECT r.company_id, r.id, NULL, r.status, 'backfill', r.created_by_user_account_id, NULL,
       jsonb_build_object('note', 'state at migration 0142'), COALESCE(r.finalized_at, r.updated_at)
  FROM payroll_runs r
 WHERE NOT EXISTS (SELECT 1 FROM payroll_run_events e WHERE e.payroll_run_id = r.id);

-- ---------------------------------------------------------------- PAY-19: reversal / reopen
CREATE TABLE IF NOT EXISTS payroll_reversals (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_run_id          uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  corrective_run_id       uuid REFERENCES payroll_runs(id) ON DELETE SET NULL,
  reason                  text NOT NULL,
  requested_by            uuid REFERENCES user_accounts(id),
  authorized_by           uuid REFERENCES user_accounts(id),
  authorization_permission text NOT NULL DEFAULT 'payroll.finalize.all+payroll.disburse.all',
  impact                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id          uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payroll_run_id)
);
CREATE INDEX IF NOT EXISTS idx_payroll_reversals_company ON payroll_reversals (company_id);

INSERT INTO payroll_reversals (company_id, payroll_run_id, corrective_run_id, reason, requested_by, authorized_by, impact, created_at)
SELECT r.company_id, r.id, r.corrective_run_id, COALESCE(r.reversal_reason, '(not recorded)'), r.reversed_by_user_account_id,
       r.reversed_by_user_account_id, jsonb_build_object('backfilled', true), COALESCE(r.reversed_at, r.updated_at)
  FROM payroll_runs r
 WHERE r.status = 'reversed'
ON CONFLICT (payroll_run_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS payroll_run_reopens (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_run_id           uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  from_status              text NOT NULL,
  reason                   text NOT NULL,
  requested_by             uuid REFERENCES user_accounts(id),
  authorized_by            uuid REFERENCES user_accounts(id),
  authorization_permission text NOT NULL DEFAULT 'payroll.reopen.all',
  correlation_id           uuid,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payroll_run_reopens_run ON payroll_run_reopens (payroll_run_id, created_at);

-- ---------------------------------------------------------------- PAY-23: manual overrides
CREATE TABLE IF NOT EXISTS payroll_overrides (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_run_id      uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  payslip_id          uuid REFERENCES payslips(id) ON DELETE SET NULL,
  employee_id         uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  field               text NOT NULL,
  old_value           jsonb,
  new_value           jsonb NOT NULL,
  reason              text NOT NULL CHECK (length(btrim(reason)) >= 5),
  status              text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'withdrawn')),
  overridden_by       uuid NOT NULL REFERENCES user_accounts(id),
  approved_by         uuid REFERENCES user_accounts(id),
  approved_at         timestamptz,
  reapplied_count     integer NOT NULL DEFAULT 0,
  correlation_id      uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  withdrawn_at        timestamptz
);
CREATE INDEX IF NOT EXISTS idx_payroll_overrides_run ON payroll_overrides (payroll_run_id, employee_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS payroll_overrides_one_active_per_field
  ON payroll_overrides (payroll_run_id, employee_id, field) WHERE status = 'applied';

-- ---------------------------------------------------------------- permissions
INSERT INTO permissions (key, description) VALUES
  ('payroll.override.all', 'Override a calculated payroll value for one employee in an open run, with a recorded reason'),
  ('payroll.reopen.all', 'Reopen a closed payroll run (highly restricted, always audited)'),
  ('payroll.cancel.all', 'Cancel a payroll run that has not been finalised')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.key = 'hr_admin' AND p.key IN ('payroll.override.all', 'payroll.reopen.all', 'payroll.cancel.all')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- RLS + grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_rule_snapshots', 'payroll_run_events', 'payroll_reversals', 'payroll_run_reopens', 'payroll_overrides'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())', t || '_all', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_role', t);
  END LOOP;
END $$;
