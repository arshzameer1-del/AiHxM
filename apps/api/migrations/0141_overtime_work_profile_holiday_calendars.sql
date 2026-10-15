-- Gap Register Step 8C: TLM-07, TLM-08, TLM-10, TLM-11.
--
-- TLM-07  overtime_records gains consumed_payroll_run_id / consumed_at and a 'paid' status, so an
--         approved claim can be paid exactly once (payroll consumes only approved, unconsumed
--         claims and marks them at finalisation; a reversed run releases them). overtime_policies
--         gains applicability (employee group and/or location, as extra effective-dated rows next to
--         the company default), daily / monthly caps, a pre-approval requirement and a comp-off
--         option. overtime_authorizations holds the pre-approvals. payslips remember which claims
--         they consumed.
-- TLM-08  employee_work_profiles: effective-dated planned working time per employee (employment
--         percentage, weekly / monthly hours, part-time flag, time-recording profile).
-- TLM-10  holiday_calendars (+ applicability by location / org unit) and holidays.calendar_id,
--         is_gazetted, date_basis, is_tentative. The old UNIQUE (company_id, holiday_date, name)
--         is replaced by the same rule per calendar so one holiday can sit in two calendars.
-- TLM-11  on_duty_requests.location_id -> locations(id) (the free-text column stays as a note).
--
-- All additive. ROLLBACK (in this order):
--   DROP TABLE overtime_authorizations, employee_work_profiles, holiday_calendar_applicability, holiday_calendars CASCADE;
--   ALTER TABLE on_duty_requests DROP COLUMN location_id;
--   ALTER TABLE payslips DROP COLUMN consumed_overtime;
--   ALTER TABLE holidays DROP COLUMN calendar_id, DROP COLUMN is_gazetted, DROP COLUMN date_basis, DROP COLUMN is_tentative;
--   DROP INDEX holidays_unique_per_calendar; ALTER TABLE holidays ADD UNIQUE (company_id, holiday_date, name);
--   ALTER TABLE overtime_records DROP COLUMN consumed_payroll_run_id, DROP COLUMN consumed_at, DROP COLUMN payout_mode,
--     DROP COLUMN capped_minutes, DROP COLUMN authorization_id, DROP COLUMN comp_off_days, DROP COLUMN policy_id;
--     (set status 'paid' back to 'approved' first and restore the status CHECK / active-per-day index)
--   DELETE FROM overtime_policies WHERE scope_key <> 'company'; then drop the added policy columns and
--     restore idx_overtime_policies_one_open (company_id) and overtime_policies_no_overlap.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- ------------------------------------------------------------------ TLM-07
CREATE TABLE IF NOT EXISTS overtime_authorizations (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                 uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date                   date NOT NULL,
  max_minutes                 int CHECK (max_minutes IS NULL OR max_minutes > 0),
  reason                      text,
  status                      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'revoked')),
  authorized_by_user_account_id uuid NOT NULL REFERENCES user_accounts(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_overtime_authorizations_one_live
  ON overtime_authorizations (employee_id, work_date) WHERE status IN ('active', 'used');
CREATE INDEX IF NOT EXISTS idx_overtime_authorizations_company ON overtime_authorizations (company_id, work_date);

ALTER TABLE overtime_policies
  ADD COLUMN IF NOT EXISTS scope_key text NOT NULL DEFAULT 'company',
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS employee_group_id uuid REFERENCES employee_groups(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS max_daily_minutes int,
  ADD COLUMN IF NOT EXISTS max_monthly_minutes int,
  ADD COLUMN IF NOT EXISTS requires_pre_approval boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS comp_off_allowed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS comp_off_minutes_per_day int NOT NULL DEFAULT 480;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'overtime_policies_caps_check') THEN
    ALTER TABLE overtime_policies ADD CONSTRAINT overtime_policies_caps_check CHECK (
      (max_daily_minutes IS NULL OR max_daily_minutes > 0)
      AND (max_monthly_minutes IS NULL OR max_monthly_minutes > 0)
      AND comp_off_minutes_per_day > 0
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'overtime_policies_scope_check') THEN
    ALTER TABLE overtime_policies ADD CONSTRAINT overtime_policies_scope_check CHECK (
      (scope_key = 'company' AND employee_group_id IS NULL AND location_id IS NULL)
      OR (scope_key <> 'company' AND (employee_group_id IS NOT NULL OR location_id IS NOT NULL))
    );
  END IF;
END $$;

-- one open row (and no overlapping history) per company AND scope
DROP INDEX IF EXISTS idx_overtime_policies_one_open;
CREATE UNIQUE INDEX IF NOT EXISTS idx_overtime_policies_one_open
  ON overtime_policies (company_id, scope_key) WHERE effective_to IS NULL;
ALTER TABLE overtime_policies DROP CONSTRAINT IF EXISTS overtime_policies_no_overlap;
ALTER TABLE overtime_policies ADD CONSTRAINT overtime_policies_no_overlap
  EXCLUDE USING gist (company_id WITH =, scope_key WITH =, daterange(effective_from, effective_to, '[]') WITH &&);

ALTER TABLE overtime_records
  ADD COLUMN IF NOT EXISTS consumed_payroll_run_id uuid REFERENCES payroll_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz,
  ADD COLUMN IF NOT EXISTS payout_mode text NOT NULL DEFAULT 'pay',
  ADD COLUMN IF NOT EXISTS capped_minutes int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS authorization_id uuid REFERENCES overtime_authorizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS comp_off_days numeric(6,2),
  ADD COLUMN IF NOT EXISTS policy_id uuid REFERENCES overtime_policies(id) ON DELETE SET NULL;

ALTER TABLE overtime_records DROP CONSTRAINT IF EXISTS overtime_records_status_check;
ALTER TABLE overtime_records ADD CONSTRAINT overtime_records_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'returned', 'cancelled', 'paid'));
ALTER TABLE overtime_records DROP CONSTRAINT IF EXISTS overtime_records_payout_mode_check;
ALTER TABLE overtime_records ADD CONSTRAINT overtime_records_payout_mode_check CHECK (payout_mode IN ('pay', 'comp_off'));
ALTER TABLE overtime_records DROP CONSTRAINT IF EXISTS overtime_records_paid_has_source_check;
ALTER TABLE overtime_records ADD CONSTRAINT overtime_records_paid_has_source_check
  CHECK (status <> 'paid' OR consumed_payroll_run_id IS NOT NULL OR payout_mode = 'comp_off' OR consumed_at IS NOT NULL);
-- a paid claim still blocks a second claim for the same day
DROP INDEX IF EXISTS idx_overtime_records_one_active_per_day;
CREATE UNIQUE INDEX idx_overtime_records_one_active_per_day
  ON overtime_records (employee_id, work_date) WHERE status IN ('pending', 'approved', 'paid');
CREATE INDEX IF NOT EXISTS idx_overtime_records_consumed_run ON overtime_records (consumed_payroll_run_id) WHERE consumed_payroll_run_id IS NOT NULL;

-- Claims already paid by a finalised, not-reversed regular run must not be paid again.
UPDATE overtime_records o
   SET status = 'paid', consumed_payroll_run_id = pr.id, consumed_at = COALESCE(pr.finalized_at, now()), updated_at = now()
  FROM payslips p
  JOIN payroll_runs pr ON pr.id = p.payroll_run_id
 WHERE o.employee_id = p.employee_id
   AND o.status = 'approved'
   AND pr.status = 'finalized'
   AND pr.run_type = 'regular'
   AND o.work_date BETWEEN pr.period_start AND pr.period_end;

ALTER TABLE payslips ADD COLUMN IF NOT EXISTS consumed_overtime jsonb NOT NULL DEFAULT '[]'::jsonb;

-- ------------------------------------------------------------------ TLM-08
CREATE TABLE IF NOT EXISTS employee_work_profiles (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id            uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  employment_percentage  numeric(5,2) NOT NULL DEFAULT 100 CHECK (employment_percentage > 0 AND employment_percentage <= 100),
  weekly_hours           numeric(5,2) CHECK (weekly_hours IS NULL OR (weekly_hours > 0 AND weekly_hours <= 168)),
  monthly_hours          numeric(6,2) CHECK (monthly_hours IS NULL OR (monthly_hours > 0 AND monthly_hours <= 744)),
  is_part_time           boolean NOT NULL DEFAULT false,
  time_recording_profile text NOT NULL DEFAULT 'clock' CHECK (time_recording_profile IN ('clock', 'timesheet', 'exception_only', 'none')),
  notes                  text,
  effective_from         date NOT NULL,
  effective_to           date,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT employee_work_profiles_no_overlap
    EXCLUDE USING gist (employee_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_work_profiles_one_open ON employee_work_profiles (employee_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_employee_work_profiles_company ON employee_work_profiles (company_id);

-- ------------------------------------------------------------------ TLM-10
CREATE TABLE IF NOT EXISTS holiday_calendars (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS holiday_calendar_applicability (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  calendar_id  uuid NOT NULL REFERENCES holiday_calendars(id) ON DELETE CASCADE,
  location_id  uuid REFERENCES locations(id) ON DELETE CASCADE,
  org_unit_id  uuid REFERENCES org_units(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((location_id IS NOT NULL) <> (org_unit_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_holiday_calendar_applicability_location ON holiday_calendar_applicability (calendar_id, location_id) WHERE location_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_holiday_calendar_applicability_org_unit ON holiday_calendar_applicability (calendar_id, org_unit_id) WHERE org_unit_id IS NOT NULL;

ALTER TABLE holidays
  ADD COLUMN IF NOT EXISTS calendar_id uuid REFERENCES holiday_calendars(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS is_gazetted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS date_basis text NOT NULL DEFAULT 'fixed',
  ADD COLUMN IF NOT EXISTS is_tentative boolean NOT NULL DEFAULT false;
ALTER TABLE holidays DROP CONSTRAINT IF EXISTS holidays_date_basis_check;
ALTER TABLE holidays ADD CONSTRAINT holidays_date_basis_check CHECK (date_basis IN ('fixed', 'lunar'));
ALTER TABLE holidays DROP CONSTRAINT IF EXISTS holidays_company_id_holiday_date_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS holidays_unique_per_calendar
  ON holidays (company_id, COALESCE(calendar_id, '00000000-0000-0000-0000-000000000000'::uuid), holiday_date, name);
CREATE INDEX IF NOT EXISTS idx_holidays_calendar ON holidays (calendar_id) WHERE calendar_id IS NOT NULL;

-- ------------------------------------------------------------------ TLM-11
ALTER TABLE on_duty_requests ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES locations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_on_duty_requests_location ON on_duty_requests (location_id) WHERE location_id IS NOT NULL;
-- link existing free text only where it names exactly one active location of the company
UPDATE on_duty_requests r
   SET location_id = m.id
  FROM (
    SELECT r2.id AS request_id, (array_agg(l.id))[1] AS id
      FROM on_duty_requests r2
      JOIN locations l ON l.company_id = r2.company_id AND l.status = 'active'
                      AND (lower(l.name) = lower(btrim(r2.location)) OR lower(l.code) = lower(btrim(r2.location)))
     WHERE r2.location IS NOT NULL AND r2.location_id IS NULL
     GROUP BY r2.id
    HAVING count(*) = 1
  ) m
 WHERE r.id = m.request_id;

-- ------------------------------------------------------------------ RLS + grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['overtime_authorizations', 'employee_work_profiles', 'holiday_calendars', 'holiday_calendar_applicability'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())', t || '_all', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_role', t);
  END LOOP;
END $$;
