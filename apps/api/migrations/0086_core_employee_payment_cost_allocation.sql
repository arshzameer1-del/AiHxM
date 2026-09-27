-- Core Employee Enterprise, Phase 8 — Payment/Bank + Cost Allocation
-- cards (spec Section 6 cards 09/15, Section 39 logical model:
-- `employee_payment_accounts`, `employee_cost_allocations`).
--
-- Compensation (card 08) is NOT a new table here — it deepens the
-- EXISTING `employee_compensation` table (0022_payroll.sql), which
-- already has exactly the shape this phase needs (numeric monthly salary,
-- effective-dated via the shared EffectiveDatingEngine's supersession
-- rule). `PayrollService.setCompensation()` was split into a thin wrapper
-- + `setCompensationWithinTransaction()` (this migration's companion
-- code change), the same transaction-sharing pattern Phase 2 established
-- for EmployeesService — HiringProcessService.complete() calls it
-- directly so a hire's initial salary is set atomically with the
-- employee's own creation, reusing Payroll's real validation
-- (non-negative salary) rather than a parallel INSERT.
--
-- `employee_payment_accounts` — an employee can hold more than one
-- payment method on file over time (a bank account, then a different one
-- after switching banks) but at most one ACTIVE primary at once, the same
-- "one open primary per {employee, ...}" shape 0084's `employee_contacts`
-- already established. `iban`/`account_number` are stored as plain text
-- (not validated against Pakistan's specific IBAN checksum here) —
-- statutory/format validation belongs in a dedicated Field Metadata Model
-- (spec Section 21), not invented ad hoc in this migration.
--
-- `employee_cost_allocations` — split costing across Organization
-- Management's existing `cost_centers` (0073_locations_and_financial_centers.sql),
-- never a new parallel cost-center catalog. Multiple OPEN rows per
-- employee are normal here (unlike Payment/Bank/Addresses) — split
-- costing across several cost centers at once is the whole point of the
-- card ("Primary and split costing across cost centers"), so there is
-- deliberately NO one-row-per-employee unique index; the application
-- layer (EmployeeCostAllocationsService) is what checks percentages sum
-- to 100, not a DB constraint (a partial INSERT mid-edit legitimately
-- doesn't sum to 100 yet).
CREATE TABLE IF NOT EXISTS employee_payment_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  payment_method  text NOT NULL CHECK (payment_method IN ('bank_transfer', 'cash', 'cheque')),
  bank_name       text,
  account_title   text,
  account_number  text,
  iban            text,
  branch_code     text,
  is_primary      boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_payment_accounts_company ON employee_payment_accounts (company_id);
CREATE INDEX IF NOT EXISTS idx_employee_payment_accounts_employee ON employee_payment_accounts (employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_payment_accounts_one_primary
  ON employee_payment_accounts (employee_id) WHERE is_primary AND status = 'active';

CREATE TABLE IF NOT EXISTS employee_cost_allocations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id           uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  cost_center_id        uuid NOT NULL REFERENCES cost_centers(id) ON DELETE RESTRICT,
  allocation_percentage numeric(5,2) NOT NULL CHECK (allocation_percentage > 0 AND allocation_percentage <= 100),
  is_primary            boolean NOT NULL DEFAULT false,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_cost_allocations_company ON employee_cost_allocations (company_id);
CREATE INDEX IF NOT EXISTS idx_employee_cost_allocations_employee ON employee_cost_allocations (employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_cost_allocations_cost_center ON employee_cost_allocations (cost_center_id);
-- At most one OPEN allocation per {employee, cost center} — an employee
-- can be allocated to the same cost center only once at a time; re-adding
-- it after ending the old row is fine (a fresh row, no conflict with the
-- now-`ended` one, unlike a plain UNIQUE(employee_id, cost_center_id,
-- status) would wrongly produce on a SECOND end of the same pair).
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_cost_allocations_one_open_per_cost_center
  ON employee_cost_allocations (employee_id, cost_center_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_cost_allocations_one_primary
  ON employee_cost_allocations (employee_id) WHERE is_primary AND status = 'active';

GRANT SELECT, INSERT, UPDATE ON employee_payment_accounts, employee_cost_allocations TO app_role;

ALTER TABLE employee_payment_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_payment_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE employee_cost_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_cost_allocations FORCE ROW LEVEL SECURITY;

CREATE POLICY employee_payment_accounts_select ON employee_payment_accounts FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_payment_accounts_insert ON employee_payment_accounts FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_payment_accounts_update ON employee_payment_accounts FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY employee_cost_allocations_select ON employee_cost_allocations FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_cost_allocations_insert ON employee_cost_allocations FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_cost_allocations_update ON employee_cost_allocations FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
