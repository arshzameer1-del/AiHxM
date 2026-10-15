-- 0148 - Step 10A: loan types and repayment schedules, company working-hours defaults, statutory jurisdiction
--        (gap register PAY-13, PAY-24, PAY-28).
--
--  * loan_types              a tenant catalogue of loans / advances with policy limits (instalment as a percent of gross,
--                            principal as a multiple of gross, longest repayment, guarantor). No limit is seeded: a
--                            tenant sets its own policy, null = no limit.
--  * employee_loans          gains type, deduction start date, instalment count, guarantor, approval state and the
--                            early-settlement / hold bookkeeping. Status widens to pending_approval, on_hold, rejected.
--                            Payroll still consumes only status 'active'.
--  * loan_schedules          the approved repayment schedule: one row per instalment with its due date and state
--                            (scheduled, held, skipped, paid, settled, cancelled). Payroll consumes the rows due up to
--                            the period end; a loan with no rows (created before this migration) keeps the old fixed
--                            instalment behaviour until a schedule is generated for it.
--  * employee_loan_repayments  may now record a repayment that did not come through a payslip (cash receipt, adjustment).
--  * company_work_time_defaults  PAY-24: the tenant-wide standard hours belong with working time, not with statutory
--                            payroll settings. Effective-dated; backfilled from payroll_settings, which keeps the old
--                            column (written through) so older readers keep working. An employee's own work profile
--                            still wins over this default.
--  * locations.statutory_jurisdiction  PAY-28: the province / jurisdiction (for provincial social security) is read from
--                            the location tree, falling back to the payroll area's jurisdiction.
--
-- ROLLBACK (additive; nothing here is read by an older build):
--   DROP TABLE IF EXISTS loan_schedules, loan_types, company_work_time_defaults;
--   ALTER TABLE employee_loan_repayments DROP CONSTRAINT IF EXISTS employee_loan_repayments_source_check,
--     DROP CONSTRAINT IF EXISTS employee_loan_repayments_payroll_ref_check, DROP COLUMN IF EXISTS source,
--     DROP COLUMN IF EXISTS reference, DROP COLUMN IF EXISTS received_on, DROP COLUMN IF EXISTS recorded_by_user_account_id;
--     (re-impose NOT NULL on payroll_run_id and payslip_id only after deleting any cash / adjustment rows)
--   ALTER TABLE employee_loans DROP COLUMN IF EXISTS loan_type_id, DROP COLUMN IF EXISTS deduction_start_date,
--     DROP COLUMN IF EXISTS installments_count, DROP COLUMN IF EXISTS guarantor_employee_id, DROP COLUMN IF EXISTS approval_status,
--     DROP COLUMN IF EXISTS approved_by, DROP COLUMN IF EXISTS approved_at, DROP COLUMN IF EXISTS settlement_requested,
--     DROP COLUMN IF EXISTS hold_reason, DROP COLUMN IF EXISTS held_at, DROP COLUMN IF EXISTS closed_reason, DROP COLUMN IF EXISTS closed_at;
--     and restore employee_loans_status_check to ('active', 'closed', 'cancelled').
--   ALTER TABLE locations DROP COLUMN IF EXISTS statutory_jurisdiction;

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- ---------------------------------------------------------------- loan types
CREATE TABLE IF NOT EXISTS loan_types (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code                      text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name                      text NOT NULL CHECK (length(btrim(name)) > 0),
  kind                      text NOT NULL CHECK (kind IN ('loan', 'salary_advance')),
  max_installment_percent   numeric(5,2) CHECK (max_installment_percent IS NULL OR (max_installment_percent > 0 AND max_installment_percent <= 100)),
  max_principal_multiple    numeric(6,2) CHECK (max_principal_multiple IS NULL OR max_principal_multiple > 0),
  max_installments          integer CHECK (max_installments IS NULL OR (max_installments > 0 AND max_installments <= 600)),
  requires_guarantor        boolean NOT NULL DEFAULT false,
  description               text,
  is_active                 boolean NOT NULL DEFAULT true,
  sort_order                integer NOT NULL DEFAULT 0,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

-- ---------------------------------------------------------------- loans
ALTER TABLE employee_loans
  ADD COLUMN IF NOT EXISTS loan_type_id          uuid REFERENCES loan_types(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deduction_start_date  date,
  ADD COLUMN IF NOT EXISTS installments_count    integer CHECK (installments_count IS NULL OR installments_count > 0),
  ADD COLUMN IF NOT EXISTS guarantor_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approval_status       text NOT NULL DEFAULT 'not_required' CHECK (approval_status IN ('not_required', 'pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS approved_by           uuid REFERENCES user_accounts(id),
  ADD COLUMN IF NOT EXISTS approved_at           timestamptz,
  ADD COLUMN IF NOT EXISTS settlement_requested  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hold_reason           text,
  ADD COLUMN IF NOT EXISTS held_at               timestamptz,
  ADD COLUMN IF NOT EXISTS closed_reason         text,
  ADD COLUMN IF NOT EXISTS closed_at             timestamptz;

UPDATE employee_loans SET deduction_start_date = issued_date WHERE deduction_start_date IS NULL;

ALTER TABLE employee_loans DROP CONSTRAINT IF EXISTS employee_loans_status_check;
ALTER TABLE employee_loans ADD CONSTRAINT employee_loans_status_check
  CHECK (status IN ('pending_approval', 'active', 'on_hold', 'closed', 'cancelled', 'rejected'));
ALTER TABLE employee_loans DROP CONSTRAINT IF EXISTS employee_loans_guarantor_not_self;
ALTER TABLE employee_loans ADD CONSTRAINT employee_loans_guarantor_not_self
  CHECK (guarantor_employee_id IS NULL OR guarantor_employee_id <> employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_loans_type ON employee_loans (loan_type_id) WHERE loan_type_id IS NOT NULL;

-- ---------------------------------------------------------------- schedules
CREATE TABLE IF NOT EXISTS loan_schedules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  loan_id          uuid NOT NULL REFERENCES employee_loans(id) ON DELETE CASCADE,
  installment_no   integer NOT NULL CHECK (installment_no > 0),
  due_date         date NOT NULL,
  amount           numeric(12,2) NOT NULL CHECK (amount > 0),
  status           text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'held', 'skipped', 'paid', 'settled', 'cancelled')),
  paid_amount      numeric(12,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  paid_run_id      uuid REFERENCES payroll_runs(id) ON DELETE SET NULL,
  paid_payslip_id  uuid REFERENCES payslips(id) ON DELETE SET NULL,
  paid_at          timestamptz,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, installment_no)
);
CREATE INDEX IF NOT EXISTS idx_loan_schedules_due ON loan_schedules (loan_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_loan_schedules_company ON loan_schedules (company_id);

-- ---------------------------------------------------------------- repayments outside payroll
ALTER TABLE employee_loan_repayments ALTER COLUMN payroll_run_id DROP NOT NULL;
ALTER TABLE employee_loan_repayments ALTER COLUMN payslip_id DROP NOT NULL;
ALTER TABLE employee_loan_repayments
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'payroll',
  ADD COLUMN IF NOT EXISTS reference text,
  ADD COLUMN IF NOT EXISTS received_on date,
  ADD COLUMN IF NOT EXISTS recorded_by_user_account_id uuid REFERENCES user_accounts(id);
ALTER TABLE employee_loan_repayments DROP CONSTRAINT IF EXISTS employee_loan_repayments_source_check;
ALTER TABLE employee_loan_repayments ADD CONSTRAINT employee_loan_repayments_source_check CHECK (source IN ('payroll', 'cash', 'adjustment'));
ALTER TABLE employee_loan_repayments DROP CONSTRAINT IF EXISTS employee_loan_repayments_payroll_ref_check;
ALTER TABLE employee_loan_repayments ADD CONSTRAINT employee_loan_repayments_payroll_ref_check
  CHECK (source <> 'payroll' OR (payroll_run_id IS NOT NULL AND payslip_id IS NOT NULL));

-- ---------------------------------------------------------------- PAY-24 working-time defaults
CREATE TABLE IF NOT EXISTS company_work_time_defaults (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  standard_monthly_hours numeric(6,2) NOT NULL CHECK (standard_monthly_hours > 0 AND standard_monthly_hours <= 744),
  standard_weekly_hours  numeric(5,2) CHECK (standard_weekly_hours IS NULL OR (standard_weekly_hours > 0 AND standard_weekly_hours <= 168)),
  effective_from         date NOT NULL,
  effective_to           date,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT company_work_time_defaults_no_overlap
    EXCLUDE USING gist (company_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_work_time_defaults_one_open ON company_work_time_defaults (company_id) WHERE effective_to IS NULL;

-- every payroll_settings generation becomes a working-time generation with the same dates
INSERT INTO company_work_time_defaults (company_id, standard_monthly_hours, effective_from, effective_to)
SELECT company_id, standard_monthly_hours, effective_from, effective_to FROM payroll_settings
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- PAY-28 jurisdiction
ALTER TABLE locations ADD COLUMN IF NOT EXISTS statutory_jurisdiction text;
ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_statutory_jurisdiction_check;
ALTER TABLE locations ADD CONSTRAINT locations_statutory_jurisdiction_check
  CHECK (statutory_jurisdiction IS NULL OR statutory_jurisdiction ~ '^[a-z][a-z0-9_]{1,39}$');

-- ---------------------------------------------------------------- RLS and grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['loan_types', 'loan_schedules', 'company_work_time_defaults'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())',
      t || '_all', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO app_role', t);
  END LOOP;
END $$;
