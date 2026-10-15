-- Gap Register Step 10D (PAY-17 accounting and costing, PAY-20 payslip / certificate documents, PAY-22 benefits,
-- PAY-26 bulk payroll inputs). Additive only: nothing here changes an existing row or column except the CHECK on
-- import_batches.import_type, which is widened (the existing value 'employees' stays valid).
--
-- PAY-17  payroll_gl_mappings        component key / category -> debit and credit account codes (tenant-entered)
--         payroll_journal_types      one numbering sequence per journal purpose (payroll run, final settlement, reversal)
--         payroll_journals/_lines    balanced double-entry journal per run; immutable once posted
--         payroll_costing_results    employee x cost centre x profit centre cost of a run
-- PAY-20  payroll_document_settings  whether an employee sees a payslip only after it is published
--         payroll_document_template_choices   which document_templates body renders each document type
--         generated_documents        immutable rendered payslips, annual tax certificates, salary certificates
-- PAY-22  benefit_plans / benefit_enrolments / benefit_contributions
-- PAY-26  import_batches.import_type also accepts 'payroll_components' and 'payroll_payments'
--
-- ROLLBACK (in this order):
--   DROP TABLE IF EXISTS benefit_contributions, benefit_enrolments, benefit_plans,
--     generated_documents, payroll_document_template_choices, payroll_document_settings,
--     payroll_costing_results, payroll_journal_lines, payroll_journals, payroll_journal_types, payroll_gl_mappings;
--   DROP FUNCTION IF EXISTS app.payroll_journal_guard(), app.payroll_journal_line_guard(), app.payroll_costing_guard(),
--     app.generated_document_guard();
--   DELETE FROM import_batches WHERE import_type <> 'employees';
--   ALTER TABLE import_batches DROP CONSTRAINT import_batches_import_type_check;
--   ALTER TABLE import_batches ADD CONSTRAINT import_batches_import_type_check CHECK (import_type IN ('employees'));

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- ---------------------------------------------------------------- PAY-17 GL mappings
CREATE TABLE IF NOT EXISTS payroll_gl_mappings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  match_type          text NOT NULL CHECK (match_type IN ('component_key', 'category', 'special')),
  match_value         text NOT NULL CHECK (length(btrim(match_value)) > 0),
  debit_account_code  text CHECK (debit_account_code IS NULL OR length(btrim(debit_account_code)) > 0),
  credit_account_code text CHECK (credit_account_code IS NULL OR length(btrim(credit_account_code)) > 0),
  description         text,
  is_active           boolean NOT NULL DEFAULT true,
  created_by          uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_gl_mappings_unique UNIQUE (company_id, match_type, match_value),
  CONSTRAINT payroll_gl_mappings_account CHECK (debit_account_code IS NOT NULL OR credit_account_code IS NOT NULL)
);

-- ---------------------------------------------------------------- PAY-17 journal types and numbering
CREATE TABLE IF NOT EXISTS payroll_journal_types (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code          text NOT NULL CHECK (length(btrim(code)) > 0),
  name          text NOT NULL,
  purpose       text NOT NULL CHECK (purpose IN ('payroll_run', 'final_settlement', 'reversal')),
  number_prefix text NOT NULL CHECK (length(btrim(number_prefix)) > 0),
  next_number   bigint NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_journal_types_code UNIQUE (company_id, code),
  CONSTRAINT payroll_journal_types_purpose UNIQUE (company_id, purpose)
);

-- ---------------------------------------------------------------- PAY-17 journals
CREATE TABLE IF NOT EXISTS payroll_journals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_run_id      uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  journal_type_id     uuid NOT NULL REFERENCES payroll_journal_types(id),
  journal_kind        text NOT NULL DEFAULT 'run' CHECK (journal_kind IN ('run', 'reversal')),
  journal_number      text,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'reversed', 'discarded')),
  reverses_journal_id uuid REFERENCES payroll_journals(id) ON DELETE SET NULL,
  posting_date        date NOT NULL,
  currency_code       text NOT NULL DEFAULT 'PKR',
  total_debit         numeric(16,2) NOT NULL DEFAULT 0,
  total_credit        numeric(16,2) NOT NULL DEFAULT 0,
  line_count          integer NOT NULL DEFAULT 0,
  posting_reference   text,
  notes               text,
  generated_by        uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  generated_at        timestamptz NOT NULL DEFAULT now(),
  posted_by           uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  posted_at           timestamptz,
  reversed_at         timestamptz,
  reversed_by         uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  correlation_id      uuid,
  CONSTRAINT payroll_journals_balanced CHECK (total_debit = total_credit),
  CONSTRAINT payroll_journals_numbered CHECK (status IN ('draft', 'discarded') OR journal_number IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_journals_number
  ON payroll_journals (company_id, journal_number) WHERE journal_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_journals_live_run
  ON payroll_journals (payroll_run_id) WHERE journal_kind = 'run' AND status IN ('draft', 'posted');
CREATE INDEX IF NOT EXISTS idx_payroll_journals_run ON payroll_journals (payroll_run_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS payroll_journal_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  journal_id       uuid NOT NULL REFERENCES payroll_journals(id) ON DELETE CASCADE,
  line_no          integer NOT NULL CHECK (line_no >= 1),
  account_code     text NOT NULL,
  debit            numeric(16,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit           numeric(16,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  line_kind        text NOT NULL CHECK (line_kind IN ('expense', 'employer_expense', 'liability', 'employer_liability', 'net_pay')),
  component_key    text,
  description      text,
  cost_center_id   uuid REFERENCES cost_centers(id) ON DELETE SET NULL,
  profit_center_id uuid REFERENCES profit_centers(id) ON DELETE SET NULL,
  CONSTRAINT payroll_journal_lines_one_side CHECK (debit = 0 OR credit = 0),
  CONSTRAINT payroll_journal_lines_no UNIQUE (journal_id, line_no)
);

-- ---------------------------------------------------------------- PAY-17 costing results
CREATE TABLE IF NOT EXISTS payroll_costing_results (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_run_id        uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  journal_id            uuid REFERENCES payroll_journals(id) ON DELETE SET NULL,
  payslip_id            uuid NOT NULL REFERENCES payslips(id) ON DELETE CASCADE,
  employee_id           uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  cost_center_id        uuid REFERENCES cost_centers(id) ON DELETE SET NULL,
  profit_center_id      uuid REFERENCES profit_centers(id) ON DELETE SET NULL,
  allocation_percentage numeric(7,4) NOT NULL CHECK (allocation_percentage >= 0 AND allocation_percentage <= 100),
  allocation_source     text NOT NULL CHECK (allocation_source IN ('allocation', 'position', 'unallocated')),
  gross_cost            numeric(16,2) NOT NULL,
  employer_cost         numeric(16,2) NOT NULL,
  total_cost            numeric(16,2) NOT NULL,
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final', 'superseded')),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_costing_live
  ON payroll_costing_results (payroll_run_id, payslip_id, COALESCE(cost_center_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('draft', 'final');
CREATE INDEX IF NOT EXISTS idx_payroll_costing_run ON payroll_costing_results (payroll_run_id, status);
CREATE INDEX IF NOT EXISTS idx_payroll_costing_cc ON payroll_costing_results (cost_center_id) WHERE cost_center_id IS NOT NULL;

-- A posted journal, its lines and final costing never change except for the reversal marking. Cascades from a deleted
-- run / company (trigger depth > 1) are let through, as for the other append-only payroll tables.
CREATE OR REPLACE FUNCTION app.payroll_journal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('posted', 'reversed') THEN RAISE EXCEPTION 'A posted payroll journal cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('posted', 'reversed') THEN
    IF NEW.status NOT IN ('posted', 'reversed')
       OR NEW.payroll_run_id IS DISTINCT FROM OLD.payroll_run_id
       OR NEW.journal_number IS DISTINCT FROM OLD.journal_number
       OR NEW.journal_kind IS DISTINCT FROM OLD.journal_kind
       OR NEW.total_debit IS DISTINCT FROM OLD.total_debit
       OR NEW.total_credit IS DISTINCT FROM OLD.total_credit
       OR NEW.posting_date IS DISTINCT FROM OLD.posting_date
       OR NEW.line_count IS DISTINCT FROM OLD.line_count
       OR NEW.posted_at IS DISTINCT FROM OLD.posted_at
       OR (OLD.status = 'reversed' AND NEW.status <> 'reversed') THEN
      RAISE EXCEPTION 'A posted payroll journal is immutable (only its posting reference, notes and reversal marking may change)';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_payroll_journal_guard ON payroll_journals;
CREATE TRIGGER trg_payroll_journal_guard BEFORE UPDATE OR DELETE ON payroll_journals
  FOR EACH ROW EXECUTE FUNCTION app.payroll_journal_guard();

CREATE OR REPLACE FUNCTION app.payroll_journal_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT status INTO st FROM payroll_journals WHERE id = COALESCE(OLD.journal_id, NEW.journal_id);
  IF st IN ('posted', 'reversed') THEN
    RAISE EXCEPTION 'The lines of a posted payroll journal cannot be changed';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS trg_payroll_journal_line_guard ON payroll_journal_lines;
CREATE TRIGGER trg_payroll_journal_line_guard BEFORE UPDATE OR DELETE ON payroll_journal_lines
  FOR EACH ROW EXECUTE FUNCTION app.payroll_journal_line_guard();

CREATE OR REPLACE FUNCTION app.payroll_costing_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN COALESCE(NEW, OLD); END IF;
  IF OLD.status = 'final' THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Final costing results cannot be deleted'; END IF;
    IF NEW.status NOT IN ('final', 'superseded')
       OR NEW.gross_cost IS DISTINCT FROM OLD.gross_cost
       OR NEW.employer_cost IS DISTINCT FROM OLD.employer_cost
       OR NEW.total_cost IS DISTINCT FROM OLD.total_cost
       OR NEW.cost_center_id IS DISTINCT FROM OLD.cost_center_id
       OR NEW.payslip_id IS DISTINCT FROM OLD.payslip_id THEN
      RAISE EXCEPTION 'Final costing results are immutable';
    END IF;
  ELSIF OLD.status = 'superseded' THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Superseded costing results cannot be deleted'; END IF;
    RAISE EXCEPTION 'Superseded costing results are immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS trg_payroll_costing_guard ON payroll_costing_results;
CREATE TRIGGER trg_payroll_costing_guard BEFORE UPDATE OR DELETE ON payroll_costing_results
  FOR EACH ROW EXECUTE FUNCTION app.payroll_costing_guard();

-- ---------------------------------------------------------------- PAY-20 documents
CREATE TABLE IF NOT EXISTS payroll_document_settings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  require_publication boolean NOT NULL DEFAULT false,
  updated_by          uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payroll_document_template_choices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_type text NOT NULL CHECK (document_type IN ('payslip', 'tax_certificate', 'salary_certificate')),
  template_key  text NOT NULL CHECK (length(btrim(template_key)) > 0),
  updated_by    uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_document_template_choices_unique UNIQUE (company_id, document_type)
);

CREATE TABLE IF NOT EXISTS generated_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_type    text NOT NULL CHECK (document_type IN ('payslip', 'tax_certificate', 'salary_certificate')),
  employee_id      uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  payroll_run_id   uuid REFERENCES payroll_runs(id) ON DELETE CASCADE,
  payslip_id       uuid REFERENCES payslips(id) ON DELETE CASCADE,
  tax_year         integer,
  template_key     text,
  template_source  text NOT NULL DEFAULT 'built_in' CHECK (template_source IN ('built_in', 'custom')),
  title            text NOT NULL,
  content          text NOT NULL,
  content_hash     text NOT NULL,
  status           text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'superseded', 'revoked')),
  published_at     timestamptz,
  published_by     uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  unpublished_at   timestamptz,
  unpublished_by   uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  supersedes_id    uuid REFERENCES generated_documents(id) ON DELETE SET NULL,
  revoked_at       timestamptz,
  revoked_by       uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  revoke_reason    text,
  generated_by     uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  generated_at     timestamptz NOT NULL DEFAULT now(),
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id   uuid,
  CONSTRAINT generated_documents_payslip_ref CHECK (document_type <> 'payslip' OR payslip_id IS NOT NULL),
  CONSTRAINT generated_documents_tax_ref CHECK (document_type <> 'tax_certificate' OR tax_year IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_generated_documents_live_payslip
  ON generated_documents (payslip_id) WHERE document_type = 'payslip' AND status = 'issued';
CREATE UNIQUE INDEX IF NOT EXISTS idx_generated_documents_live_tax
  ON generated_documents (company_id, employee_id, tax_year) WHERE document_type = 'tax_certificate' AND status = 'issued';
CREATE INDEX IF NOT EXISTS idx_generated_documents_employee ON generated_documents (employee_id, document_type, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_generated_documents_run ON generated_documents (payroll_run_id) WHERE payroll_run_id IS NOT NULL;

-- The rendered text is the record: it never changes after it is issued. Publication, supersession and revocation may.
CREATE OR REPLACE FUNCTION app.generated_document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A generated document cannot be deleted; revoke it instead'; END IF;
  IF NEW.content IS DISTINCT FROM OLD.content
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.document_type IS DISTINCT FROM OLD.document_type
     OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
     OR NEW.payslip_id IS DISTINCT FROM OLD.payslip_id
     OR NEW.tax_year IS DISTINCT FROM OLD.tax_year
     OR NEW.generated_at IS DISTINCT FROM OLD.generated_at THEN
    RAISE EXCEPTION 'A generated document is immutable once issued';
  END IF;
  IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN RAISE EXCEPTION 'A revoked document cannot be reinstated; generate a new one'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_generated_document_guard ON generated_documents;
CREATE TRIGGER trg_generated_document_guard BEFORE UPDATE OR DELETE ON generated_documents
  FOR EACH ROW EXECUTE FUNCTION app.generated_document_guard();

-- ---------------------------------------------------------------- PAY-22 benefits
CREATE TABLE IF NOT EXISTS benefit_plans (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code                        text NOT NULL CHECK (length(btrim(code)) > 0),
  name                        text NOT NULL CHECK (length(btrim(name)) > 0),
  benefit_type                text NOT NULL DEFAULT 'other' CHECK (benefit_type IN
                                ('health_insurance', 'life_insurance', 'pension', 'allowance', 'loan_scheme', 'other')),
  description                 text,
  -- payroll consumes an enrolment through ordinary pay components: enrolling writes the employee's amount on
  -- employee_component_id (a deduction component), and the contribution ledger reads the payslip lines of the keys below
  employee_component_id       uuid REFERENCES compensation_components(id) ON DELETE SET NULL,
  employee_component_key      text,
  employer_component_key      text,
  employee_contribution_mode  text NOT NULL DEFAULT 'fixed' CHECK (employee_contribution_mode IN ('fixed', 'percentage')),
  employee_contribution_value numeric(14,4) CHECK (employee_contribution_value IS NULL OR employee_contribution_value >= 0),
  employer_contribution_mode  text NOT NULL DEFAULT 'fixed' CHECK (employer_contribution_mode IN ('fixed', 'percentage')),
  employer_contribution_value numeric(14,4) CHECK (employer_contribution_value IS NULL OR employer_contribution_value >= 0),
  min_service_months          integer CHECK (min_service_months IS NULL OR min_service_months >= 0),
  employment_types            text[],
  payroll_area_id             uuid REFERENCES payroll_areas(id) ON DELETE SET NULL,
  effective_from              date NOT NULL,
  effective_to                date,
  status                      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by                  uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT benefit_plans_code UNIQUE (company_id, code),
  CONSTRAINT benefit_plans_dates CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE IF NOT EXISTS benefit_enrolments (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  plan_id                       uuid NOT NULL REFERENCES benefit_plans(id) ON DELETE CASCADE,
  employee_id                   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  status                        text NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled', 'waived', 'ended')),
  coverage_level                text,
  employee_contribution_override numeric(14,4) CHECK (employee_contribution_override IS NULL OR employee_contribution_override >= 0),
  effective_from                date NOT NULL,
  effective_to                  date,
  end_reason                    text,
  enrolled_by                   uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  ended_by                      uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT benefit_enrolments_dates CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_benefit_enrolments_live
  ON benefit_enrolments (plan_id, employee_id) WHERE status = 'enrolled';
CREATE INDEX IF NOT EXISTS idx_benefit_enrolments_employee ON benefit_enrolments (employee_id, status);

CREATE TABLE IF NOT EXISTS benefit_contributions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  enrolment_id     uuid NOT NULL REFERENCES benefit_enrolments(id) ON DELETE CASCADE,
  plan_id          uuid NOT NULL REFERENCES benefit_plans(id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  payroll_run_id   uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  payslip_id       uuid REFERENCES payslips(id) ON DELETE SET NULL,
  period_end       date NOT NULL,
  employee_amount  numeric(14,2) NOT NULL DEFAULT 0,
  employer_amount  numeric(14,2) NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'accrued' CHECK (status IN ('accrued', 'reversed')),
  reversed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT benefit_contributions_once UNIQUE (enrolment_id, payroll_run_id)
);
CREATE INDEX IF NOT EXISTS idx_benefit_contributions_plan ON benefit_contributions (plan_id, period_end DESC);

-- ---------------------------------------------------------------- PAY-26 bulk payroll inputs reuse the LIF-11 batch tables
ALTER TABLE import_batches DROP CONSTRAINT IF EXISTS import_batches_import_type_check;
ALTER TABLE import_batches ADD CONSTRAINT import_batches_import_type_check
  CHECK (import_type IN ('employees', 'payroll_components', 'payroll_payments'));

-- ---------------------------------------------------------------- RLS + grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'payroll_gl_mappings', 'payroll_journal_types', 'payroll_journals', 'payroll_journal_lines', 'payroll_costing_results',
    'payroll_document_settings', 'payroll_document_template_choices', 'generated_documents',
    'benefit_plans', 'benefit_enrolments', 'benefit_contributions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format($p$CREATE POLICY %I ON %I
      USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
      WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())$p$, t || '_all', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_gl_mappings, payroll_journal_types, payroll_document_settings,
  payroll_document_template_choices, benefit_plans, benefit_enrolments TO app_role;
GRANT SELECT, INSERT, UPDATE ON payroll_journals, generated_documents, benefit_contributions TO app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_journal_lines, payroll_costing_results TO app_role;
