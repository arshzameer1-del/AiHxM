-- Cross-Module Integration Gap Audit (2026-10-01,
-- claude/cross-module-integration-gap-audit-2026-10.md, item 4 /
-- remaining-scope-execution-plan Phase F0 item 5): "Overtime ka AMOUNT
-- kabhi Payroll tak nahi pohnchta." 0038_overtime.sql's own header
-- comment named Payroll integration as a deliberately deferred follow-on
-- ("calculateRun() doesn't read attendance_records at all today"); this
-- migration is the schema half of closing it. PayrollService.
-- calculateOnePayslip() now reads every APPROVED overtime claim whose
-- `work_date` falls inside the employee's employment window for the run
-- (through OvertimeService.getApprovedOvertimeInRange(), never a raw
-- query of this table from Payroll — the same "call the owning module's
-- service, don't re-derive its data by hand" correction the same audit's
-- item 6 applied to unpaid leave) and adds the summed `amount` to gross
-- pay as its own calculation_breakdown line.
--
-- Two new columns, both SNAPSHOTTED at approval time by
-- OvertimeService.decide() — never recomputed afterwards, and never
-- computed at payroll-run time:
--
--  - `hourly_rate`: the employee's ordinary hourly rate ON THE CLAIM'S
--    OWN `work_date` = the sum of every active compensation component
--    (Basic Salary + allowances, employee_compensation_components /
--    compensation_components, 0092) in effect on that date, divided by a
--    standard 208-hour month (26 working days x 8 hours — the 48-hour,
--    six-day week the Factories Act 1934 s.34 and the West Pakistan
--    Shops and Establishments Ordinance 1969 both use as the ordinary
--    working week). "Every active component" deliberately matches the
--    `latestTotalMonthlyRate` convention PayrollService's unpaid-leave
--    deduction already uses, so Payroll's own two per-day/per-hour
--    derivations of "ordinary pay" agree with each other. The 208-hour
--    divisor is a documented constant (OVERTIME_STANDARD_MONTHLY_HOURS in
--    overtime.service.ts), NOT a per-tenant setting yet — the same
--    "researched default, a real accountant should review before real
--    money" caveat 0022's DEFAULT_TAX_SLABS already carries; making it
--    configurable on overtime_policies is a reasonable follow-on once a
--    tenant actually needs a different one.
--  - `amount` = (overtime_minutes / 60) x hourly_rate x rate_multiplier,
--    rounded to 2 decimal places.
--
-- Why snapshot rather than compute at payroll time: `rate_multiplier`
-- (and scheduled/actual/overtime minutes, and day_type) are ALREADY
-- snapshotted at submission time (see 0038's comment on
-- `overtime_records` — "a later policy or schedule change never silently
-- rewrites the meaning of an already-decided claim"). The monetary amount
-- needs exactly the same guarantee, for the same reason: a salary
-- revision approved in March must not retroactively re-price overtime a
-- manager already approved in February. Worse, computing it at payroll
-- time would make a recalculation of a still-draft run silently produce a
-- different overtime figure from the one the approver saw, and a
-- REVERSED-then-corrected run (0094) could pay a different amount for the
-- identical approved claim than the original, reversed run did. The rate
-- is taken as of the claim's own `work_date` (not the approval date) —
-- the hours were worked under that date's pay, which is what an
-- auditor would expect to reproduce — but it is captured AT APPROVAL, the
-- moment the claim becomes payable, which is the "point of no return"
-- for this record the same way finalization is for a payslip.
--
-- Both columns are nullable. A `pending`/`rejected` claim never has an
-- amount (nothing is payable). An approved claim for an employee with NO
-- compensation record covering its work_date (a tenant using Attendance/
-- Overtime without Payroll configured yet) is still approved — Overtime
-- is not gated on Payroll being set up — but stores NULL here; Payroll
-- then refuses that employee's payslip with a clear per-employee error
-- (collected into calculateRun()'s `errors`, never silently paid as 0),
-- the same loud-failure discipline "No compensation record covers this
-- employee for this period" already follows.
--
-- Backfill: claims ALREADY approved before this migration are priced
-- here, once, with the identical formula against the compensation in
-- force on each claim's own work_date — the same value decide() would
-- have snapshotted had this column existed when they were approved, so
-- the first payroll run after deploy doesn't error out on every
-- historical approved claim. Rounding mirrors the service exactly
-- (hourly rate to 4dp first, amount to 2dp from that rounded rate).

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE overtime_records
  ADD COLUMN IF NOT EXISTS hourly_rate numeric(14,4) CHECK (hourly_rate IS NULL OR hourly_rate >= 0),
  ADD COLUMN IF NOT EXISTS amount numeric(14,2) CHECK (amount IS NULL OR amount >= 0);

UPDATE overtime_records ot
SET hourly_rate = priced.hourly_rate,
    amount = ROUND((ot.overtime_minutes / 60.0) * priced.hourly_rate * ot.rate_multiplier, 2)
FROM (
  SELECT o.id, ROUND(SUM(ecc.amount) / 208.0, 4) AS hourly_rate
  FROM overtime_records o
  JOIN employee_compensation_components ecc
    ON ecc.employee_id = o.employee_id
   AND ecc.effective_from <= o.work_date
   AND (ecc.effective_to IS NULL OR ecc.effective_to >= o.work_date)
  JOIN compensation_components cc ON cc.id = ecc.component_id AND cc.is_active
  WHERE o.status = 'approved' AND o.amount IS NULL
  GROUP BY o.id
) priced
WHERE priced.id = ot.id;

-- Payroll reads approved claims per employee by work_date range on every
-- calculation; the existing idx_overtime_records_employee
-- (employee_id, work_date DESC) already serves that lookup, so no new
-- index is added here.
