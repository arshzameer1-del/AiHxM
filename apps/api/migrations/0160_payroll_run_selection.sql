-- Payroll run selection (SAP payroll driver "Selection": personnel numbers, payroll areas, employee groups).
-- A run may now pay only a chosen subset of the people it covers. The chosen values are kept on the run so the
-- calculation, the pre-validation and the population snapshot all read the same selection:
--   { "employeeIds": [...], "payrollAreaIds": [...], "employeeGroupIds": [...], "groupMemberIds": [...] }
-- NULL = the run pays everyone it covers (every run created before this migration).
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS selection jsonb;
ALTER TABLE payroll_runs DROP CONSTRAINT IF EXISTS payroll_runs_selection_is_object;
ALTER TABLE payroll_runs ADD CONSTRAINT payroll_runs_selection_is_object CHECK (selection IS NULL OR jsonb_typeof(selection) = 'object');

-- Several partial runs may exist for the same period (each pays its own people). The "one regular run per period and
-- area" rule still applies to runs that pay everyone; a partial run never pays an employee a second time because the
-- calculation refuses anyone another regular run of the same period has already paid (duplicate_payment).
DROP INDEX IF EXISTS payroll_runs_active_period_key;
CREATE UNIQUE INDEX payroll_runs_active_period_key
  ON payroll_runs (company_id, period_start, period_end, COALESCE(payroll_area_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status NOT IN ('reversed', 'cancelled') AND run_type = 'regular' AND is_simulation = false AND selection IS NULL;
