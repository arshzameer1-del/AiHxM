-- Payroll Formula Engine (2026-10-01): tenant-configurable, effective-dated
-- OVERRIDES for the three already-parameterized calculations inside
-- PayrollService.calculateOnePayslip():
--
--   income_tax     -- this period's income tax withholding
--   eobi_employee  -- EOBI employee contribution (deducted from net pay)
--   eobi_employer  -- EOBI employer contribution
--
-- `expression` is a JSON expression tree in FormulaExpressionEngine's
-- grammar (apps/api/src/payroll/formula-expression.engine.ts) -- plain
-- data, walked by a fixed operator set, never eval'd or parsed as text.
-- The variables each key's expression may reference are a fixed, documented
-- contract (PAYROLL_FORMULA_CONTEXT in payroll-formula.service.ts) and are
-- checked when an override is saved.
--
-- Zero-risk by construction: a tenant with no row here for a key (every
-- tenant, on the day this ships) gets the existing hardcoded calculation,
-- byte-for-byte. A row only ever REPLACES that one figure, for payroll
-- runs whose period_end falls inside [effective_from, effective_to] --
-- the same "resolve as of the run's own periodEnd" rule payroll_settings
-- and tax_slabs already follow (loadSettingsAsOf()/loadTaxSlabsAsOf()).
--
-- Effective-dating shape: ONE open row per (company_id, formula_key),
-- versioned with the shared EffectiveDatingEngine.applyVersionedRow() --
-- the same single-row supersession payroll_settings uses -- so the same
-- invariants are enforced the same way: a range CHECK, and a partial
-- unique index allowing at most one open row per scope. Non-overlap of
-- CLOSED generations is enforced by PayrollFormulaOverridesService (the
-- same application-level guarantee every other effective-dated table in
-- this schema relies on).
--
-- No new permission: overrides are managed under `payroll.calculate.all`,
-- the exact permission that already gates payroll_settings and tax_slabs
-- (PayrollService.requirePayrollCalculate()).

CREATE TABLE IF NOT EXISTS payroll_formulas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  formula_key     text NOT NULL CHECK (formula_key IN ('income_tax', 'eobi_employee', 'eobi_employer')),
  expression      jsonb NOT NULL CHECK (jsonb_typeof(expression) = 'object'),
  effective_from  date NOT NULL,
  effective_to    date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_formulas_effective_range_check CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_formulas_one_open
  ON payroll_formulas (company_id, formula_key) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_payroll_formulas_company_effective
  ON payroll_formulas (company_id, formula_key, effective_from);

GRANT SELECT, INSERT, UPDATE ON payroll_formulas TO app_role;

ALTER TABLE payroll_formulas ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_formulas FORCE ROW LEVEL SECURITY;

CREATE POLICY payroll_formulas_all ON payroll_formulas FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
