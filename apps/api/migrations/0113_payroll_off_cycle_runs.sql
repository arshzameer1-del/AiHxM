-- Payroll Enterprise Gap Analysis, Phase P4 (claude/payroll-enterprise-
-- gap-analysis-and-roadmap.md): "Off-cycle & final settlement."
--
-- TWO CHANGES:
--
-- 1. `payroll_runs` gains `run_type` ('regular' | 'off_cycle', default
--    'regular' — every existing run keeps today's behavior unchanged),
--    `off_cycle_reason` ('bonus' | 'arrears' | 'final_settlement' |
--    'other', set iff run_type = 'off_cycle') and `target_employee_id`
--    (set iff this off-cycle run targets exactly one employee — always
--    set for 'final_settlement', optional for a single-employee bonus/
--    arrears run, null for a batch bonus/arrears run). The single-
--    active-run-per-{period, payroll area} unique index (0101) is
--    narrowed to `AND run_type = 'regular'` — an off-cycle run (bonus,
--    arrears, final settlement, however many of them) may now freely
--    coexist with a regular run, or with each other, covering the exact
--    same period. PayrollService.createRun()/calculateRun() enforce
--    everything this index can't express (off_cycle_reason required iff
--    off_cycle; final_settlement requires a terminated target employee
--    whose termination_date falls inside the run's own period, and at
--    most one non-reversed final_settlement run ever, per employee).
--
-- 2. `employee_offcycle_payments` — the SAP IT0267 equivalent:
--    `employee_additional_payments` (IT0015, Phase P3)'s sibling for a
--    one-time earning/deduction tied to a SPECIFIC off-cycle
--    `payroll_run_id`, fixed at creation (unlike IT0015's date-range
--    matching, there is no ambiguity about which run consumes it, so no
--    "consumed by which run" lookup is needed — it already points at
--    the one run that will). Core-Employee-owned, identical permission
--    posture (`employee.manage.all` / `employee.view`). This is how HR
--    enters a bonus figure, an arrears amount, or a final-settlement
--    line (gratuity, leave encashment) against the off-cycle run that
--    will pay it — this platform does NOT compute gratuity or leave-
--    encashment from a statutory formula; HR enters the amount they've
--    already worked out, the same "don't presume a tax/statutory
--    treatment absent an accountant's say" posture 0112's own header
--    comment (and this file's class doc comment) takes everywhere else
--    in Payroll. `status` moves `pending` -> `consumed` only when
--    PayrollService.finalizeRun() finalizes the ONE run it's scoped to
--    (never any other run), or `pending` -> `cancelled` via HR's own
--    undo before that happens — identical lifecycle to IT0015.
--
-- `payslips` gains a third structured preview/commit column,
-- `consumed_offcycle_payments`, same shape and same "preview at
-- calculate(), commit at finalize()" discipline as `loan_deductions` /
-- `consumed_additional_payments` (0112).

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE payslips ADD COLUMN IF NOT EXISTS consumed_offcycle_payments jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS run_type text NOT NULL DEFAULT 'regular'
  CHECK (run_type IN ('regular', 'off_cycle'));
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS off_cycle_reason text
  CHECK (off_cycle_reason IN ('bonus', 'arrears', 'final_settlement', 'other'));
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS target_employee_id uuid REFERENCES employees(id);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_target_employee ON payroll_runs (target_employee_id) WHERE target_employee_id IS NOT NULL;
-- Enforced at the application layer (createRun()) rather than a CHECK
-- constraint: "off_cycle_reason required iff run_type = 'off_cycle'" is
-- expressible as a CHECK, but "target_employee_id required iff
-- off_cycle_reason = 'final_settlement'" plus "at most one non-reversed
-- final_settlement run per employee" are not (the latter genuinely needs
-- a partial unique index, added below; the former is cheap enough as an
-- application check that a second partial index isn't worth it).
ALTER TABLE payroll_runs ADD CONSTRAINT payroll_runs_off_cycle_reason_requires_type
  CHECK (off_cycle_reason IS NULL OR run_type = 'off_cycle');

-- At most one non-reversed 'final_settlement' run per target employee —
-- an employee is only ever settled once. A NULL target_employee_id never
-- matches another NULL under a unique index, which is fine here: a
-- final_settlement run with no target employee is already rejected by
-- createRun() itself (it's the one off_cycle_reason that MUST target
-- exactly one employee), so this index only ever has non-null rows to
-- compare in practice.
CREATE UNIQUE INDEX IF NOT EXISTS payroll_runs_one_final_settlement_per_employee
  ON payroll_runs (target_employee_id)
  WHERE off_cycle_reason = 'final_settlement' AND status <> 'reversed';

-- Narrow the existing single-active-run-per-{period, payroll area} index
-- (0101) to regular runs only — an off-cycle run must never be blocked
-- by, or block, this uniqueness rule.
DROP INDEX IF EXISTS payroll_runs_active_period_key;
CREATE UNIQUE INDEX payroll_runs_active_period_key
  ON payroll_runs (company_id, period_start, period_end, COALESCE(payroll_area_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status <> 'reversed' AND run_type = 'regular';

-- ---------------------------------------------------------------------
-- employee_offcycle_payments — IT0267 equivalent: a one-time earning or
-- deduction tied to a specific off-cycle payroll run.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_offcycle_payments (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                 uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  payroll_run_id              uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  payment_type                text NOT NULL CHECK (payment_type IN ('earning', 'deduction')),
  label                       text NOT NULL,
  amount                      numeric(12,2) NOT NULL CHECK (amount > 0),
  is_taxable                  boolean NOT NULL DEFAULT true,
  status                      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'cancelled')),
  created_by_user_account_id  uuid NOT NULL REFERENCES user_accounts(id),
  created_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_offcycle_payments_run ON employee_offcycle_payments (payroll_run_id, status);
CREATE INDEX IF NOT EXISTS idx_employee_offcycle_payments_employee ON employee_offcycle_payments (employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_offcycle_payments_company ON employee_offcycle_payments (company_id, status);

GRANT SELECT, INSERT, UPDATE ON employee_offcycle_payments TO app_role;
ALTER TABLE employee_offcycle_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_offcycle_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_offcycle_payments_select ON employee_offcycle_payments FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_offcycle_payments_insert ON employee_offcycle_payments FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_offcycle_payments_update ON employee_offcycle_payments FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
