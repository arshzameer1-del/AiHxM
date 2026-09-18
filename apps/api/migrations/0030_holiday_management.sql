-- Holiday Management — the third increment of the "Core HR gaps"
-- sequence (see claude/aihxm-master-audit-and-roadmap.md, Part 3), after
-- Shift Management (0026) and Attendance Corrections (0028). This closes
-- the gap those two increments each explicitly deferred: Attendance
-- Corrections' own header comment named "absence reporting (needs a
-- working-days/holiday calendar first)" as out of scope, and this is
-- that calendar's foundation.
--
-- Deliberately a standalone module (its own `holidays` table, its own
-- NestJS module under apps/api/src/holidays/) rather than colocated
-- inside `leave/` the way Attendance Corrections was: a holiday isn't a
-- sub-feature of Leave or of Attendance specifically — it's a company-
-- wide calendar fact that BOTH of those (and, eventually, payroll
-- working-day counts) will need to read. That's the same "standalone
-- concept gets its own module" reasoning Shift Management used.
--
-- Scope for this increment is deliberately just the calendar itself:
-- CRUD on named holiday dates, visible to everyone in the company. It
-- does NOT yet feed into leave day-count calculation (a leave request
-- spanning a public holiday still counts that day today, same as
-- before) or into attendance absence detection (a no-punch day still
-- isn't classified as "expected absence" vs "holiday") — those are
-- follow-on integration work once this calendar actually has data in
-- it, matching Section 10's "don't over-build ahead of actual demand"
-- guardrail every prior increment this phase has cited.
--
-- Licensed under the existing `leave` module_catalog key, not a new one
-- — same reasoning Shift Management used: a holiday calendar only
-- exists to support Leave/Attendance, it isn't a separately-sellable
-- capability, so this deliberately does not touch
-- package_tier_modules/module_catalog.

-- ---------------------------------------------------------------------
-- holidays — one row per named holiday observed by the company on a
-- specific calendar date. `is_optional` distinguishes a mandatory
-- public holiday from an "optional"/floating holiday some Pakistan SMBs
-- offer (e.g. a specific religious observance an employee may choose to
-- take) — stored now even though nothing yet branches on it, because
-- it's a fact about the holiday itself (not a policy decision), cheap
-- to capture at entry time, and expensive to reconstruct later once
-- these are entered as plain "true" holidays.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS holidays (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         text NOT NULL,
  holiday_date date NOT NULL,
  is_optional  boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, holiday_date, name)
);
CREATE INDEX IF NOT EXISTS idx_holidays_company_date
  ON holidays (company_id, holiday_date);

GRANT SELECT, INSERT, UPDATE, DELETE ON holidays TO app_role;

ALTER TABLE holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE holidays FORCE ROW LEVEL SECURITY;

CREATE POLICY holidays_all ON holidays FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
