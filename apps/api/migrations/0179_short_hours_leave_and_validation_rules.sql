-- BACKLOG58 - Short-hours leave and configurable validation rules.
--
-- Builds on the existing leave catalogue (0139), policies (0012) and ledger instead of adding a second
-- leave engine:
--   * leave_types.duration_mode   how a request of this type is expressed (full day / half day / short hours /
--                                 hourly / flexible partial day)
--   * leave_types.balance_unit    the unit the balance of this type is kept in (days / hours / minutes). The
--                                 ledger column is still called "days" for history's sake; it holds this unit.
--   * leave_duration_settings     the administrator-configured short-hours / timing rules of a leave type,
--                                 optionally overridden for one leave policy
--   * leave_validation_rules      the configurable validation messages and severities (the 20 predefined checks)
--   * leave_rule_history          append-only audit trail with the full snapshot of every change to the two above
--   * leave_requests              start/end time, net duration in minutes, units charged, the rules snapshot used
--
-- Idempotent. Rollback notes: DROP TABLE leave_rule_history, leave_validation_rules, leave_duration_settings;
-- drop the added leave_requests / leave_types columns and the two constraints; the widened numeric types can stay.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ------------------------------------------------------------ leave_types
ALTER TABLE leave_types ADD COLUMN IF NOT EXISTS duration_mode text NOT NULL DEFAULT 'full_day';
ALTER TABLE leave_types ADD COLUMN IF NOT EXISTS balance_unit text NOT NULL DEFAULT 'days';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leave_types_duration_mode_ck') THEN
    ALTER TABLE leave_types ADD CONSTRAINT leave_types_duration_mode_ck
      CHECK (duration_mode IN ('full_day', 'half_day', 'short_hours', 'hourly', 'flexible_partial'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leave_types_balance_unit_ck') THEN
    ALTER TABLE leave_types ADD CONSTRAINT leave_types_balance_unit_ck CHECK (balance_unit IN ('days', 'hours', 'minutes'));
  END IF;
END $$;

-- Existing rows: the mode follows what the type already allowed; the built-in short leave counts in hours.
UPDATE leave_types
   SET duration_mode = CASE WHEN code = 'short_leave' THEN 'short_hours' WHEN half_day_allowed THEN 'half_day' ELSE 'full_day' END,
       balance_unit  = CASE WHEN code = 'short_leave' THEN 'hours' ELSE 'days' END
 WHERE duration_mode = 'full_day' AND balance_unit = 'days';

CREATE OR REPLACE FUNCTION app.seed_leave_types(p_company uuid) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO leave_types (company_id, code, name, is_paid, tracks_balance, accrual_method, carry_forward_allowed,
                           encashable, gender_restriction, half_day_allowed, is_system, is_active, sort_order,
                           duration_mode, balance_unit)
  VALUES
    (p_company, 'annual',       'Annual leave',      true,  true,  'upfront', true,  true,  'any',    true,  true,  true,  10, 'half_day',    'days'),
    (p_company, 'casual',       'Casual leave',      true,  true,  'upfront', false, false, 'any',    true,  true,  true,  20, 'half_day',    'days'),
    (p_company, 'sick',         'Sick leave',        true,  true,  'upfront', false, false, 'any',    true,  true,  true,  30, 'half_day',    'days'),
    (p_company, 'unpaid',       'Unpaid leave',      false, false, 'none',    false, false, 'any',    true,  true,  true,  90, 'half_day',    'days'),
    (p_company, 'maternity',    'Maternity leave',   true,  true,  'upfront', false, false, 'female', false, false, false, 40, 'full_day',    'days'),
    (p_company, 'paternity',    'Paternity leave',   true,  true,  'upfront', false, false, 'male',   false, false, false, 50, 'full_day',    'days'),
    (p_company, 'hajj',         'Hajj leave',        true,  true,  'upfront', false, false, 'any',    false, false, false, 60, 'full_day',    'days'),
    (p_company, 'bereavement',  'Bereavement leave', true,  true,  'upfront', false, false, 'any',    true,  false, false, 70, 'half_day',    'days'),
    (p_company, 'compensatory', 'Compensatory off',  true,  true,  'none',    false, false, 'any',    true,  false, false, 80, 'half_day',    'days'),
    (p_company, 'short_leave',  'Short leave',       true,  true,  'upfront', false, false, 'any',    true,  false, false, 85, 'short_hours', 'hours')
  ON CONFLICT (company_id, code) DO NOTHING;
$$;

-- ------------------------------------------------------------ wider balance figures
-- Hours and minutes need more than two decimals / more digits than days did (a 20-minute request is 0.3333 h).
-- ALTER TYPE does not fire the ledger's append-only trigger (no row is updated by the rewrite).
ALTER TABLE leave_ledger   ALTER COLUMN days TYPE numeric(10,4);
ALTER TABLE leave_balances ALTER COLUMN entitled_days TYPE numeric(10,4);
ALTER TABLE leave_balances ALTER COLUMN used_days TYPE numeric(10,4);
ALTER TABLE leave_balances ALTER COLUMN opening_days TYPE numeric(10,4);
ALTER TABLE leave_balances ALTER COLUMN accrued_days TYPE numeric(10,4);
ALTER TABLE leave_balances ALTER COLUMN carried_forward_days TYPE numeric(10,4);
ALTER TABLE leave_balances ALTER COLUMN adjusted_days TYPE numeric(10,4);
ALTER TABLE leave_balances ALTER COLUMN encashed_days TYPE numeric(10,4);
ALTER TABLE leave_balances ALTER COLUMN expired_days TYPE numeric(10,4);
ALTER TABLE leave_policy_entitlements ALTER COLUMN days TYPE numeric(9,2);

-- ------------------------------------------------------------ leave_requests
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS start_time        time;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS end_time          time;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS start_at          timestamptz;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS end_at            timestamptz;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS time_zone         text;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS duration_minutes  integer;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS break_minutes     integer;
-- What this request charges against the balance, in the leave type's balance_unit (days for every request made before this change).
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS balance_units     numeric(10,4);
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS balance_unit      text;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS policy_id         uuid;
-- The settings, calculation and validation outcome this request was accepted under, so a later policy change never rewrites history.
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS rules_snapshot    jsonb;

UPDATE leave_requests SET balance_units = days_requested, balance_unit = 'days' WHERE balance_units IS NULL;

ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS leave_requests_day_part_ck;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_day_part_ck CHECK (
  day_part IN ('full', 'first_half', 'second_half', 'hours')
  AND (day_part IN ('full', 'hours') OR start_date = end_date)
  AND (day_part <> 'hours' OR (start_at IS NOT NULL AND end_at IS NOT NULL AND end_at > start_at AND duration_minutes > 0 AND end_date <= start_date + 1))
);

-- Two timed requests of one employee can never overlap, whatever happens concurrently.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leave_requests_no_timed_overlap') THEN
    ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_no_timed_overlap
      EXCLUDE USING gist (employee_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&)
      WHERE (status IN ('pending', 'approved') AND day_part = 'hours');
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_leave_requests_timed ON leave_requests (employee_id, start_at) WHERE day_part = 'hours';

-- ------------------------------------------------------------ leave_duration_settings
CREATE TABLE IF NOT EXISTS leave_duration_settings (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  leave_type                text NOT NULL CHECK (leave_type ~ '^[a-z][a-z0-9_]{1,39}$'),
  -- NULL = the setting of the leave type itself; set = the override for that leave policy
  leave_policy_id           uuid REFERENCES leave_policies(id) ON DELETE CASCADE,
  selection_method          text NOT NULL DEFAULT 'employee_selected' CHECK (selection_method IN ('employee_selected', 'fixed_window')),
  earliest_start_time       time,
  latest_end_time           time,
  fixed_start_time          time,
  fixed_end_time            time,
  min_duration_minutes      integer CHECK (min_duration_minutes IS NULL OR min_duration_minutes > 0),
  max_duration_minutes      integer CHECK (max_duration_minutes IS NULL OR max_duration_minutes > 0),
  increment_minutes         integer CHECK (increment_minutes IS NULL OR increment_minutes > 0),
  break_treatment           text NOT NULL DEFAULT 'exclude_all' CHECK (break_treatment IN ('exclude_all', 'exclude_unpaid', 'include')),
  validate_against_schedule boolean NOT NULL DEFAULT true,
  allow_overnight           boolean NOT NULL DEFAULT false,
  same_day_policy           text NOT NULL DEFAULT 'unrestricted' CHECK (same_day_policy IN ('unrestricted', 'same_day_only', 'future_only')),
  min_notice_minutes        integer CHECK (min_notice_minutes IS NULL OR min_notice_minutes >= 0),
  -- how many days in the past a request may start; NULL = no limit, 0 = not backdated
  backdate_days_allowed     integer CHECK (backdate_days_allowed IS NULL OR backdate_days_allowed >= 0),
  daily_limit_minutes       integer CHECK (daily_limit_minutes IS NULL OR daily_limit_minutes > 0),
  monthly_limit_minutes     integer CHECK (monthly_limit_minutes IS NULL OR monthly_limit_minutes > 0),
  frequency_max_requests    integer CHECK (frequency_max_requests IS NULL OR frequency_max_requests > 0),
  frequency_period          text CHECK (frequency_period IS NULL OR frequency_period IN ('day', 'week', 'month', 'year')),
  -- the "approved equivalent" of a day when a time-based request is charged to a balance kept in days; NULL = the employee's scheduled working minutes of that day
  day_equivalent_minutes    integer CHECK (day_equivalent_minutes IS NULL OR day_equivalent_minutes > 0),
  -- approval route for requests of this type; NULL = the standard leave route
  workflow_template_key     text,
  is_active                 boolean NOT NULL DEFAULT true,
  version                   integer NOT NULL DEFAULT 1,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by_user_account_id uuid,
  CHECK (selection_method <> 'fixed_window' OR (fixed_start_time IS NOT NULL AND fixed_end_time IS NOT NULL)),
  CHECK (frequency_max_requests IS NULL OR frequency_period IS NOT NULL),
  CHECK (min_duration_minutes IS NULL OR max_duration_minutes IS NULL OR min_duration_minutes <= max_duration_minutes)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_leave_duration_settings_scope
  ON leave_duration_settings (company_id, leave_type, COALESCE(leave_policy_id, '00000000-0000-0000-0000-000000000000'::uuid));

GRANT SELECT, INSERT, UPDATE, DELETE ON leave_duration_settings TO app_role;
ALTER TABLE leave_duration_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_duration_settings FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'leave_duration_settings'::regclass AND polname = 'leave_duration_settings_all') THEN
    CREATE POLICY leave_duration_settings_all ON leave_duration_settings FOR ALL
      USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
      WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
  END IF;
END $$;

-- ------------------------------------------------------------ leave_validation_rules
CREATE TABLE IF NOT EXISTS leave_validation_rules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code                text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,59}$'),
  name                text NOT NULL,
  description         text,
  validation_type     text NOT NULL CHECK (validation_type IN (
    'balance_insufficient', 'max_duration_exceeded', 'min_duration_not_met', 'invalid_time_range', 'outside_permitted_hours',
    'overlaps_existing_request', 'non_working_day', 'public_holiday_conflict', 'insufficient_notice', 'backdated_not_allowed',
    'attachment_required', 'reason_required', 'leave_type_unavailable', 'policy_not_assigned', 'limit_exceeded',
    'frequency_reached', 'ineligible_employment_category', 'workflow_unresolved', 'balance_unavailable', 'attendance_or_shift_conflict')),
  -- scope: empty array = applies to everything
  leave_types         text[] NOT NULL DEFAULT '{}',
  policy_ids          uuid[] NOT NULL DEFAULT '{}',
  employee_group_ids  uuid[] NOT NULL DEFAULT '{}',
  severity            text NOT NULL DEFAULT 'block' CHECK (severity IN ('block', 'warning', 'info')),
  message             text NOT NULL,
  -- translations of `message` by locale, e.g. {"ur": "..."}
  messages            jsonb NOT NULL DEFAULT '{}'::jsonb,
  admin_explanation   text,
  priority            integer NOT NULL DEFAULT 100,
  effective_from      date,
  effective_to        date,
  is_active           boolean NOT NULL DEFAULT true,
  -- a warning the employee may submit through after confirming it; false makes the warning stop the request
  allow_proceed       boolean NOT NULL DEFAULT true,
  -- optional AND/OR condition tree over the request facts (declarative, never code)
  conditions          jsonb,
  -- type-specific thresholds (e.g. {"minNoticeMinutes": 60}); they override the leave type's settings for this rule
  params              jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_system           boolean NOT NULL DEFAULT false,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by_user_account_id uuid,
  UNIQUE (company_id, code),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS idx_leave_validation_rules_company ON leave_validation_rules (company_id, validation_type, is_active);

GRANT SELECT, INSERT, UPDATE, DELETE ON leave_validation_rules TO app_role;
ALTER TABLE leave_validation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_validation_rules FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'leave_validation_rules'::regclass AND polname = 'leave_validation_rules_all') THEN
    CREATE POLICY leave_validation_rules_all ON leave_validation_rules FOR ALL
      USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
      WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
  END IF;
END $$;

-- ------------------------------------------------------------ leave_rule_history (append-only)
CREATE TABLE IF NOT EXISTS leave_rule_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entity_type   text NOT NULL CHECK (entity_type IN ('rule', 'settings')),
  entity_id     uuid NOT NULL,
  version       integer NOT NULL,
  action        text NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  snapshot      jsonb NOT NULL,
  changed_by_user_account_id uuid,
  changed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leave_rule_history_entity ON leave_rule_history (company_id, entity_type, entity_id, version);

CREATE OR REPLACE FUNCTION app.leave_rule_history_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'leave_rule_history is append-only: % is not permitted', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
DROP TRIGGER IF EXISTS leave_rule_history_append_only ON leave_rule_history;
CREATE TRIGGER leave_rule_history_append_only BEFORE UPDATE OR DELETE ON leave_rule_history
  FOR EACH ROW EXECUTE FUNCTION app.leave_rule_history_append_only();

GRANT SELECT, INSERT ON leave_rule_history TO app_role;
ALTER TABLE leave_rule_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_rule_history FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'leave_rule_history'::regclass AND polname = 'leave_rule_history_all') THEN
    CREATE POLICY leave_rule_history_all ON leave_rule_history FOR ALL
      USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
      WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
  END IF;
END $$;
