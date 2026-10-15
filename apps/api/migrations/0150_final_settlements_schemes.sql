-- 0150 - Step 10C: final settlement and statutory/benefit scheme ledgers (gap register PAY-14, PAY-15).
--
--  PAY-14  payroll_final_settlements + payroll_final_settlement_lines
--          One settlement per termination event, opened by a trigger on employee_lifecycle_events (LIF-05) when a
--          termination takes effect and the tenant has payroll. HR calculates it (leave encashment, gratuity, notice
--          recovery, provident-fund balance, outstanding loans), a second person approves it - which creates the
--          earning / deduction payments the final payroll run will consume - and when that final_settlement run is
--          finalised the settlement is closed with an immutable result (the payslip's figures and the lines that make
--          them up). Finalised settlements and their lines can never be changed; reversing the run marks it reversed.
--  PAY-15  payroll_scheme_definitions (provident fund / gratuity / other, per country pack, versioned by effective
--          date), employee_scheme_accounts and an append-only employee_scheme_ledger. No contribution rate, gratuity
--          day count or divisor is shipped: every figure is entered by the tenant (see parameters).
--          payroll_settlement_settings holds the tenant's own leave-encashment / notice-recovery switches and divisor.
--
-- ROLLBACK (additive): DROP TRIGGER trg_open_final_settlement ON employee_lifecycle_events;
--   DROP FUNCTION app.open_final_settlement(); DROP TABLE IF EXISTS payroll_final_settlement_lines,
--   payroll_final_settlements, employee_scheme_ledger, employee_scheme_accounts, payroll_scheme_definitions,
--   payroll_settlement_settings; DROP FUNCTION app.settlement_guard(), app.scheme_ledger_append_only().

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- ---------------------------------------------------------------- settings
CREATE TABLE IF NOT EXISTS payroll_settlement_settings (
  company_id                 uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  daily_rate_divisor         numeric(6,2) CHECK (daily_rate_divisor IS NULL OR daily_rate_divisor > 0),
  daily_rate_base            text CHECK (daily_rate_base IS NULL OR daily_rate_base IN ('basic_salary', 'gross_earnings')),
  leave_encashment_enabled   boolean NOT NULL DEFAULT false,
  leave_encashment_taxable   boolean NOT NULL DEFAULT true,
  notice_recovery_enabled    boolean NOT NULL DEFAULT false,
  updated_by                 uuid REFERENCES user_accounts(id),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- scheme definitions and ledgers (PAY-15)
CREATE TABLE IF NOT EXISTS payroll_scheme_definitions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code            text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name            text NOT NULL CHECK (length(btrim(name)) > 0),
  scheme_type     text NOT NULL CHECK (scheme_type IN ('provident_fund', 'gratuity', 'other')),
  country_code    text NOT NULL DEFAULT 'PK' CHECK (country_code ~ '^[A-Z]{2}$'),
  effective_from  date NOT NULL,
  effective_to    date,
  is_active       boolean NOT NULL DEFAULT true,
  parameters      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(parameters) = 'object'),
  created_by      uuid REFERENCES user_accounts(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code, effective_from),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS idx_payroll_scheme_definitions_company ON payroll_scheme_definitions (company_id, code, effective_from DESC);

CREATE TABLE IF NOT EXISTS employee_scheme_accounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  scheme_code  text NOT NULL CHECK (scheme_code ~ '^[a-z][a-z0-9_]{1,39}$'),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  opened_on    date NOT NULL DEFAULT CURRENT_DATE,
  closed_on    date,
  created_by   uuid REFERENCES user_accounts(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, employee_id, scheme_code)
);
CREATE INDEX IF NOT EXISTS idx_employee_scheme_accounts_employee ON employee_scheme_accounts (employee_id);

CREATE TABLE IF NOT EXISTS employee_scheme_ledger (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  account_id         uuid NOT NULL REFERENCES employee_scheme_accounts(id) ON DELETE CASCADE,
  entry_type         text NOT NULL CHECK (entry_type IN ('opening_balance', 'employee_contribution', 'employer_contribution', 'withdrawal', 'payout', 'adjustment', 'reversal')),
  amount             numeric(14,2) NOT NULL CHECK (amount <> 0),
  entry_date         date NOT NULL DEFAULT CURRENT_DATE,
  payroll_run_id     uuid REFERENCES payroll_runs(id) ON DELETE SET NULL,
  payslip_id         uuid REFERENCES payslips(id) ON DELETE SET NULL,
  settlement_id      uuid,
  reverses_entry_id  uuid REFERENCES employee_scheme_ledger(id),
  note               text,
  created_by         uuid REFERENCES user_accounts(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (entry_type <> 'reversal' OR reverses_entry_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_employee_scheme_ledger_account ON employee_scheme_ledger (account_id, entry_date);
-- a run posts each kind of contribution to an account once; a reversal is posted once per entry
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_scheme_ledger_run_once
  ON employee_scheme_ledger (account_id, payroll_run_id, entry_type) WHERE payroll_run_id IS NOT NULL AND reverses_entry_id IS NULL AND entry_type IN ('employee_contribution', 'employer_contribution');
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_scheme_ledger_reversal_once ON employee_scheme_ledger (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_scheme_ledger_payout_once ON employee_scheme_ledger (account_id, settlement_id) WHERE entry_type = 'payout' AND reverses_entry_id IS NULL AND settlement_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app.scheme_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- the cascade from deleting the owning company / employee is allowed; direct edits are not
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'employee_scheme_ledger is append-only; post a reversal instead' USING ERRCODE = 'integrity_constraint_violation';
END $$;
DROP TRIGGER IF EXISTS employee_scheme_ledger_append_only ON employee_scheme_ledger;
CREATE TRIGGER employee_scheme_ledger_append_only BEFORE UPDATE OR DELETE ON employee_scheme_ledger
  FOR EACH ROW EXECUTE FUNCTION app.scheme_ledger_append_only();

-- ---------------------------------------------------------------- final settlements (PAY-14)
CREATE TABLE IF NOT EXISTS payroll_final_settlements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id           uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  termination_event_id  uuid NOT NULL REFERENCES employee_lifecycle_events(id) ON DELETE CASCADE,
  last_working_day      date NOT NULL,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'calculated', 'approved', 'finalized', 'cancelled', 'reversed')),
  payroll_run_id        uuid REFERENCES payroll_runs(id) ON DELETE SET NULL,
  calculation_sequence  integer NOT NULL DEFAULT 0,
  calculated_by         uuid REFERENCES user_accounts(id),
  calculated_at         timestamptz,
  approved_by           uuid REFERENCES user_accounts(id),
  approved_at           timestamptz,
  finalized_at          timestamptz,
  result_snapshot       jsonb,
  is_immutable          boolean NOT NULL DEFAULT false,
  cancel_reason         text,
  correlation_id        uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (termination_event_id),
  CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND calculated_by IS NOT NULL)),
  CHECK (approved_by IS NULL OR approved_by <> calculated_by)
);
CREATE INDEX IF NOT EXISTS idx_payroll_final_settlements_employee ON payroll_final_settlements (company_id, employee_id);

CREATE TABLE IF NOT EXISTS payroll_final_settlement_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  settlement_id         uuid NOT NULL REFERENCES payroll_final_settlements(id) ON DELETE CASCADE,
  line_no               integer NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('salary_due', 'leave_encashment', 'gratuity', 'provident_fund', 'notice_recovery', 'loan_outstanding', 'tax_finalization', 'other_deductions')),
  label                 text NOT NULL,
  amount                numeric(14,2) NOT NULL,
  settle_via            text NOT NULL CHECK (settle_via IN ('payslip', 'scheme_ledger', 'run_result', 'info')),
  is_taxable            boolean,
  additional_payment_id uuid REFERENCES employee_additional_payments(id) ON DELETE SET NULL,
  scheme_code           text,
  basis                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  warning               text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (settlement_id, line_no)
);

CREATE OR REPLACE FUNCTION app.settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE locked boolean;
BEGIN
  IF TG_TABLE_NAME = 'payroll_final_settlements' THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.is_immutable AND pg_trigger_depth() <= 1 THEN RAISE EXCEPTION 'a finalised final settlement cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
      RETURN OLD;
    END IF;
    IF OLD.is_immutable THEN
      -- the only change a finalised settlement allows is being marked reversed with its run
      IF NOT (OLD.status = 'finalized' AND NEW.status = 'reversed' AND NEW.result_snapshot IS NOT DISTINCT FROM OLD.result_snapshot AND NEW.employee_id = OLD.employee_id) THEN
        RAISE EXCEPTION 'a finalised final settlement is immutable' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  SELECT is_immutable INTO locked FROM payroll_final_settlements WHERE id = COALESCE(OLD.settlement_id, NEW.settlement_id);
  IF locked THEN RAISE EXCEPTION 'the lines of a finalised final settlement are immutable' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS payroll_final_settlements_guard ON payroll_final_settlements;
CREATE TRIGGER payroll_final_settlements_guard BEFORE UPDATE OR DELETE ON payroll_final_settlements FOR EACH ROW EXECUTE FUNCTION app.settlement_guard();
DROP TRIGGER IF EXISTS payroll_final_settlement_lines_guard ON payroll_final_settlement_lines;
CREATE TRIGGER payroll_final_settlement_lines_guard BEFORE UPDATE OR DELETE ON payroll_final_settlement_lines FOR EACH ROW EXECUTE FUNCTION app.settlement_guard();

-- LIF-05 -> PAY-14: a termination that takes effect opens the employee's final settlement
CREATE OR REPLACE FUNCTION app.open_final_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action_type = 'termination' AND NEW.status = 'applied' AND NEW.corrects_event_id IS NULL
     AND EXISTS (SELECT 1 FROM tenant_module_entitlement WHERE company_id = NEW.company_id AND module_key = 'payroll' AND enabled) THEN
    INSERT INTO payroll_final_settlements (company_id, employee_id, termination_event_id, last_working_day)
    VALUES (NEW.company_id, NEW.employee_id, NEW.id, NEW.effective_date)
    ON CONFLICT (termination_event_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_open_final_settlement ON employee_lifecycle_events;
CREATE TRIGGER trg_open_final_settlement AFTER INSERT OR UPDATE OF status ON employee_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION app.open_final_settlement();

-- ---------------------------------------------------------------- RLS and grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_settlement_settings', 'payroll_scheme_definitions', 'employee_scheme_accounts', 'employee_scheme_ledger', 'payroll_final_settlements', 'payroll_final_settlement_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())',
      t || '_all', t);
    IF t = 'employee_scheme_ledger' THEN
      EXECUTE format('GRANT SELECT, INSERT ON %I TO app_role', t);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_role', t);
    END IF;
  END LOOP;
END $$;
