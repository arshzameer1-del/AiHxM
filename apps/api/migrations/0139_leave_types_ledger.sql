-- Gap Register TLM-01, TLM-02, TLM-03 (Step 8A). ADDITIVE: the old fixed columns stay.
--
--  TLM-01  leave_types (per-tenant catalogue: paid, accrual method, carry-forward,
--          encashable, document required, gender / service restriction, half-day)
--          and leave_policy_entitlements (policy VERSION x leave type -> days, accrual,
--          carry cap, expiry). The three fixed leave_policy_versions columns are kept and
--          kept in step by the service; entitlements are backfilled from them. The CHECK
--          lists on leave_balances.leave_type / leave_requests.leave_type are replaced by a
--          code-format check (validity is now "an active leave_types row").
--          Seeded per existing tenant: annual, casual, sick, unpaid (active) and
--          maternity, paternity, hajj, bereavement, compensatory, short_leave (INACTIVE,
--          no entitlement figures - statutory day counts are tenant / statutory data, not
--          seeded from memory).
--  TLM-02  leave_ledger: append-only record of every opening / accrual / deduction /
--          reversal / carry-forward / adjustment / encashment / expiry with its source.
--          leave_balances becomes a DERIVED summary (new component columns); existing rows
--          are backfilled into the ledger (source_type 'legacy_backfill'). source_key makes
--          the accrual job idempotent.
--  TLM-03  leave_requests: day_part (half-day session), attachment_document_id,
--          rejection_reason, return_date, delegate_employee_id, cancellation request
--          columns, payroll_impact; overlap exclusion constraint for full-day requests
--          (created only when existing data has no overlaps - the service check always applies).
--
-- ROLLBACK: DROP TABLE leave_ledger, leave_policy_entitlements, leave_types;
--   ALTER TABLE leave_balances DROP the added component columns and restore
--   leave_balances_leave_type_check; ALTER TABLE leave_requests DROP the added columns,
--   DROP CONSTRAINT leave_requests_no_full_day_overlap, restore leave_requests_leave_type_check;
--   DROP FUNCTION app.leave_ledger_append_only(), app.seed_leave_types(uuid).

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ------------------------------------------------------------ TLM-01 leave_types
CREATE TABLE IF NOT EXISTS leave_types (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code                         text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name                         text NOT NULL,
  description                  text,
  is_paid                      boolean NOT NULL DEFAULT true,
  -- false = no entitlement / balance (e.g. unpaid): always requestable, never decremented
  tracks_balance               boolean NOT NULL DEFAULT true,
  accrual_method               text NOT NULL DEFAULT 'upfront' CHECK (accrual_method IN ('upfront', 'monthly', 'none')),
  carry_forward_allowed        boolean NOT NULL DEFAULT false,
  carry_forward_cap_days       numeric(6,2) CHECK (carry_forward_cap_days IS NULL OR carry_forward_cap_days >= 0),
  carry_forward_expiry_months  integer CHECK (carry_forward_expiry_months IS NULL OR carry_forward_expiry_months > 0),
  encashable                   boolean NOT NULL DEFAULT false,
  document_required            boolean NOT NULL DEFAULT false,
  -- the document is required only when the request is LONGER than this many days (0 = always)
  document_required_after_days numeric(5,2) NOT NULL DEFAULT 0 CHECK (document_required_after_days >= 0),
  gender_restriction           text NOT NULL DEFAULT 'any' CHECK (gender_restriction IN ('any', 'male', 'female')),
  min_service_months           integer NOT NULL DEFAULT 0 CHECK (min_service_months >= 0),
  half_day_allowed             boolean NOT NULL DEFAULT true,
  max_consecutive_days         numeric(6,2) CHECK (max_consecutive_days IS NULL OR max_consecutive_days > 0),
  is_system                    boolean NOT NULL DEFAULT false,
  is_active                    boolean NOT NULL DEFAULT true,
  sort_order                   integer NOT NULL DEFAULT 100,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);
CREATE INDEX IF NOT EXISTS idx_leave_types_company ON leave_types (company_id, is_active, sort_order);

GRANT SELECT, INSERT, UPDATE, DELETE ON leave_types TO app_role;
ALTER TABLE leave_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_types FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'leave_types'::regclass AND polname = 'leave_types_all') THEN
    CREATE POLICY leave_types_all ON leave_types FOR ALL
      USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
      WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.seed_leave_types(p_company uuid) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO leave_types (company_id, code, name, is_paid, tracks_balance, accrual_method, carry_forward_allowed,
                           encashable, gender_restriction, half_day_allowed, is_system, is_active, sort_order)
  VALUES
    (p_company, 'annual',       'Annual leave',      true,  true,  'upfront', true,  true,  'any',    true,  true,  true,  10),
    (p_company, 'casual',       'Casual leave',      true,  true,  'upfront', false, false, 'any',    true,  true,  true,  20),
    (p_company, 'sick',         'Sick leave',        true,  true,  'upfront', false, false, 'any',    true,  true,  true,  30),
    (p_company, 'unpaid',       'Unpaid leave',      false, false, 'none',    false, false, 'any',    true,  true,  true,  90),
    (p_company, 'maternity',    'Maternity leave',   true,  true,  'upfront', false, false, 'female', false, false, false, 40),
    (p_company, 'paternity',    'Paternity leave',   true,  true,  'upfront', false, false, 'male',   false, false, false, 50),
    (p_company, 'hajj',         'Hajj leave',        true,  true,  'upfront', false, false, 'any',    false, false, false, 60),
    (p_company, 'bereavement',  'Bereavement leave', true,  true,  'upfront', false, false, 'any',    true,  false, false, 70),
    (p_company, 'compensatory', 'Compensatory off',  true,  true,  'none',    false, false, 'any',    true,  false, false, 80),
    (p_company, 'short_leave',  'Short leave',       true,  true,  'upfront', false, false, 'any',    true,  false, false, 85)
  ON CONFLICT (company_id, code) DO NOTHING;
$$;

SELECT app.seed_leave_types(id) FROM companies;

-- ------------------------------------------------------------ TLM-01 leave_policy_entitlements
CREATE TABLE IF NOT EXISTS leave_policy_entitlements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  policy_version_id   uuid NOT NULL REFERENCES leave_policy_versions(id) ON DELETE CASCADE,
  leave_type          text NOT NULL CHECK (leave_type ~ '^[a-z][a-z0-9_]{1,39}$'),
  days                numeric(6,2) NOT NULL CHECK (days >= 0),
  -- NULL = inherit the leave type's accrual_method
  accrual_method      text CHECK (accrual_method IS NULL OR accrual_method IN ('upfront', 'monthly', 'none')),
  carry_forward_cap_days numeric(6,2) CHECK (carry_forward_cap_days IS NULL OR carry_forward_cap_days >= 0),
  expires_after_months integer CHECK (expires_after_months IS NULL OR expires_after_months > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_version_id, leave_type)
);
CREATE INDEX IF NOT EXISTS idx_leave_policy_entitlements_company ON leave_policy_entitlements (company_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON leave_policy_entitlements TO app_role;
ALTER TABLE leave_policy_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_policy_entitlements FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'leave_policy_entitlements'::regclass AND polname = 'leave_policy_entitlements_all') THEN
    CREATE POLICY leave_policy_entitlements_all ON leave_policy_entitlements FOR ALL
      USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
      WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
  END IF;
END $$;

-- Backfill from the three fixed columns of every existing version.
INSERT INTO leave_policy_entitlements (company_id, policy_version_id, leave_type, days)
SELECT v.company_id, v.id, t.leave_type, t.days
  FROM leave_policy_versions v
  CROSS JOIN LATERAL (VALUES ('annual', v.annual_leave_days), ('casual', v.casual_leave_days), ('sick', v.sick_leave_days)) AS t(leave_type, days)
ON CONFLICT (policy_version_id, leave_type) DO NOTHING;

-- ------------------------------------------------------------ TLM-02 leave_ledger
CREATE TABLE IF NOT EXISTS leave_ledger (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id        uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type         text NOT NULL CHECK (leave_type ~ '^[a-z][a-z0-9_]{1,39}$'),
  year               integer NOT NULL,
  entry_type         text NOT NULL CHECK (entry_type IN ('opening', 'accrual', 'deduction', 'reversal', 'carry_forward', 'adjustment', 'encashment', 'expiry')),
  -- signed: grants / reversals positive, deductions / encashments / expiries negative
  days               numeric(7,2) NOT NULL,
  effective_date     date NOT NULL DEFAULT CURRENT_DATE,
  expires_on         date,
  source_type        text NOT NULL,
  source_id          uuid,
  -- idempotency token for jobs (e.g. '2026-10' for the October accrual)
  source_key         text,
  reverses_entry_id  uuid REFERENCES leave_ledger(id),
  reason             text,
  created_by_user_account_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leave_ledger_sign_ck CHECK (
    (entry_type IN ('opening', 'accrual', 'carry_forward', 'reversal') AND days >= 0)
    OR (entry_type IN ('deduction', 'encashment', 'expiry') AND days <= 0)
    OR entry_type = 'adjustment'
  )
);
CREATE INDEX IF NOT EXISTS idx_leave_ledger_balance ON leave_ledger (employee_id, leave_type, year);
CREATE INDEX IF NOT EXISTS idx_leave_ledger_source ON leave_ledger (source_type, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_leave_ledger_idempotent
  ON leave_ledger (employee_id, leave_type, year, entry_type, source_type, source_key) WHERE source_key IS NOT NULL;
-- A deduction can be reversed at most once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_leave_ledger_one_reversal ON leave_ledger (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app.leave_ledger_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Allow the cascade from deleting the owning company / employee; block direct edits.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'leave_ledger is append-only: % is not permitted', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
DROP TRIGGER IF EXISTS leave_ledger_append_only ON leave_ledger;
CREATE TRIGGER leave_ledger_append_only BEFORE UPDATE OR DELETE ON leave_ledger
  FOR EACH ROW EXECUTE FUNCTION app.leave_ledger_append_only();

GRANT SELECT, INSERT ON leave_ledger TO app_role;
ALTER TABLE leave_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_ledger FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'leave_ledger'::regclass AND polname = 'leave_ledger_all') THEN
    CREATE POLICY leave_ledger_all ON leave_ledger FOR ALL
      USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
      WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
  END IF;
END $$;

-- leave_balances is now a derived summary of the ledger.
ALTER TABLE leave_balances DROP CONSTRAINT IF EXISTS leave_balances_leave_type_check;
ALTER TABLE leave_balances DROP CONSTRAINT IF EXISTS leave_balances_leave_type_format_ck;
ALTER TABLE leave_balances ADD CONSTRAINT leave_balances_leave_type_format_ck CHECK (leave_type ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE leave_balances ALTER COLUMN entitled_days TYPE numeric(7,2);
ALTER TABLE leave_balances ALTER COLUMN used_days TYPE numeric(7,2);
ALTER TABLE leave_balances
  ADD COLUMN IF NOT EXISTS opening_days         numeric(7,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS accrued_days         numeric(7,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS carried_forward_days numeric(7,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS adjusted_days        numeric(7,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS encashed_days        numeric(7,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expired_days         numeric(7,2) NOT NULL DEFAULT 0;

-- Backfill: every existing balance becomes ledger history (idempotent through source_key).
INSERT INTO leave_ledger (company_id, employee_id, leave_type, year, entry_type, days, effective_date, source_type, source_key, reason)
SELECT b.company_id, b.employee_id, b.leave_type, b.year, 'opening', b.entitled_days, make_date(b.year, 1, 1),
       'legacy_backfill', 'balance:' || b.id::text, 'Opening balance carried from leave_balances.entitled_days'
  FROM leave_balances b WHERE b.entitled_days > 0
ON CONFLICT DO NOTHING;
INSERT INTO leave_ledger (company_id, employee_id, leave_type, year, entry_type, days, effective_date, source_type, source_key, reason)
SELECT b.company_id, b.employee_id, b.leave_type, b.year, 'deduction', -b.used_days, make_date(b.year, 1, 1),
       'legacy_backfill', 'used:' || b.id::text, 'Used days carried from leave_balances.used_days'
  FROM leave_balances b WHERE b.used_days > 0
ON CONFLICT DO NOTHING;
UPDATE leave_balances SET opening_days = entitled_days WHERE opening_days = 0 AND accrued_days = 0 AND entitled_days > 0;

-- ------------------------------------------------------------ TLM-03 leave_requests
ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS leave_requests_leave_type_check;
ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS leave_requests_leave_type_format_ck;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_leave_type_format_ck CHECK (leave_type ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS day_part                    text NOT NULL DEFAULT 'full',
  ADD COLUMN IF NOT EXISTS attachment_document_id      uuid REFERENCES employee_documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason            text,
  ADD COLUMN IF NOT EXISTS return_date                 date,
  ADD COLUMN IF NOT EXISTS delegate_employee_id        uuid REFERENCES employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancellation_status         text,
  ADD COLUMN IF NOT EXISTS cancellation_reason         text,
  ADD COLUMN IF NOT EXISTS cancellation_requested_at   timestamptz,
  ADD COLUMN IF NOT EXISTS cancellation_requested_by   uuid REFERENCES user_accounts(id),
  ADD COLUMN IF NOT EXISTS payroll_impact              boolean NOT NULL DEFAULT false;
ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS leave_requests_day_part_ck;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_day_part_ck
  CHECK (day_part IN ('full', 'first_half', 'second_half') AND (day_part = 'full' OR start_date = end_date));
ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS leave_requests_cancellation_status_ck;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_cancellation_status_ck
  CHECK (cancellation_status IS NULL OR cancellation_status IN ('requested', 'approved', 'declined'));
UPDATE leave_requests SET payroll_impact = true WHERE leave_type = 'unpaid' AND payroll_impact = false;
UPDATE leave_requests SET return_date = end_date + 1 WHERE return_date IS NULL;
CREATE INDEX IF NOT EXISTS idx_leave_requests_cancellation ON leave_requests (company_id) WHERE cancellation_status = 'requested';

-- Overlap protection for full-day requests (pending / approved). Half-day requests are
-- checked by the service (two opposite halves of one day may coexist).
DO $$
DECLARE overlap_pairs integer;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leave_requests_no_full_day_overlap') THEN
    RETURN;
  END IF;
  SELECT count(*) INTO overlap_pairs
    FROM leave_requests a JOIN leave_requests b
      ON a.employee_id = b.employee_id AND a.id < b.id
     AND a.status IN ('pending', 'approved') AND b.status IN ('pending', 'approved')
     AND a.day_part = 'full' AND b.day_part = 'full'
     AND daterange(a.start_date, a.end_date, '[]') && daterange(b.start_date, b.end_date, '[]');
  IF overlap_pairs = 0 THEN
    ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_no_full_day_overlap
      EXCLUDE USING gist (employee_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
      WHERE (status IN ('pending', 'approved') AND day_part = 'full');
  ELSE
    RAISE NOTICE 'TLM-03: % overlapping full-day leave request pair(s) exist; exclusion constraint skipped (service check still applies)', overlap_pairs;
  END IF;
END $$;

-- New tenants get the leave type catalogue at creation (the service also calls
-- app.seed_leave_types lazily, so a tenant created before this trigger is covered too).
CREATE OR REPLACE FUNCTION app.companies_seed_leave_types() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.seed_leave_types(NEW.id);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS companies_seed_leave_types ON companies;
CREATE TRIGGER companies_seed_leave_types AFTER INSERT ON companies
  FOR EACH ROW EXECUTE FUNCTION app.companies_seed_leave_types();
