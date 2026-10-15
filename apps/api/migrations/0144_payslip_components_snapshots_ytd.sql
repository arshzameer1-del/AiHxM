SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- 0144 - Step 9C: structured payslip results, input snapshots, YTD accumulations, typed consumption links and
--        payslip immutability (gap register PAY-05, PAY-21).
--
-- ROLLBACK (additive; the jsonb columns the engine used before are kept and still written):
--   DROP TRIGGER IF EXISTS payslips_immutability_guard ON payslips;
--   DROP FUNCTION IF EXISTS app.payslip_immutability_guard();
--   DROP FUNCTION IF EXISTS app.payslip_child_immutability_guard();
--   DROP FUNCTION IF EXISTS app.payslip_consumption_guard();
--   DROP TABLE IF EXISTS payslip_consumptions, payroll_ytd, payroll_input_snapshots, payroll_component_results;
--   ALTER TABLE payslips DROP COLUMN IF EXISTS calculation_sequence, DROP COLUMN IF EXISTS status,
--     DROP COLUMN IF EXISTS is_immutable, DROP COLUMN IF EXISTS employer_cost, DROP COLUMN IF EXISTS arrears_amount,
--     DROP COLUMN IF EXISTS retro_detail;

-- ---------------------------------------------------------------- payslip columns
ALTER TABLE payslips
  ADD COLUMN IF NOT EXISTS calculation_sequence integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'calculated' CHECK (status IN ('calculated', 'overridden', 'final', 'voided')),
  ADD COLUMN IF NOT EXISTS is_immutable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS employer_cost numeric(14,2) NOT NULL DEFAULT 0,
  -- filled by the retro / arrears engine (PAY-12, Step 9E); zero / empty until then
  ADD COLUMN IF NOT EXISTS arrears_amount numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retro_detail jsonb NOT NULL DEFAULT '[]'::jsonb;

-- backfill from what is already stored (before the immutability guard exists)
UPDATE payslips p SET
  employer_cost = p.gross_pay + p.eobi_employer_contribution + p.social_security_employer_contribution,
  calculation_sequence = GREATEST(1, r.calculation_sequence),
  status = CASE WHEN r.status = 'reversed' THEN 'voided'
                WHEN r.status IN ('finalized', 'accounting', 'payment_released', 'reconciled', 'closed', 'reopened') THEN 'final'
                ELSE 'calculated' END,
  is_immutable = r.status IN ('finalized', 'accounting', 'payment_released', 'reconciled', 'closed', 'reopened', 'reversed')
FROM payroll_runs r
WHERE r.id = p.payroll_run_id;

-- ---------------------------------------------------------------- component results
-- One row per line of a payslip, signed from the employee's point of view:
--   affects 'gross'         earnings and reductions of gross  -> SUM = gross_pay
--   affects 'net'           deductions taken from net only     -> SUM(gross + net) = net_pay
--   affects 'employer_cost' employer contributions (positive)  -> not part of the employee's pay
CREATE TABLE IF NOT EXISTS payroll_component_results (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_run_id   uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  payslip_id       uuid NOT NULL REFERENCES payslips(id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  calculation_sequence integer NOT NULL DEFAULT 1,
  line_no          integer NOT NULL,
  component_key    text NOT NULL,
  component_id     uuid REFERENCES compensation_components(id) ON DELETE SET NULL,
  label            text NOT NULL,
  category         text NOT NULL CHECK (category IN ('earning', 'employee_deduction', 'employer_contribution', 'tax', 'statutory_deduction', 'recovery', 'adjustment')),
  affects          text NOT NULL CHECK (affects IN ('gross', 'net', 'employer_cost')),
  amount           numeric(14,2) NOT NULL,
  is_taxable       boolean NOT NULL DEFAULT false,
  quantity         numeric(14,4),
  unit             text,
  rate             numeric(14,4),
  basis_amount     numeric(14,2),
  source_type      text NOT NULL CHECK (source_type IN ('compensation', 'overtime', 'additional_payment', 'off_cycle_payment', 'loan', 'leave', 'statutory', 'tax', 'override', 'rounding')),
  source_id        uuid,
  trace            jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_overridden    boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payslip_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_payroll_component_results_run ON payroll_component_results (payroll_run_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_payroll_component_results_key ON payroll_component_results (company_id, component_key);

-- ---------------------------------------------------------------- input snapshots
-- Everything a payslip was calculated from that is not itself a rule (rules live in payroll_rule_snapshots):
-- employment and organisation facts, the compensation segments in force, leave and overtime summaries, the
-- working-day basis and the tax-year-to-date figures read.
CREATE TABLE IF NOT EXISTS payroll_input_snapshots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_run_id   uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  payslip_id       uuid NOT NULL UNIQUE REFERENCES payslips(id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  calculation_sequence integer NOT NULL DEFAULT 1,
  content_hash     text NOT NULL,
  snapshot         jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payroll_input_snapshots_run ON payroll_input_snapshots (payroll_run_id, employee_id);

-- ---------------------------------------------------------------- YTD accumulations
-- Rebuilt from the settled payslips of the tax year whenever a run is finalised or reversed, so it can never
-- drift from them. tax_year is the label the engine uses (e.g. 2036-37, 1 July - 30 June).
CREATE TABLE IF NOT EXISTS payroll_ytd (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  tax_year         text NOT NULL,
  gross_pay        numeric(14,2) NOT NULL DEFAULT 0,
  taxable_gross    numeric(14,2) NOT NULL DEFAULT 0,
  income_tax       numeric(14,2) NOT NULL DEFAULT 0,
  eobi_employee    numeric(14,2) NOT NULL DEFAULT 0,
  eobi_employer    numeric(14,2) NOT NULL DEFAULT 0,
  social_security_employer numeric(14,2) NOT NULL DEFAULT 0,
  net_pay          numeric(14,2) NOT NULL DEFAULT 0,
  employer_cost    numeric(14,2) NOT NULL DEFAULT 0,
  payslip_count    integer NOT NULL DEFAULT 0,
  last_period_end  date,
  last_run_id      uuid REFERENCES payroll_runs(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, employee_id, tax_year)
);
CREATE INDEX IF NOT EXISTS idx_payroll_ytd_employee ON payroll_ytd (employee_id, tax_year);

-- ---------------------------------------------------------------- consumption links
-- Replaces the untyped jsonb arrays on payslips as the record of which input a payslip used.
-- previewed = used by a calculation, consumed = committed when the run was finalised, released = given back by a reversal.
CREATE TABLE IF NOT EXISTS payslip_consumptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_run_id   uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  payslip_id       uuid NOT NULL REFERENCES payslips(id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  source_type      text NOT NULL CHECK (source_type IN ('additional_payment', 'off_cycle_payment', 'overtime', 'loan_installment', 'unpaid_leave', 'attendance_deduction')),
  source_id        uuid NOT NULL,
  amount           numeric(14,2) NOT NULL DEFAULT 0,
  quantity         numeric(14,4),
  unit             text,
  status           text NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'consumed', 'released')),
  consumed_at      timestamptz,
  released_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payslip_id, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_payslip_consumptions_source ON payslip_consumptions (source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_payslip_consumptions_run ON payslip_consumptions (payroll_run_id);

-- backfill the links from the jsonb arrays already stored
INSERT INTO payslip_consumptions (company_id, payroll_run_id, payslip_id, employee_id, source_type, source_id, amount, status, consumed_at)
SELECT p.company_id, p.payroll_run_id, p.id, p.employee_id, x.source_type, x.source_id, x.amount,
       CASE WHEN p.is_immutable AND p.status <> 'voided' THEN 'consumed' WHEN p.status = 'voided' THEN 'released' ELSE 'previewed' END,
       CASE WHEN p.is_immutable AND p.status <> 'voided' THEN p.updated_at END
FROM payslips p
CROSS JOIN LATERAL (
  SELECT 'additional_payment' AS source_type, (e->>'additionalPaymentId')::uuid AS source_id, (e->>'amount')::numeric AS amount
    FROM jsonb_array_elements(p.consumed_additional_payments) e WHERE e ? 'additionalPaymentId'
  UNION ALL
  SELECT 'off_cycle_payment', (e->>'offCyclePaymentId')::uuid, (e->>'amount')::numeric
    FROM jsonb_array_elements(p.consumed_offcycle_payments) e WHERE e ? 'offCyclePaymentId'
  UNION ALL
  SELECT 'overtime', (e->>'overtimeId')::uuid, (e->>'amount')::numeric
    FROM jsonb_array_elements(p.consumed_overtime) e WHERE e ? 'overtimeId'
  UNION ALL
  SELECT 'loan_installment', (e->>'loanId')::uuid, (e->>'amount')::numeric
    FROM jsonb_array_elements(p.loan_deductions) e WHERE e ? 'loanId'
) x
WHERE x.source_id IS NOT NULL
ON CONFLICT (payslip_id, source_type, source_id) DO NOTHING;

-- ---------------------------------------------------------------- immutability guards
-- A settled payslip (is_immutable) can no longer be edited or removed. Only these may still change:
--   bank_account_number  (the at-rest encoding of the same value is rewritten by the encryption backfill)
--   status               (final -> voided when a reversal supersedes the run)
-- pg_trigger_depth() = 1 means a statement issued by a user; a cascade from the owning company or run runs deeper.
CREATE OR REPLACE FUNCTION app.payslip_immutability_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_immutable AND pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'payslip % is final and cannot be deleted', OLD.id USING ERRCODE = '23000';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.is_immutable THEN
    IF NEW.is_immutable = false THEN
      RAISE EXCEPTION 'payslip % is final; it cannot be made editable again', OLD.id USING ERRCODE = '23000';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'final' AND NEW.status = 'voided') THEN
      RAISE EXCEPTION 'payslip % is final; its status can only move from final to voided', OLD.id USING ERRCODE = '23000';
    END IF;
    IF (to_jsonb(NEW) - 'bank_account_number' - 'status' - 'updated_at')
       IS DISTINCT FROM (to_jsonb(OLD) - 'bank_account_number' - 'status' - 'updated_at') THEN
      RAISE EXCEPTION 'payslip % is final; its figures cannot be changed', OLD.id USING ERRCODE = '23000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payslips_immutability_guard ON payslips;
CREATE TRIGGER payslips_immutability_guard BEFORE UPDATE OR DELETE ON payslips
  FOR EACH ROW EXECUTE FUNCTION app.payslip_immutability_guard();

CREATE OR REPLACE FUNCTION app.payslip_child_immutability_guard() RETURNS trigger AS $$
DECLARE locked boolean;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT is_immutable INTO locked FROM payslips WHERE id = OLD.payslip_id;
  IF locked THEN
    RAISE EXCEPTION 'the payslip is final; its % rows cannot be changed', TG_TABLE_NAME USING ERRCODE = '23000';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payroll_component_results_guard ON payroll_component_results;
CREATE TRIGGER payroll_component_results_guard BEFORE UPDATE OR DELETE ON payroll_component_results
  FOR EACH ROW EXECUTE FUNCTION app.payslip_child_immutability_guard();
DROP TRIGGER IF EXISTS payroll_input_snapshots_guard ON payroll_input_snapshots;
CREATE TRIGGER payroll_input_snapshots_guard BEFORE UPDATE OR DELETE ON payroll_input_snapshots
  FOR EACH ROW EXECUTE FUNCTION app.payslip_child_immutability_guard();

-- consumption links: once the payslip is final only the status columns move (consumed -> released on a reversal)
CREATE OR REPLACE FUNCTION app.payslip_consumption_guard() RETURNS trigger AS $$
DECLARE locked boolean;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT is_immutable INTO locked FROM payslips WHERE id = OLD.payslip_id;
  IF locked THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'the payslip is final; its consumption links cannot be removed' USING ERRCODE = '23000';
    END IF;
    IF (to_jsonb(NEW) - 'status' - 'consumed_at' - 'released_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'consumed_at' - 'released_at') THEN
      RAISE EXCEPTION 'the payslip is final; only the status of a consumption link can change' USING ERRCODE = '23000';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payslip_consumptions_guard ON payslip_consumptions;
CREATE TRIGGER payslip_consumptions_guard BEFORE UPDATE OR DELETE ON payslip_consumptions
  FOR EACH ROW EXECUTE FUNCTION app.payslip_consumption_guard();

-- ---------------------------------------------------------------- RLS + grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_component_results', 'payroll_input_snapshots', 'payroll_ytd', 'payslip_consumptions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())', t || '_all', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_role', t);
  END LOOP;
END $$;
