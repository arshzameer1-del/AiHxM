SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- 0146 - Step 9E: richer pay components, compensation records and adjustments, plus retro / arrears
--        (gap register PAY-07, PAY-11, PAY-12).
--
--  * compensation_components   calculation type, basis, cap / floor, eligibility, proration, rounding, which statutory
--                              bases the component counts toward, GL account, payslip label, display order, category;
--                              component types widened (employer contribution, reimbursement, non-cash benefit,
--                              arrears, retro, shift premium).
--  * employee_compensation_components   percentage / units / entered amount, pay frequency, currency, change reason,
--                              salary grade reference. `amount` stays the MONTHLY amount the engine pays: for a
--                              percentage, per-unit, formula or threshold component it is the amount resolved when
--                              the row was written (and re-resolved whenever its basis changes).
--  * employee_additional_payments / employee_offcycle_payments   a reference to the pay component, a reason from the
--                              catalog, and an approval state driven by the workflow engine.
--  * payroll_retro_results     changes to history the payroll has already paid: what was paid, what it should have
--                              been, the difference, and whether it has been included in / paid by a later run.
--
-- No statutory figure is stored or defaulted here. salary_grade_id has no foreign key yet: the grade / pay-scale
-- tables are CAT-10 and the constraint is added when they exist.
--
-- ROLLBACK (additive; nothing is dropped except the widened checks, restored below):
--   DROP TABLE IF EXISTS payroll_retro_results;
--   ALTER TABLE payroll_component_results DROP CONSTRAINT payroll_component_results_source_type_check;
--   ALTER TABLE payroll_component_results ADD CONSTRAINT payroll_component_results_source_type_check CHECK (source_type IN
--     ('compensation','overtime','additional_payment','off_cycle_payment','loan','leave','statutory','tax','override','rounding'));
--   ALTER TABLE payslip_consumptions DROP CONSTRAINT payslip_consumptions_source_type_check;
--   ALTER TABLE payslip_consumptions ADD CONSTRAINT payslip_consumptions_source_type_check CHECK (source_type IN
--     ('additional_payment','off_cycle_payment','overtime','loan_installment','unpaid_leave','attendance_deduction'));
--   ALTER TABLE employee_offcycle_payments DROP COLUMN IF EXISTS component_id, DROP COLUMN IF EXISTS reason_catalog_item_id,
--     DROP COLUMN IF EXISTS reason_note, DROP COLUMN IF EXISTS approval_status, DROP COLUMN IF EXISTS workflow_instance_id,
--     DROP COLUMN IF EXISTS approved_by, DROP COLUMN IF EXISTS approved_at;
--   ALTER TABLE employee_additional_payments DROP COLUMN IF EXISTS component_id, DROP COLUMN IF EXISTS reason_catalog_item_id,
--     DROP COLUMN IF EXISTS reason_note, DROP COLUMN IF EXISTS approval_status, DROP COLUMN IF EXISTS approved_by, DROP COLUMN IF EXISTS approved_at;
--   ALTER TABLE employee_compensation_components DROP COLUMN IF EXISTS percentage, DROP COLUMN IF EXISTS units, DROP COLUMN IF EXISTS entered_amount,
--     DROP COLUMN IF EXISTS pay_frequency, DROP COLUMN IF EXISTS currency_code, DROP COLUMN IF EXISTS change_reason_catalog_item_id,
--     DROP COLUMN IF EXISTS change_reason_note, DROP COLUMN IF EXISTS salary_grade_id;
--   ALTER TABLE compensation_components DROP COLUMN IF EXISTS category_catalog_item_id, DROP COLUMN IF EXISTS calculation_type,
--     DROP COLUMN IF EXISTS basis_type, DROP COLUMN IF EXISTS basis_component_id, DROP COLUMN IF EXISTS default_percentage,
--     DROP COLUMN IF EXISTS unit_rate, DROP COLUMN IF EXISTS unit_label, DROP COLUMN IF EXISTS threshold_amount,
--     DROP COLUMN IF EXISTS formula_expression, DROP COLUMN IF EXISTS cap_amount, DROP COLUMN IF EXISTS floor_amount,
--     DROP COLUMN IF EXISTS rounding_mode, DROP COLUMN IF EXISTS rounding_increment, DROP COLUMN IF EXISTS proration_mode,
--     DROP COLUMN IF EXISTS eligibility, DROP COLUMN IF EXISTS counts_toward_eobi_base, DROP COLUMN IF EXISTS counts_toward_gratuity_base,
--     DROP COLUMN IF EXISTS counts_toward_provident_fund_base, DROP COLUMN IF EXISTS gl_account_code, DROP COLUMN IF EXISTS payslip_label,
--     DROP COLUMN IF EXISTS display_order;
--   ALTER TABLE compensation_components DROP CONSTRAINT compensation_components_component_type_check;
--   ALTER TABLE compensation_components ADD CONSTRAINT compensation_components_component_type_check CHECK (component_type IN ('earning','deduction'));

-- ---------------------------------------------------------------- component catalog
ALTER TABLE compensation_components DROP CONSTRAINT IF EXISTS compensation_components_component_type_check;
ALTER TABLE compensation_components ADD CONSTRAINT compensation_components_component_type_check CHECK (component_type IN
  ('earning', 'deduction', 'employer_contribution', 'reimbursement', 'non_cash_benefit', 'arrears', 'retro', 'shift_premium'));

ALTER TABLE compensation_components
  ADD COLUMN IF NOT EXISTS category_catalog_item_id uuid REFERENCES hr_reference_catalog_items(id),
  ADD COLUMN IF NOT EXISTS calculation_type text NOT NULL DEFAULT 'fixed' CHECK (calculation_type IN ('fixed', 'percentage', 'per_unit', 'formula', 'threshold')),
  ADD COLUMN IF NOT EXISTS basis_type text NOT NULL DEFAULT 'none' CHECK (basis_type IN ('none', 'basic_salary', 'component', 'gross_fixed_earnings')),
  ADD COLUMN IF NOT EXISTS basis_component_id uuid REFERENCES compensation_components(id),
  ADD COLUMN IF NOT EXISTS default_percentage numeric(9,4) CHECK (default_percentage IS NULL OR default_percentage >= 0),
  ADD COLUMN IF NOT EXISTS unit_rate numeric(14,4) CHECK (unit_rate IS NULL OR unit_rate >= 0),
  ADD COLUMN IF NOT EXISTS unit_label text,
  ADD COLUMN IF NOT EXISTS threshold_amount numeric(14,2) CHECK (threshold_amount IS NULL OR threshold_amount >= 0),
  ADD COLUMN IF NOT EXISTS formula_expression jsonb,
  ADD COLUMN IF NOT EXISTS cap_amount numeric(14,2) CHECK (cap_amount IS NULL OR cap_amount >= 0),
  ADD COLUMN IF NOT EXISTS floor_amount numeric(14,2) CHECK (floor_amount IS NULL OR floor_amount >= 0),
  ADD COLUMN IF NOT EXISTS rounding_mode text NOT NULL DEFAULT 'none' CHECK (rounding_mode IN ('none', 'nearest', 'up', 'down')),
  ADD COLUMN IF NOT EXISTS rounding_increment numeric(10,2) NOT NULL DEFAULT 1 CHECK (rounding_increment > 0),
  ADD COLUMN IF NOT EXISTS proration_mode text NOT NULL DEFAULT 'prorated' CHECK (proration_mode IN ('prorated', 'none')),
  ADD COLUMN IF NOT EXISTS eligibility jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS counts_toward_eobi_base boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS counts_toward_gratuity_base boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS counts_toward_provident_fund_base boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gl_account_code text,
  ADD COLUMN IF NOT EXISTS payslip_label text,
  ADD COLUMN IF NOT EXISTS display_order integer NOT NULL DEFAULT 0;

-- a derived component must say what it is derived from; a floor never exceeds its cap
ALTER TABLE compensation_components DROP CONSTRAINT IF EXISTS compensation_components_basis_ck;
ALTER TABLE compensation_components ADD CONSTRAINT compensation_components_basis_ck CHECK (
  (calculation_type NOT IN ('percentage', 'threshold') OR basis_type <> 'none')
  AND (basis_type <> 'component' OR basis_component_id IS NOT NULL)
  AND (calculation_type <> 'formula' OR formula_expression IS NOT NULL)
  AND (cap_amount IS NULL OR floor_amount IS NULL OR floor_amount <= cap_amount)
);

UPDATE compensation_components SET display_order = sort_order WHERE display_order = 0 AND sort_order <> 0;

-- ---------------------------------------------------------------- employee compensation records
ALTER TABLE employee_compensation_components
  ADD COLUMN IF NOT EXISTS percentage numeric(9,4) CHECK (percentage IS NULL OR percentage >= 0),
  ADD COLUMN IF NOT EXISTS units numeric(12,2) CHECK (units IS NULL OR units >= 0),
  ADD COLUMN IF NOT EXISTS entered_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS pay_frequency text NOT NULL DEFAULT 'monthly' CHECK (pay_frequency IN ('monthly', 'annual')),
  ADD COLUMN IF NOT EXISTS currency_code text NOT NULL DEFAULT 'PKR' CHECK (currency_code ~ '^[A-Z]{3}$'),
  ADD COLUMN IF NOT EXISTS change_reason_catalog_item_id uuid REFERENCES hr_reference_catalog_items(id),
  ADD COLUMN IF NOT EXISTS change_reason_note text,
  ADD COLUMN IF NOT EXISTS salary_grade_id uuid;
UPDATE employee_compensation_components SET entered_amount = amount WHERE entered_amount IS NULL;

-- ---------------------------------------------------------------- adjustments reference a component, a reason, an approval
ALTER TABLE employee_additional_payments
  ADD COLUMN IF NOT EXISTS component_id uuid REFERENCES compensation_components(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reason_catalog_item_id uuid REFERENCES hr_reference_catalog_items(id),
  ADD COLUMN IF NOT EXISTS reason_note text,
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'not_required' CHECK (approval_status IN ('not_required', 'pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

ALTER TABLE employee_offcycle_payments
  ADD COLUMN IF NOT EXISTS component_id uuid REFERENCES compensation_components(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reason_catalog_item_id uuid REFERENCES hr_reference_catalog_items(id),
  ADD COLUMN IF NOT EXISTS reason_note text,
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'not_required' CHECK (approval_status IN ('not_required', 'pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS workflow_instance_id uuid REFERENCES workflow_instances(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_employee_offcycle_payments_workflow ON employee_offcycle_payments (workflow_instance_id) WHERE workflow_instance_id IS NOT NULL;

-- ---------------------------------------------------------------- engine result / consumption types
ALTER TABLE payroll_component_results DROP CONSTRAINT IF EXISTS payroll_component_results_source_type_check;
ALTER TABLE payroll_component_results ADD CONSTRAINT payroll_component_results_source_type_check CHECK (source_type IN
  ('compensation', 'overtime', 'additional_payment', 'off_cycle_payment', 'loan', 'leave', 'statutory', 'tax', 'override', 'rounding', 'retro'));
ALTER TABLE payslip_consumptions DROP CONSTRAINT IF EXISTS payslip_consumptions_source_type_check;
ALTER TABLE payslip_consumptions ADD CONSTRAINT payslip_consumptions_source_type_check CHECK (source_type IN
  ('additional_payment', 'off_cycle_payment', 'overtime', 'loan_installment', 'unpaid_leave', 'attendance_deduction', 'retro_result'));

-- ---------------------------------------------------------------- retro results (PAY-12)
CREATE TABLE IF NOT EXISTS payroll_retro_results (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id          uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  -- the finalised payslip whose result is now known to be different
  source_run_id        uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  source_payslip_id    uuid NOT NULL REFERENCES payslips(id) ON DELETE CASCADE,
  -- what changed: a backdated compensation row, an unpaid-leave change, or an entry made by hand
  source_event_type    text NOT NULL CHECK (source_event_type IN ('compensation_change', 'leave_change', 'manual')),
  source_event_id      uuid,
  affected_period_start date NOT NULL,
  affected_period_end   date NOT NULL,
  component_key        text NOT NULL,
  component_label      text NOT NULL,
  original_amount      numeric(14,2) NOT NULL,
  recalculated_amount  numeric(14,2) NOT NULL,
  -- recalculated - original - what earlier retro results for the same payslip and component already cover
  delta                numeric(14,2) NOT NULL,
  is_taxable           boolean NOT NULL DEFAULT true,
  status               text NOT NULL DEFAULT 'detected' CHECK (status IN ('detected', 'included', 'paid', 'dismissed', 'superseded')),
  target_run_id        uuid REFERENCES payroll_runs(id) ON DELETE SET NULL,
  included_payslip_id  uuid REFERENCES payslips(id) ON DELETE SET NULL,
  paid_at              timestamptz,
  dismissed_by         uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  dismissed_reason     text,
  detail               jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_by          uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  correlation_id       uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (affected_period_end >= affected_period_start),
  CHECK (status NOT IN ('included', 'paid') OR target_run_id IS NOT NULL OR status = 'paid')
);
-- one live result per payslip and component: a repeat detection refreshes it instead of duplicating it
CREATE UNIQUE INDEX IF NOT EXISTS payroll_retro_results_live_uq
  ON payroll_retro_results (source_payslip_id, component_key) WHERE status IN ('detected', 'included');
CREATE INDEX IF NOT EXISTS idx_payroll_retro_results_employee ON payroll_retro_results (employee_id, status);
CREATE INDEX IF NOT EXISTS idx_payroll_retro_results_target ON payroll_retro_results (target_run_id, status) WHERE target_run_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_retro_results'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())', t || '_all', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_role', t);
  END LOOP;
END $$;
