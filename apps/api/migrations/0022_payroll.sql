-- Phase 12 — Compensation & Payroll. Plan doc Section 10's own guardrail
-- applies at full force to everything in this file and the service built
-- on top of it: "Payroll's accountant-verification step is not optional
-- polish; it gates going live with real money." Every number this phase
-- calculates is built to be inspected, questioned, and corrected — not
-- trusted blind because it passed a test suite. See Decision #14 for the
-- full design writeup, including exactly which statutory figures below
-- are real-but-unconfirmed research findings rather than a verified
-- primary-source rate.

-- ---------------------------------------------------------------------
-- employee_compensation — the numeric PKR salary Phase 7's `employees`
-- table never actually stored. `salary_band` (0010_employee_core.sql)
-- is a text label (a pay-grade code like "E2"), never a real amount —
-- fine for Phase 7's own purposes, but payroll needs an actual monthly
-- figure to calculate against. Versioned by `effective_from`/
-- `effective_to` (mirroring the general shape, if not the exact
-- mechanics, of `employee_job_history`'s append-only event log) so a
-- mid-period salary change — the plan doc's own named edge case for this
-- phase — has real data to calculate a prorated split against, not a
-- single mutable "current salary" field with no history.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_compensation (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                 uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  monthly_salary              numeric(12,2) NOT NULL CHECK (monthly_salary >= 0),
  effective_from              date NOT NULL,
  -- NULL = still the employee's current rate. PayrollService sets this
  -- on the previous "current" row the moment a new one starts, the same
  -- "supersede, don't overwrite" discipline `leave_policies.is_default`
  -- already established in Phase 8 for a different single-current-row
  -- invariant.
  effective_to                date,
  created_by_user_account_id  uuid NOT NULL REFERENCES user_accounts(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS idx_employee_compensation_employee ON employee_compensation (employee_id, effective_from);

-- ---------------------------------------------------------------------
-- payroll_settings — one row per tenant, the EOBI/social-security rates
-- and bases a payroll calculation reads. Deliberately DATA, not code
-- constants: Decision #14 documents real uncertainty in the current
-- wage-base/ceiling figures for these schemes (they change with the
-- annual minimum-wage notification and provincial rulemaking), so making
-- them tenant-editable, inspectable rows — the same "don't hardcode a
-- business rule that could be legislatively wrong" discipline this
-- codebase has used for tax slabs below, leave policies (Phase 8), and
-- the employee-number format (Section 5) — is what lets a real
-- accountant correct a rate without a code deploy.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payroll_settings (
  company_id                       uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  eobi_employee_rate_percent       numeric(5,2) NOT NULL DEFAULT 1.00,
  eobi_employer_rate_percent       numeric(5,2) NOT NULL DEFAULT 5.00,
  -- EOBI contributions are calculated against the government-notified
  -- minimum wage, NOT the employee's actual salary — see Decision #14.
  -- Defaulted to a researched-but-EOBI-unconfirmed figure.
  eobi_wage_base                   numeric(12,2) NOT NULL DEFAULT 40700.00,
  social_security_scheme           text NOT NULL DEFAULT 'none'
                                     CHECK (social_security_scheme IN ('none', 'pessi', 'sessi')),
  social_security_employer_rate_percent numeric(5,2) NOT NULL DEFAULT 0,
  -- NULL = no ceiling configured (payroll treats every employee as
  -- covered when a scheme is selected). A real per-province ceiling
  -- figure is exactly the kind of number Decision #14 flags as needing
  -- direct confirmation before this table's defaults are trusted.
  social_security_wage_ceiling     numeric(12,2),
  updated_at                       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- tax_slabs — the FBR salaried-individual progressive tax bracket table,
-- per tenant (so one tenant's HR/Finance Admin correcting a rate never
-- touches another tenant's data, and a future non-Pakistan tenant --
-- hypothetically -- wouldn't inherit rates that don't apply to them).
-- `max_annual_income IS NULL` marks the top, uncapped bracket.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tax_slabs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  min_annual_income   numeric(14,2) NOT NULL,
  max_annual_income   numeric(14,2),
  base_tax            numeric(14,2) NOT NULL DEFAULT 0,
  rate_percent        numeric(5,2) NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, min_annual_income),
  CHECK (max_annual_income IS NULL OR max_annual_income > min_annual_income)
);
CREATE INDEX IF NOT EXISTS idx_tax_slabs_company ON tax_slabs (company_id, min_annual_income);

-- ---------------------------------------------------------------------
-- payroll_runs — one tenant-configured pay period. `status` walks
-- forward exactly once, the same non-reversible lifecycle discipline
-- Phase 11's `review_cycles.status` established: draft -> calculated
-- (safe to re-run — a compensation correction before anyone's been paid
-- shouldn't require starting a new run) -> finalized (locked; the
-- numbers become real payslips, visible to employees, and disbursable).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payroll_runs (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_start                date NOT NULL,
  period_end                  date NOT NULL,
  status                      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'calculated', 'finalized')),
  created_by_user_account_id  uuid NOT NULL REFERENCES user_accounts(id),
  finalized_at                timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, period_start, period_end),
  CHECK (period_end >= period_start)
);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_company ON payroll_runs (company_id);

-- ---------------------------------------------------------------------
-- payslips — one row per employee per run, produced by
-- `PayrollService.calculateRun()` and fully REPLACED (not appended to)
-- on every recalculation of a still-`draft`/`calculated` run — see the
-- service's own doc comment. `calculation_breakdown` is the actual
-- answer to this phase's own exit criterion's "every intermediate figure
-- inspectable" requirement: an ordered JSON array of every value the
-- calculation passed through, not just the final numbers this table's
-- own columns hold. `employee_number`/`bank_account_number` are
-- deliberately denormalized snapshots at calculation time — Section 5's
-- own external-interface rule ("the bank disbursement file references
-- employee_number, never the internal UUID") plus a real payroll
-- correctness need: a payslip must keep showing the account it was
-- ACTUALLY disbursed to, even if the employee's bank details change
-- later.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payslips (
  id                                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                              uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_run_id                          uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id                             uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  employee_number                         text NOT NULL,
  bank_account_number                     text,
  days_in_period                          integer NOT NULL,
  paid_days                               numeric(6,2) NOT NULL,
  unpaid_leave_days                       numeric(6,2) NOT NULL DEFAULT 0,
  gross_pay                               numeric(14,2) NOT NULL,
  taxable_annual_income                   numeric(14,2) NOT NULL,
  income_tax_monthly                      numeric(14,2) NOT NULL,
  eobi_employee_contribution              numeric(14,2) NOT NULL,
  eobi_employer_contribution              numeric(14,2) NOT NULL,
  social_security_employer_contribution   numeric(14,2) NOT NULL DEFAULT 0,
  net_pay                                 numeric(14,2) NOT NULL,
  calculation_breakdown                   jsonb NOT NULL,
  created_at                              timestamptz NOT NULL DEFAULT now(),
  updated_at                              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payroll_run_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_payslips_run ON payslips (payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_payslips_employee ON payslips (employee_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON employee_compensation, payroll_settings, tax_slabs, payroll_runs, payslips TO app_role;

ALTER TABLE employee_compensation ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_compensation FORCE ROW LEVEL SECURITY;
ALTER TABLE payroll_settings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_settings      FORCE ROW LEVEL SECURITY;
ALTER TABLE tax_slabs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_slabs             FORCE ROW LEVEL SECURITY;
ALTER TABLE payroll_runs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_runs          FORCE ROW LEVEL SECURITY;
ALTER TABLE payslips              ENABLE ROW LEVEL SECURITY;
ALTER TABLE payslips              FORCE ROW LEVEL SECURITY;

CREATE POLICY employee_compensation_all ON employee_compensation FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY payroll_settings_all ON payroll_settings FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY tax_slabs_all ON tax_slabs FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY payroll_runs_all ON payroll_runs FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY payslips_all ON payslips FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
