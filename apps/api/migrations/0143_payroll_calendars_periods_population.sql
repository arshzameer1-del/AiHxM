SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- 0143 - Step 9B: payroll calendars and periods, area attributes, run population
--        (gap register PAY-03, PAY-04).
--
-- ROLLBACK (additive; nothing here is read by an older build):
--   ALTER TABLE payroll_runs DROP COLUMN IF EXISTS payroll_period_id;
--   ALTER TABLE payroll_areas DROP COLUMN IF EXISTS frequency, DROP COLUMN IF EXISTS currency_code,
--     DROP COLUMN IF EXISTS calendar_id, DROP COLUMN IF EXISTS jurisdiction;
--   DROP TABLE IF EXISTS payroll_run_population, payroll_periods, payroll_calendars;
--   DELETE FROM permissions WHERE key = 'payroll_calendar.manage.all';

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------- calendars
-- A calendar says how often a group of employees is paid and how a period's
-- pay date and cut-off are derived from its end. It holds no statutory figure.
CREATE TABLE IF NOT EXISTS payroll_calendars (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code               text NOT NULL CHECK (length(btrim(code)) > 0),
  name               text NOT NULL CHECK (length(btrim(name)) > 0),
  frequency          text NOT NULL DEFAULT 'monthly'
                       CHECK (frequency IN ('monthly', 'semi_monthly', 'bi_weekly', 'weekly')),
  currency_code      text NOT NULL DEFAULT 'PKR' CHECK (currency_code ~ '^[A-Z]{3}$'),
  -- pay date = period end + this many days (negative = paid before the period ends)
  pay_day_offset     integer NOT NULL DEFAULT 0 CHECK (pay_day_offset BETWEEN -31 AND 62),
  -- inputs are expected by period end - this many days
  cutoff_days_before_end integer NOT NULL DEFAULT 0 CHECK (cutoff_days_before_end BETWEEN 0 AND 31),
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (company_id, id)
);
CREATE INDEX IF NOT EXISTS idx_payroll_calendars_company ON payroll_calendars (company_id);

-- ---------------------------------------------------------------- periods
CREATE TABLE IF NOT EXISTS payroll_periods (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  calendar_id   uuid NOT NULL,
  label         text NOT NULL,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  pay_date      date NOT NULL,
  cutoff_date   date NOT NULL,
  -- open: any run; locked: off-cycle and corrective runs only; closed: nothing further
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked', 'closed')),
  locked_at     timestamptz,
  locked_by     uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  closed_at     timestamptz,
  closed_by     uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  CHECK (cutoff_date <= pay_date OR cutoff_date <= period_end),
  FOREIGN KEY (company_id, calendar_id) REFERENCES payroll_calendars (company_id, id) ON DELETE CASCADE,
  UNIQUE (calendar_id, period_start),
  -- periods of one calendar can never overlap (PAY-03: "periods can overlap" was the defect)
  EXCLUDE USING gist (calendar_id WITH =, daterange(period_start, period_end, '[]') WITH &&)
);
CREATE INDEX IF NOT EXISTS idx_payroll_periods_company_dates ON payroll_periods (company_id, period_start, period_end);

-- ---------------------------------------------------------------- area attributes
ALTER TABLE payroll_areas
  ADD COLUMN IF NOT EXISTS frequency     text NOT NULL DEFAULT 'monthly'
    CHECK (frequency IN ('monthly', 'semi_monthly', 'bi_weekly', 'weekly')),
  ADD COLUMN IF NOT EXISTS currency_code text NOT NULL DEFAULT 'PKR' CHECK (currency_code ~ '^[A-Z]{3}$'),
  ADD COLUMN IF NOT EXISTS calendar_id   uuid,
  -- a label (country / province / scheme region) the statutory tables of PAY-08/PAY-09 key on; no figures here
  ADD COLUMN IF NOT EXISTS jurisdiction  text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_areas_calendar_fk') THEN
    ALTER TABLE payroll_areas
      ADD CONSTRAINT payroll_areas_calendar_fk FOREIGN KEY (company_id, calendar_id)
      REFERENCES payroll_calendars (company_id, id) ON DELETE SET NULL (calendar_id);
  END IF;
END $$;

-- ---------------------------------------------------------------- runs -> period
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS payroll_period_id uuid REFERENCES payroll_periods(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_payroll_runs_period ON payroll_runs (payroll_period_id) WHERE payroll_period_id IS NOT NULL;

-- ---------------------------------------------------------------- run population
-- Who a calculation covered and why, written at calculation time, one set per
-- calculation, so a past run can be reproduced and explained after the
-- employee master has moved on.
CREATE TABLE IF NOT EXISTS payroll_run_population (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_run_id        uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id           uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  calculation_sequence  integer NOT NULL DEFAULT 1,
  inclusion_reason      text NOT NULL
                          CHECK (inclusion_reason IN ('area_member', 'company_wide', 'target_employee', 'final_settlement')),
  status                text NOT NULL DEFAULT 'included'
                          CHECK (status IN ('included', 'calculated', 'failed', 'excluded')),
  exclusion_reason      text,
  snapshot              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payroll_run_id, employee_id, calculation_sequence)
);
CREATE INDEX IF NOT EXISTS idx_payroll_run_population_run ON payroll_run_population (payroll_run_id, calculation_sequence);
CREATE INDEX IF NOT EXISTS idx_payroll_run_population_employee ON payroll_run_population (employee_id);

-- ---------------------------------------------------------------- permission
INSERT INTO permissions (key, description) VALUES
  ('payroll_calendar.manage.all', 'Create payroll calendars, generate and lock/close payroll periods, set payroll area frequency, currency, calendar and jurisdiction')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.key = 'hr_admin' AND p.key = 'payroll_calendar.manage.all'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- RLS + grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_calendars', 'payroll_periods', 'payroll_run_population'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())', t || '_all', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_role', t);
  END LOOP;
END $$;
