-- Payroll Enterprise Gap Analysis, Phase P3 (claude/payroll-enterprise-
-- gap-analysis-and-roadmap.md): "real inputs — overtime, attendance,
-- benefits, loans" (overtime/attendance already wired, see the
-- cross-module integration audit). This migration closes the remaining
-- two: Benefits-style recurring deductions, and Loans/Salary Advances;
-- plus the IT0015-equivalent "Additional Payments" the same section's
-- Section 6 (2026-09-27) scoped as Core-Employee-owned, consumed
-- read-only by Payroll — the same ownership model `0092_payroll_
-- component_compensation.sql`'s own header comment established for
-- recurring compensation.
--
-- THREE CHANGES:
--
-- 1. `compensation_components.component_type` ('earning' | 'deduction',
--    default 'earning' — every existing row keeps today's behavior
--    unchanged). "Benefits" (a health-insurance premium, a society
--    membership fee, ...) is modeled as a DEDUCTION-type recurring
--    component rather than a new Benefits-enrollment module — it reuses
--    the exact same per-employee, effective-dated amount engine
--    (`employee_compensation_components`) recurring earnings already
--    use, which is the whole point of building that engine generically
--    in Phase P1. A deduction component is deliberately never taxable
--    (enforced in EmployeeCompensationService, not here) — it reduces
--    NET pay, never gross/taxable gross, the simplest and safest
--    position absent a specific statutory pre-tax-deduction rule to
--    model (same "don't presume a tax treatment without an accountant"
--    posture Phase P1's own header comment already took for allowances).
--
-- 2. `employee_loans` + `employee_loan_repayments` — Core-Employee-owned
--    (gated by `employee.manage.all`/`employee.view`, the same
--    permission every other Core Employee sub-entity uses — no new
--    permission). One row per loan or salary advance (`loan_type`
--    distinguishes them; they are modeled identically otherwise — both
--    are "give money now, recover via fixed payroll installments," the
--    same way SAP's own IT0045 treats them as one infotype). Payroll
--    reads `employee_loans` directly (same "cross-module reads go
--    straight to SQL" rule 0092 established) to PREVIEW this period's
--    installment deduction at calculate() time — calculate is
--    repeatable/overwriteable, so nothing is mutated yet. Only at
--    FINALIZE time does PayrollService write an `employee_loan_repayments`
--    ledger row and decrement `outstanding_balance` (auto-closing the
--    loan at zero) — mirroring exactly how `0104_employee_job_history_
--    position_assignment_event.sql`'s "only on commit, not on every
--    recalculation" posture already works elsewhere in this codebase.
--
-- 3. `employee_additional_payments` — the IT0015-equivalent: a one-time
--    earning or deduction tied to a specific `effective_date`, not a
--    recurring component and not tied to any one payroll run in advance
--    (the IT0267 off-cycle-run-scoped sibling is Phase P4, not this
--    migration). Payroll matches a payslip's period window against
--    `effective_date` the same way it already matches unpaid-leave date
--    ranges — no "consumed" flag is needed for the same reason unpaid
--    leave doesn't need one: this codebase's existing convention is that
--    payroll run periods don't overlap, so a given date is only ever
--    inside one run's window.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- Two more JSONB columns on `payslips` itself, same shape as its existing
-- `calculation_breakdown` — exactly what `calculateOnePayslip()` computed
-- as PREVIEWS at calculate() time (`[{loanId, amount}]` /
-- `[{additionalPaymentId, amount}]`), read back by `finalizeRun()` to
-- know exactly which loan/additional-payment rows to commit against —
-- without this, finalize would have to re-derive "which loan deduction
-- equals this payslip's figure" from the breakdown's free-text labels,
-- which is fragile. Both default to an empty array so every pre-existing
-- payslip (and every one calculated before this phase existed) reads
-- back as "nothing to commit," unchanged behavior.
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS loan_deductions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS consumed_additional_payments jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE compensation_components
  ADD COLUMN IF NOT EXISTS component_type text NOT NULL DEFAULT 'earning'
    CHECK (component_type IN ('earning', 'deduction'));

-- ---------------------------------------------------------------------
-- employee_loans — a loan or salary advance issued to an employee,
-- recovered via a fixed per-period installment until paid off.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_loans (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                 uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  loan_type                   text NOT NULL CHECK (loan_type IN ('loan', 'salary_advance')),
  reason                      text,
  principal_amount            numeric(12,2) NOT NULL CHECK (principal_amount > 0),
  installment_amount          numeric(12,2) NOT NULL CHECK (installment_amount > 0),
  outstanding_balance         numeric(12,2) NOT NULL CHECK (outstanding_balance >= 0),
  status                      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'cancelled')),
  issued_date                 date NOT NULL,
  created_by_user_account_id  uuid NOT NULL REFERENCES user_accounts(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_loans_employee ON employee_loans (employee_id, status);
CREATE INDEX IF NOT EXISTS idx_employee_loans_company ON employee_loans (company_id, status);

GRANT SELECT, INSERT, UPDATE ON employee_loans TO app_role;
ALTER TABLE employee_loans ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_loans FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_loans_select ON employee_loans FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_loans_insert ON employee_loans FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_loans_update ON employee_loans FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

-- ---------------------------------------------------------------------
-- employee_loan_repayments — the ledger: one row per FINALIZED payslip
-- that deducted a loan installment. Written by PayrollService.finalizeRun(),
-- never by calculate() (see this migration's own header comment).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_loan_repayments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  loan_id           uuid NOT NULL REFERENCES employee_loans(id) ON DELETE CASCADE,
  payroll_run_id    uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  payslip_id        uuid NOT NULL REFERENCES payslips(id) ON DELETE CASCADE,
  amount            numeric(12,2) NOT NULL CHECK (amount > 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, payslip_id)
);
CREATE INDEX IF NOT EXISTS idx_employee_loan_repayments_loan ON employee_loan_repayments (loan_id);

GRANT SELECT, INSERT ON employee_loan_repayments TO app_role;
ALTER TABLE employee_loan_repayments ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_loan_repayments FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_loan_repayments_select ON employee_loan_repayments FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_loan_repayments_insert ON employee_loan_repayments FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

-- ---------------------------------------------------------------------
-- employee_additional_payments — IT0015 equivalent: a one-time earning
-- or deduction tied to a specific date.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_additional_payments (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                 uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  payment_type                text NOT NULL CHECK (payment_type IN ('earning', 'deduction')),
  label                       text NOT NULL,
  amount                      numeric(12,2) NOT NULL CHECK (amount > 0),
  is_taxable                  boolean NOT NULL DEFAULT true,
  effective_date              date NOT NULL,
  status                      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'cancelled')),
  consumed_payroll_run_id     uuid REFERENCES payroll_runs(id),
  created_by_user_account_id  uuid NOT NULL REFERENCES user_accounts(id),
  created_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_additional_payments_employee ON employee_additional_payments (employee_id, effective_date);
CREATE INDEX IF NOT EXISTS idx_employee_additional_payments_company ON employee_additional_payments (company_id, status);

GRANT SELECT, INSERT, UPDATE ON employee_additional_payments TO app_role;
ALTER TABLE employee_additional_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_additional_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_additional_payments_select ON employee_additional_payments FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_additional_payments_insert ON employee_additional_payments FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_additional_payments_update ON employee_additional_payments FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
