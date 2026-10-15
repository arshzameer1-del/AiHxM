-- 0149 - Step 10B: payment items, bank file formats, release / approval / acknowledgement, and reconciliations
--        (gap register PAY-16, PAY-18).
--
--  * bank_file_formats         a tenant's registry of payment-file layouts: delimiter, header, the ordered columns
--                              (from the disbursement field catalogue) and their header labels. No bank's real file
--                              specification is shipped - a tenant (or its bank's onboarding team) defines the layout;
--                              the existing payroll_disbursement_settings column set becomes the default format.
--  * payroll_payment_batches   status widens to generated, approved, released, acknowledged, rejected, reissued, voided;
--                              gains the format used and who approved / released / acknowledged and when.
--  * payroll_payment_items     one row per payslip paid in a batch: the amount, the account as it stood when the file was
--                              made (account and IBAN encrypted, only the last four digits in clear), the bank
--                              reference and rejection reason, retry count and the item that replaced it.
--                              A partial unique index allows only ONE live item (generated, released or acknowledged)
--                              per payslip, so the same salary can never sit in two payment files at once.
--  * payroll_disbursement_settings  gains require_release_approval (a second person approves a batch before release).
--  * payroll_reconciliations   a record of each reconciliation run (calculation, payroll, payment, bank, accounting,
--                              costing, tax, reversal): expected and actual totals, the variance and its detail,
--                              who ran it and, for a variance, who resolved it and why. Re-running adds a new
--                              sequence; the earlier results are kept.
--
-- ROLLBACK (additive; the older build only reads batches with status generated / voided, which are unchanged):
--   DROP TABLE IF EXISTS payroll_reconciliations, payroll_payment_items, bank_file_formats;
--   ALTER TABLE payroll_payment_batches DROP COLUMN IF EXISTS format_id, DROP COLUMN IF EXISTS approved_by_user_account_id,
--     DROP COLUMN IF EXISTS approved_at, DROP COLUMN IF EXISTS released_by_user_account_id, DROP COLUMN IF EXISTS released_at,
--     DROP COLUMN IF EXISTS acknowledged_by_user_account_id, DROP COLUMN IF EXISTS acknowledged_at,
--     DROP COLUMN IF EXISTS bank_reference, DROP COLUMN IF EXISTS rejection_reason, DROP COLUMN IF EXISTS reissued_from_batch_id;
--   UPDATE payroll_payment_batches SET status = 'voided' WHERE status NOT IN ('generated', 'voided');
--   and restore payroll_payment_batches_status_check to ('generated', 'voided').
--   ALTER TABLE payroll_disbursement_settings DROP COLUMN IF EXISTS require_release_approval;

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- ---------------------------------------------------------------- bank file formats
CREATE TABLE IF NOT EXISTS bank_file_formats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code            text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name            text NOT NULL CHECK (length(btrim(name)) > 0),
  delimiter       text NOT NULL DEFAULT 'comma' CHECK (delimiter IN ('comma', 'semicolon', 'pipe', 'tab')),
  include_header  boolean NOT NULL DEFAULT true,
  columns         jsonb NOT NULL CHECK (jsonb_typeof(columns) = 'array' AND jsonb_array_length(columns) > 0),
  header_labels   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(header_labels) = 'object'),
  file_extension  text NOT NULL DEFAULT 'csv' CHECK (file_extension ~ '^[a-z0-9]{2,5}$'),
  is_default      boolean NOT NULL DEFAULT false,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_file_formats_one_default ON bank_file_formats (company_id) WHERE is_default;

ALTER TABLE payroll_disbursement_settings ADD COLUMN IF NOT EXISTS require_release_approval boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------- batches
ALTER TABLE payroll_payment_batches
  ADD COLUMN IF NOT EXISTS format_id                       uuid REFERENCES bank_file_formats(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_by_user_account_id     uuid REFERENCES user_accounts(id),
  ADD COLUMN IF NOT EXISTS approved_at                     timestamptz,
  ADD COLUMN IF NOT EXISTS released_by_user_account_id     uuid REFERENCES user_accounts(id),
  ADD COLUMN IF NOT EXISTS released_at                     timestamptz,
  ADD COLUMN IF NOT EXISTS acknowledged_by_user_account_id uuid REFERENCES user_accounts(id),
  ADD COLUMN IF NOT EXISTS acknowledged_at                 timestamptz,
  ADD COLUMN IF NOT EXISTS bank_reference                  text,
  ADD COLUMN IF NOT EXISTS rejection_reason                text,
  ADD COLUMN IF NOT EXISTS reissued_from_batch_id          uuid REFERENCES payroll_payment_batches(id) ON DELETE SET NULL;

ALTER TABLE payroll_payment_batches DROP CONSTRAINT IF EXISTS payroll_payment_batches_status_check;
ALTER TABLE payroll_payment_batches ADD CONSTRAINT payroll_payment_batches_status_check
  CHECK (status IN ('generated', 'approved', 'released', 'acknowledged', 'rejected', 'reissued', 'voided'));

-- ---------------------------------------------------------------- items
CREATE TABLE IF NOT EXISTS payroll_payment_items (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  batch_id               uuid NOT NULL REFERENCES payroll_payment_batches(id) ON DELETE CASCADE,
  payroll_run_id         uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  payslip_id             uuid NOT NULL REFERENCES payslips(id) ON DELETE CASCADE,
  employee_id            uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  employee_number        text NOT NULL,
  amount                 numeric(14,2) NOT NULL CHECK (amount >= 0),
  currency               text NOT NULL DEFAULT 'PKR',
  payment_method         text NOT NULL DEFAULT 'bank_transfer',
  bank_name              text,
  account_title          text,
  account_number_enc     text,
  iban_enc               text,
  account_last4          text,
  branch_code            text,
  status                 text NOT NULL DEFAULT 'generated' CHECK (status IN ('generated', 'released', 'acknowledged', 'rejected', 'reissued', 'voided')),
  bank_reference         text,
  rejection_reason       text,
  retry_count            integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  reissued_to_item_id    uuid REFERENCES payroll_payment_items(id) ON DELETE SET NULL,
  acknowledged_at        timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payroll_payment_items_batch ON payroll_payment_items (batch_id);
CREATE INDEX IF NOT EXISTS idx_payroll_payment_items_run ON payroll_payment_items (payroll_run_id, status);
CREATE INDEX IF NOT EXISTS idx_payroll_payment_items_company ON payroll_payment_items (company_id);
-- duplicate-payment prevention: a payslip has at most one live payment at any time
CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_payment_items_one_live_per_payslip
  ON payroll_payment_items (payslip_id) WHERE status IN ('generated', 'released', 'acknowledged');

-- ---------------------------------------------------------------- reconciliations
CREATE TABLE IF NOT EXISTS payroll_reconciliations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_run_id   uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('calculation', 'payroll', 'payment', 'bank', 'accounting', 'costing', 'tax', 'reversal')),
  sequence         integer NOT NULL DEFAULT 1 CHECK (sequence > 0),
  status           text NOT NULL CHECK (status IN ('matched', 'variance', 'pending', 'resolved')),
  expected_amount  numeric(16,2) NOT NULL DEFAULT 0,
  actual_amount    numeric(16,2) NOT NULL DEFAULT 0,
  variance         numeric(16,2) NOT NULL DEFAULT 0,
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_by           uuid REFERENCES user_accounts(id),
  run_at           timestamptz NOT NULL DEFAULT now(),
  resolved_by      uuid REFERENCES user_accounts(id),
  resolved_at      timestamptz,
  resolution_note  text,
  correlation_id   uuid,
  UNIQUE (payroll_run_id, kind, sequence),
  CHECK (status <> 'resolved' OR (resolved_by IS NOT NULL AND resolution_note IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_payroll_reconciliations_company ON payroll_reconciliations (company_id);

-- ---------------------------------------------------------------- RLS and grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_file_formats', 'payroll_payment_items', 'payroll_reconciliations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())',
      t || '_all', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO app_role', t);
  END LOOP;
END $$;
