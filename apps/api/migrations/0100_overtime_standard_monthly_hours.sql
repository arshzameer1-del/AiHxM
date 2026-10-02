-- Remaining Scope Execution Plan follow-on: the 208-hour divisor
-- `OvertimeService.priceClaim()` uses to turn monthly compensation into
-- an ordinary hourly rate (overtime.service.ts's own header comment on
-- `OVERTIME_STANDARD_MONTHLY_HOURS`, and 0097_overtime_amount_snapshot.sql's
-- header comment) was a hardcoded global constant (26 days x 8 hours).
-- Flagged as needing to be per-tenant: a 5-day-week tenant or one with a
-- different daily-hours convention has a genuinely different standard
-- month, not a data-entry mistake in 208.
--
-- This column is added to `payroll_settings`, NOT a new table or a column
-- on `overtime_policies`. Reasoning (see overtime.service.ts's own doc
-- comment on `resolveStandardMonthlyHours()` for the fuller version):
--
--  - `payroll_settings` already IS this tenant's one effective-dated home
--    for "a numeric assumption payroll/overtime math divides or multiplies
--    by, data rather than code" (EOBI wage base, social security rates).
--    A standard monthly hours figure is exactly that same kind of fact,
--    not a new concept.
--  - It is already effective-dated (0092_payroll_component_compensation.sql
--    converted it from one mutable row per tenant to a versioned one), so
--    resolving "the value in force on the claim's work_date" — this task's
--    requirement — is the SAME `effective_from <= date <= effective_to`
--    query PayrollService.loadSettingsAsOf()/loadTaxSlabsAsOf() already run,
--    not new machinery.
--  - Reusing it means ONE admin surface (Payroll Settings) configures every
--    "assumption behind a derived rate" figure, instead of a second,
--    parallel settings table a tenant admin would have to separately
--    discover.
--
-- The one wrinkle: this column is READ by the Leave module
-- (OvertimeService.priceClaim(), at approval time, before any payroll run
-- exists), not just by Payroll. OvertimeService does NOT import
-- PayrollService to read it (PayrollModule already depends on LeaveModule
-- for OvertimeService itself — see PayrollService's own constructor
-- comment — so the reverse import would be circular). Instead it reads
-- `payroll_settings` directly with its own small effective-dated query,
-- the exact same "read-only cross-module SQL read, never through the
-- owning service's write path" precedent `priceClaim()` already
-- established for `employee_compensation_components`/
-- `compensation_components` (EmployeeCompensationService owns writes to
-- those; OvertimeService only ever reads).
--
-- Default 208 (the existing OVERTIME_STANDARD_MONTHLY_HOURS, unchanged)
-- for both the column default (a tenant Payroll has already seeded) and
-- the application-level fallback (a tenant that has never touched Payroll
-- at all, so has no payroll_settings row for OvertimeService to find) —
-- so every existing tenant's overtime pricing is byte-for-byte unchanged
-- until an admin explicitly configures a different value.
--
-- Bounds (100-300) are sanity guardrails against fat-finger input (e.g.
-- typing hours/day instead of hours/month), not a business rule — a real
-- range of standard work-month hours (4-day short weeks through 7-day
-- continuous-ops rotas) comfortably fits inside it.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE payroll_settings
  ADD COLUMN IF NOT EXISTS standard_monthly_hours numeric(6,2) NOT NULL DEFAULT 208,
  ADD CONSTRAINT payroll_settings_standard_monthly_hours_range
    CHECK (standard_monthly_hours >= 100 AND standard_monthly_hours <= 300);
