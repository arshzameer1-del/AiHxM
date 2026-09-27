-- Payroll Enterprise Gap Analysis & Roadmap (claude/payroll-enterprise-
-- gap-analysis-and-roadmap.md), Phase P1 — "compensation & calculation
-- correctness". Two structural changes:
--
--  1. Replaces the single flat `employee_compensation.monthly_salary`
--     figure with a real component model — a per-tenant catalog
--     (`compensation_components`: Basic Salary + named allowances) and a
--     per-employee, per-component, effective-dated amount
--     (`employee_compensation_components`). `employee_compensation`
--     itself is NOT dropped or altered — the master instruction doc's
--     own migration discipline (Section 47: "do not destroy existing
--     payroll history... keep legacy values during migration until
--     consumers move") applies directly. It becomes a frozen historical
--     record; every new read/write goes through the tables below, and
--     every existing generation of every employee's salary is backfilled
--     into the new tables as their "Basic Salary" component so nothing
--     needs re-entering.
--
--  2. Converts `payroll_settings` from a single mutable row per tenant
--     into an effective-dated row per tenant — the same shape
--     `tax_slabs` already had before 0033_effective_dating_leave_tax.sql
--     — so a payroll run can resolve the EOBI/social-security rates that
--     were actually in force during ITS OWN period, not "whatever is
--     current right now" (`PayrollService.loadSettingsAsOf()` is the
--     read-side half of this; `loadTaxSlabsAsOf()` is the equivalent for
--     `tax_slabs`, which needed no schema change since it was already
--     effective-dated).
--
-- Also adds `payslips.taxable_gross_this_period` — the ACTUAL (not
-- annualized) taxable earnings for one period, which real year-to-date
-- tax accumulation needs to sum across a tax year's finalized runs (see
-- PayrollService.calculateOnePayslip()'s own doc comment for the method).

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- ---------------------------------------------------------------------
-- compensation_components — the catalog of earning components a tenant
-- pays against. Pure identity/config, not itself effective-dated — only
-- the per-employee AMOUNT assigned against a component (below) needs a
-- history; renaming an allowance or flipping its taxable flag going
-- forward doesn't need to preserve what it used to be called.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS compensation_components (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key           text NOT NULL,
  name          text NOT NULL,
  is_taxable    boolean NOT NULL DEFAULT true,
  is_active     boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, key)
);
CREATE INDEX IF NOT EXISTS idx_compensation_components_company ON compensation_components (company_id, sort_order);

-- ---------------------------------------------------------------------
-- employee_compensation_components — one effective-dated amount per
-- (employee, component). Mirrors `employee_compensation`'s own shape
-- exactly, just scoped one level deeper: an employee now has a SET of
-- these (one per component they're paid), each independently versioned
-- via the shared EffectiveDatingEngine's `applyVersionedRow`, rather than
-- one row for their whole salary.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_compensation_components (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                 uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  component_id                uuid NOT NULL REFERENCES compensation_components(id) ON DELETE CASCADE,
  amount                      numeric(12,2) NOT NULL CHECK (amount >= 0),
  effective_from              date NOT NULL,
  effective_to                date,
  created_by_user_account_id  uuid NOT NULL REFERENCES user_accounts(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS idx_employee_comp_components_employee ON employee_compensation_components (employee_id, effective_from);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_comp_components_one_open
  ON employee_compensation_components (employee_id, component_id) WHERE effective_to IS NULL;

-- Seed the standard component catalog for every existing company. All
-- marked taxable by default — deliberately NOT presuming any allowance
-- is tax-exempt (see claude/statutory-payroll-rates-pakistan.md's own
-- caution about not inventing statutory treatment without a real
-- source); a tenant's own accountant can flip is_taxable per component
-- if a specific exemption genuinely applies to it.
INSERT INTO compensation_components (company_id, key, name, is_taxable, sort_order)
SELECT c.id, v.key, v.name, true, v.sort_order
FROM companies c
CROSS JOIN (VALUES
  ('basic_salary', 'Basic Salary', 0),
  ('house_rent_allowance', 'House Rent Allowance', 1),
  ('medical_allowance', 'Medical Allowance', 2),
  ('conveyance_allowance', 'Conveyance Allowance', 3),
  ('utilities_allowance', 'Utilities Allowance', 4),
  ('other_allowance', 'Other Allowance', 5)
) AS v(key, name, sort_order)
ON CONFLICT (company_id, key) DO NOTHING;

-- Backfill: every existing employee_compensation row (every generation,
-- not just the current one) becomes a Basic Salary component row with
-- the identical amount/effective window — every employee who already
-- has a salary keeps calculating correctly the moment this migration
-- runs, with zero HR action required.
INSERT INTO employee_compensation_components
  (company_id, employee_id, component_id, amount, effective_from, effective_to, created_by_user_account_id, created_at)
SELECT ec.company_id, ec.employee_id, cc.id, ec.monthly_salary, ec.effective_from, ec.effective_to, ec.created_by_user_account_id, ec.created_at
FROM employee_compensation ec
JOIN compensation_components cc ON cc.company_id = ec.company_id AND cc.key = 'basic_salary';

GRANT SELECT, INSERT, UPDATE, DELETE ON compensation_components, employee_compensation_components TO app_role;
ALTER TABLE compensation_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE compensation_components FORCE ROW LEVEL SECURITY;
ALTER TABLE employee_compensation_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_compensation_components FORCE ROW LEVEL SECURITY;
CREATE POLICY compensation_components_all ON compensation_components FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_compensation_components_all ON employee_compensation_components FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

-- ---------------------------------------------------------------------
-- payroll_settings — converted from a single mutable row per tenant into
-- an effective-dated row per tenant. `id` becomes the primary key
-- (company_id can no longer be unique on its own once a tenant can have
-- more than one generation); a partial unique index enforces "at most
-- one OPEN generation per tenant", the same invariant every other
-- applyVersionedRow-backed table uses.
-- ---------------------------------------------------------------------
ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();
UPDATE payroll_settings SET id = gen_random_uuid() WHERE id IS NULL;
ALTER TABLE payroll_settings ALTER COLUMN id SET NOT NULL;
ALTER TABLE payroll_settings DROP CONSTRAINT IF EXISTS payroll_settings_pkey;
ALTER TABLE payroll_settings ADD PRIMARY KEY (id);

ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS effective_from date;
ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS effective_to date;
-- Every tenant's existing settings row becomes its first, still-open
-- generation, effective from far enough in the past to cover any
-- historical payroll run this tenant has ever created.
UPDATE payroll_settings SET effective_from = '2000-01-01' WHERE effective_from IS NULL;
ALTER TABLE payroll_settings ALTER COLUMN effective_from SET NOT NULL;
ALTER TABLE payroll_settings ADD CONSTRAINT payroll_settings_effective_range_check
  CHECK (effective_to IS NULL OR effective_to >= effective_from);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_settings_one_open
  ON payroll_settings (company_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_payroll_settings_company_effective
  ON payroll_settings (company_id, effective_from);

-- ---------------------------------------------------------------------
-- payslips — add the actual (non-annualized) taxable earnings for the
-- period. `taxable_annual_income` is kept (same column, same name) but
-- now holds the cumulative-method's ESTIMATED full tax-year figure
-- (year-to-date actual + this period + a projection of the remaining
-- tax-year days), not a naive `thisPeriodGross * 12` — see
-- PayrollService.calculateOnePayslip()'s own doc comment.
-- ---------------------------------------------------------------------
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS taxable_gross_this_period numeric(14,2);
UPDATE payslips SET taxable_gross_this_period = ROUND(taxable_annual_income / 12, 2) WHERE taxable_gross_this_period IS NULL;
ALTER TABLE payslips ALTER COLUMN taxable_gross_this_period SET NOT NULL;
ALTER TABLE payslips ALTER COLUMN taxable_gross_this_period SET DEFAULT 0;
