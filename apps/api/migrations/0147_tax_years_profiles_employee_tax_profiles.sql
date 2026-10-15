SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- 0147 - Step 9F: tax structure and employee tax profiles (gap register PAY-09, PAY-10).
--   * tax_years            : a tenant's tax years (start/end, jurisdiction) with publication status and evidence.
--   * tax_profiles         : the rule set of one tax year for one kind of taxpayer - rounding, surcharge threshold and rate,
--                            status, source reference, approver. Its slabs live in tax_profile_slabs.
--   * tax_profile_slabs    : the bracket table of a profile (kept apart from the legacy company-wide `tax_slabs` so the
--                            existing effective-dated flow is untouched).
--   * tax_exemptions       : exemptions an employee of the profile may claim (annual cap or percentage of income).
--   * tax_credits          : credits that reduce the computed tax (fixed or percentage of a claimed amount, annual cap).
--   * tax_slabs            : gains the tax year, status and evidence columns; every existing row is 'published'.
--   * payroll_formulas     : the three-key CHECK is relaxed to a key-format CHECK; the code registry
--                            (PAYROLL_FORMULA_CONTRACT) decides which keys the API accepts, so a new formula key needs no DDL.
--   * employee_tax_profiles: effective-dated filer status, residency, provincial scheme, claimed exemptions and credits,
--                            previous-employer income and tax. Registration numbers (NTN, EOBI, SESSI/PESSI) belong to
--                            `employee_external_ids` (EMP-18) and are not duplicated here.
-- NO statutory figure is seeded: years, profiles, slabs, exemptions and credits are entered and published by the tenant
-- with a source reference. A profile is used by the payroll only when it is published (or later retired).
--
-- ROLLBACK (additive):
--   DROP TABLE IF EXISTS employee_tax_profiles, tax_credits, tax_exemptions, tax_profile_slabs, tax_profiles, tax_years;
--   ALTER TABLE tax_slabs DROP COLUMN IF EXISTS tax_year_id, DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS source_reference,
--     DROP COLUMN IF EXISTS approved_by, DROP COLUMN IF EXISTS approved_at;
--   ALTER TABLE payroll_formulas DROP CONSTRAINT IF EXISTS payroll_formulas_formula_key_format_check;
--   ALTER TABLE payroll_formulas ADD CONSTRAINT payroll_formulas_formula_key_check
--     CHECK (formula_key IN ('income_tax','eobi_employee','eobi_employer'));

CREATE TABLE IF NOT EXISTS tax_years (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  label            text NOT NULL CHECK (label ~ '^[A-Za-z0-9][A-Za-z0-9 _./-]{0,29}$'),
  jurisdiction     text NOT NULL DEFAULT 'PK' CHECK (jurisdiction ~ '^[A-Z]{2}$'),
  start_date       date NOT NULL,
  end_date         date NOT NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  source_reference text,
  approved_by      uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  approved_at      timestamptz,
  notes            text,
  created_by       uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date > start_date),
  CHECK (status = 'draft' OR (source_reference IS NOT NULL AND approved_at IS NOT NULL)),
  UNIQUE (company_id, jurisdiction, label)
);
-- a published tax year may not overlap another live one of the same jurisdiction
ALTER TABLE tax_years DROP CONSTRAINT IF EXISTS tax_years_no_overlap;
ALTER TABLE tax_years ADD CONSTRAINT tax_years_no_overlap
  EXCLUDE USING gist (company_id WITH =, jurisdiction WITH =, daterange(start_date, end_date, '[]') WITH &&) WHERE (status = 'published');

CREATE TABLE IF NOT EXISTS tax_profiles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tax_year_id         uuid NOT NULL REFERENCES tax_years(id) ON DELETE CASCADE,
  code                text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name                text NOT NULL,
  description         text,
  rounding_mode       text NOT NULL DEFAULT 'none' CHECK (rounding_mode IN ('none', 'nearest', 'up', 'down')),
  rounding_increment  numeric(10,2) NOT NULL DEFAULT 1 CHECK (rounding_increment > 0),
  surcharge_threshold numeric(14,2) CHECK (surcharge_threshold IS NULL OR surcharge_threshold >= 0),
  surcharge_rate_percent numeric(6,2) CHECK (surcharge_rate_percent IS NULL OR (surcharge_rate_percent >= 0 AND surcharge_rate_percent <= 100)),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  source_reference    text,
  approved_by         uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  approved_at         timestamptz,
  created_by          uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'draft' OR (source_reference IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK ((surcharge_threshold IS NULL) = (surcharge_rate_percent IS NULL)),
  UNIQUE (company_id, tax_year_id, code)
);
CREATE INDEX IF NOT EXISTS tax_profiles_year_idx ON tax_profiles (tax_year_id);

CREATE TABLE IF NOT EXISTS tax_profile_slabs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tax_profile_id    uuid NOT NULL REFERENCES tax_profiles(id) ON DELETE CASCADE,
  min_annual_income numeric(14,2) NOT NULL CHECK (min_annual_income >= 0),
  max_annual_income numeric(14,2),
  base_tax          numeric(14,2) NOT NULL DEFAULT 0 CHECK (base_tax >= 0),
  rate_percent      numeric(5,2) NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 100),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (max_annual_income IS NULL OR max_annual_income > min_annual_income),
  UNIQUE (tax_profile_id, min_annual_income)
);

CREATE TABLE IF NOT EXISTS tax_exemptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tax_profile_id     uuid NOT NULL REFERENCES tax_profiles(id) ON DELETE CASCADE,
  code               text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name               text NOT NULL,
  exemption_type     text NOT NULL CHECK (exemption_type IN ('fixed_amount', 'percentage_of_income')),
  annual_cap         numeric(14,2) CHECK (annual_cap IS NULL OR annual_cap >= 0),
  rate_percent       numeric(6,2) CHECK (rate_percent IS NULL OR (rate_percent >= 0 AND rate_percent <= 100)),
  requires_evidence  boolean NOT NULL DEFAULT false,
  source_reference   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (exemption_type <> 'percentage_of_income' OR rate_percent IS NOT NULL),
  UNIQUE (tax_profile_id, code)
);

CREATE TABLE IF NOT EXISTS tax_credits (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tax_profile_id     uuid NOT NULL REFERENCES tax_profiles(id) ON DELETE CASCADE,
  code               text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name               text NOT NULL,
  credit_type        text NOT NULL CHECK (credit_type IN ('fixed_amount', 'percentage_of_amount')),
  annual_cap         numeric(14,2) CHECK (annual_cap IS NULL OR annual_cap >= 0),
  rate_percent       numeric(6,2) CHECK (rate_percent IS NULL OR (rate_percent >= 0 AND rate_percent <= 100)),
  requires_evidence  boolean NOT NULL DEFAULT false,
  source_reference   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (credit_type <> 'percentage_of_amount' OR rate_percent IS NOT NULL),
  UNIQUE (tax_profile_id, code)
);

ALTER TABLE tax_slabs
  ADD COLUMN IF NOT EXISTS tax_year_id uuid REFERENCES tax_years(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'retired')),
  ADD COLUMN IF NOT EXISTS source_reference text,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

ALTER TABLE payroll_formulas DROP CONSTRAINT IF EXISTS payroll_formulas_formula_key_check;
ALTER TABLE payroll_formulas DROP CONSTRAINT IF EXISTS payroll_formulas_formula_key_format_check;
ALTER TABLE payroll_formulas ADD CONSTRAINT payroll_formulas_formula_key_format_check CHECK (formula_key ~ '^[a-z][a-z0-9_]{1,59}$');

CREATE TABLE IF NOT EXISTS employee_tax_profiles (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                 uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  tax_profile_id              uuid REFERENCES tax_profiles(id) ON DELETE RESTRICT,
  filer_status                text NOT NULL DEFAULT 'filer' CHECK (filer_status IN ('filer', 'non_filer', 'late_filer', 'not_applicable')),
  tax_residency               text NOT NULL DEFAULT 'resident' CHECK (tax_residency IN ('resident', 'non_resident')),
  provincial_scheme           text CHECK (provincial_scheme IS NULL OR provincial_scheme IN ('none', 'pessi', 'sessi', 'bessi', 'other')),
  -- [{ "exemptionId": uuid, "amount": number, "evidenceRef": text|null }]  /  [{ "creditId": uuid, "amount": number, "evidenceRef": text|null }]
  claimed_exemptions          jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(claimed_exemptions) = 'array'),
  claimed_credits             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(claimed_credits) = 'array'),
  previous_employer_income    numeric(14,2) NOT NULL DEFAULT 0 CHECK (previous_employer_income >= 0),
  previous_employer_tax       numeric(14,2) NOT NULL DEFAULT 0 CHECK (previous_employer_tax >= 0),
  -- the tax year (labelled by its ending year, as the payroll labels it) the previous-employer figures belong to
  previous_employer_tax_year  integer,
  notes                       text,
  change_reason_note          text,
  effective_from              date NOT NULL,
  effective_to                date,
  created_by                  uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK ((previous_employer_income = 0 AND previous_employer_tax = 0) OR previous_employer_tax_year IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS employee_tax_profiles_one_open ON employee_tax_profiles (employee_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS employee_tax_profiles_company_idx ON employee_tax_profiles (company_id, effective_from);
ALTER TABLE employee_tax_profiles DROP CONSTRAINT IF EXISTS employee_tax_profiles_no_overlap;
ALTER TABLE employee_tax_profiles ADD CONSTRAINT employee_tax_profiles_no_overlap
  EXCLUDE USING gist (employee_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tax_years', 'tax_profiles', 'tax_profile_slabs', 'tax_exemptions', 'tax_credits', 'employee_tax_profiles'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())', t || '_all', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_role', t);
  END LOOP;
END $$;
