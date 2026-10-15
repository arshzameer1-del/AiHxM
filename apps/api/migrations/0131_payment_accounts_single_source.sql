-- Gap Register EMP-07, EMP-08 (Step 4D).
-- ADDITIVE: employees.bank_account_number is NOT dropped; it becomes a
-- trigger-maintained compatibility projection of the employee's approved
-- primary payment account and the application stops writing it.
--
--  EMP-07  employee_payment_accounts is the only source of bank details.
--          Backfill: every employee that only had the flat column gets a
--          primary bank_transfer account (ciphertext copied as-is; blind
--          indexes are filled by the encryption backfill). A trigger mirrors
--          the approved primary account back into employees.bank_account_number
--          so legacy readers keep working; payroll reads the account first.
--          Deprecation plan: Step 4 report.
--  EMP-08  accounts gain valid_from/valid_to, priority (unique per employee
--          among live accounts), split_percent (live splits may not exceed
--          100), currency, bank_key, bank_country, verification status, and a
--          maker-checker approval workflow: a change to the bank details of
--          an existing primary account is stored as a PENDING replacement
--          that a DIFFERENT user must approve; only approved rows can be
--          primary, so payroll never sees an unapproved account.
--
-- ROLLBACK: DROP TRIGGER trg_payment_account_split / trg_payment_account_mirror
--   and their functions; DROP INDEX idx_payment_accounts_priority; ALTER TABLE
--   employee_payment_accounts DROP the added columns and CHECK constraints
--   (payment_accounts_window, payment_accounts_pending_not_primary,
--   payment_accounts_maker_checker); the backfilled primary accounts can stay
--   (they only copy the flat column) or be removed WHERE created_at >= this
--   migration's run time AND account_number_bidx IS NULL.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE employee_payment_accounts
  ADD COLUMN IF NOT EXISTS valid_from date NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS valid_to date,
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 1 CHECK (priority >= 1),
  ADD COLUMN IF NOT EXISTS split_percent numeric(5,2) CHECK (split_percent IS NULL OR (split_percent > 0 AND split_percent <= 100)),
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'PKR' CHECK (currency ~ '^[A-Z]{3}$'),
  ADD COLUMN IF NOT EXISTS bank_key text,
  ADD COLUMN IF NOT EXISTS bank_country text NOT NULL DEFAULT 'PK' CHECK (bank_country ~ '^[A-Z]{2}$'),
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified', 'verified', 'failed')),
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_by_user_account_id uuid REFERENCES user_accounts(id),
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS submitted_by_user_account_id uuid REFERENCES user_accounts(id),
  ADD COLUMN IF NOT EXISTS approved_by_user_account_id uuid REFERENCES user_accounts(id),
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS replaces_account_id uuid REFERENCES employee_payment_accounts(id) ON DELETE SET NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_accounts_window') THEN
    ALTER TABLE employee_payment_accounts ADD CONSTRAINT payment_accounts_window CHECK (valid_to IS NULL OR valid_to >= valid_from);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_accounts_pending_not_primary') THEN
    ALTER TABLE employee_payment_accounts ADD CONSTRAINT payment_accounts_pending_not_primary CHECK (NOT (is_primary AND approval_status <> 'approved'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_accounts_maker_checker') THEN
    ALTER TABLE employee_payment_accounts ADD CONSTRAINT payment_accounts_maker_checker
      CHECK (approved_by_user_account_id IS NULL OR submitted_by_user_account_id IS NULL OR approved_by_user_account_id <> submitted_by_user_account_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payment_accounts_replaces ON employee_payment_accounts (replaces_account_id) WHERE replaces_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_accounts_pending ON employee_payment_accounts (company_id) WHERE approval_status = 'pending';

-- ------------------------------------------------------------- backfill
-- ended rows keep a closing date
UPDATE employee_payment_accounts SET valid_to = GREATEST(updated_at::date, valid_from) WHERE status = 'ended' AND valid_to IS NULL;

-- flat column -> primary account (only for employees with no account row at all)
INSERT INTO employee_payment_accounts (company_id, employee_id, payment_method, account_number, is_primary, status, valid_from, approval_status)
SELECT e.company_id, e.id, 'bank_transfer', e.bank_account_number, true, 'active', COALESCE(e.date_of_joining, CURRENT_DATE), 'approved'
  FROM employees e
 WHERE e.bank_account_number IS NOT NULL AND btrim(e.bank_account_number) <> ''
   AND NOT EXISTS (SELECT 1 FROM employee_payment_accounts a WHERE a.employee_id = e.id);

-- distinct priorities among live accounts (primary first, then oldest)
UPDATE employee_payment_accounts a SET priority = r.rn
  FROM (SELECT id, row_number() OVER (PARTITION BY employee_id ORDER BY is_primary DESC, created_at, id) AS rn
          FROM employee_payment_accounts WHERE status = 'active') r
 WHERE a.id = r.id AND a.priority <> r.rn;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_accounts_priority
  ON employee_payment_accounts (employee_id, priority) WHERE status = 'active' AND approval_status = 'approved';

-- ------------------------------------------------------------- triggers
CREATE OR REPLACE FUNCTION app.trg_payment_account_split() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total numeric;
BEGIN
  IF NEW.split_percent IS NULL OR NEW.status <> 'active' OR NEW.approval_status <> 'approved' THEN RETURN NEW; END IF;
  SELECT COALESCE(sum(split_percent), 0) INTO total FROM employee_payment_accounts
   WHERE employee_id = NEW.employee_id AND status = 'active' AND approval_status = 'approved'
     AND split_percent IS NOT NULL AND id <> NEW.id;
  IF total + NEW.split_percent > 100 THEN
    RAISE EXCEPTION 'payment account splits for one employee cannot exceed 100%% (already %, adding %)', total, NEW.split_percent
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_payment_account_split ON employee_payment_accounts;
CREATE TRIGGER trg_payment_account_split BEFORE INSERT OR UPDATE ON employee_payment_accounts
  FOR EACH ROW EXECUTE FUNCTION app.trg_payment_account_split();

-- compatibility projection: employees.bank_account_number follows the approved primary account
CREATE OR REPLACE FUNCTION app.trg_payment_account_mirror() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  emp uuid := COALESCE(NEW.employee_id, OLD.employee_id);
  cur text;
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (NEW.is_primary OR OLD.is_primary) THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' AND NOT NEW.is_primary THEN RETURN NULL; END IF;
  SELECT account_number INTO cur FROM employee_payment_accounts
   WHERE employee_id = emp AND is_primary AND status = 'active' AND approval_status = 'approved' LIMIT 1;
  UPDATE employees SET bank_account_number = cur, updated_at = now()
   WHERE id = emp AND bank_account_number IS DISTINCT FROM cur;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_payment_account_mirror ON employee_payment_accounts;
CREATE TRIGGER trg_payment_account_mirror AFTER INSERT OR UPDATE ON employee_payment_accounts
  FOR EACH ROW EXECUTE FUNCTION app.trg_payment_account_mirror();

COMMENT ON COLUMN employees.bank_account_number IS
  'DEPRECATED (EMP-07): read-only projection of the approved primary employee_payment_accounts row, maintained by trg_payment_account_mirror. Do not write; use employee_payment_accounts.';
