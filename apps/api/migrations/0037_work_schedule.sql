-- Work Schedule & Employee Schedule Assignment Architecture — first
-- increment. See claude/aihxm-work-schedule-architecture.md (pasted
-- 2026-09-18, "Mandatory implementation standard") and
-- claude/aihxm-master-audit-and-roadmap.md Part 4's reconciliation entry
-- for the full reasoning: this EXTENDS Shift Management (0026), it does
-- not replace it — `shifts` remains the Work Schedule definition table,
-- `shift_assignments` remains the Employee Schedule Assignment table
-- (already effective-dated via the shared EffectiveDatingEngine, already
-- supporting bounded/temporary assignments). What was missing per the new
-- mandate: a configurable WEEKLY PATTERN (every day used to implicitly
-- share one start/end time), multiple BREAKS per day, FLEXIBLE/core-hours
-- schedules, and configurable ASSIGNMENT RULES (today an employee can
-- only be assigned a schedule directly — never via "Department = IT AND
-- Employee Group = Software Engineers -> FLEX-01").
--
-- Deliberately scoped down, same "don't over-build ahead of demand"
-- discipline as every prior increment: schedule_type accepts 'rotating'
-- as a value but this increment does NOT implement rotation-cycle
-- resolution (Section 6's "Week 1 -> A, Week 2 -> B" pattern) — that's
-- real follow-on work for whichever tenant actually needs it, tracked in
-- KNOWN_ISSUES.md rather than guessed at now. Cross-midnight remains the
-- existing `crosses_midnight` boolean flag (0026) — true minute-level
-- midnight-spanning attendance math is also not attempted this
-- increment, for the same reason.

-- ---------------------------------------------------------------------
-- shifts gains the two schedule-level attributes the new architecture
-- names that didn't exist before: what KIND of schedule this is, and
-- what timezone it's defined in (Section 6, Section 11). Both default to
-- values that make every EXISTING shift row behave identically to before
-- this migration — 'fixed' is exactly what a bare start/end/grace shift
-- already was, and 'Asia/Karachi' matches every statutory-rate/seed
-- assumption already baked into this codebase (see
-- claude/statutory-payroll-rates-pakistan.md).
-- ---------------------------------------------------------------------
ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS schedule_type text NOT NULL DEFAULT 'fixed'
    CHECK (schedule_type IN ('fixed', 'flexible', 'shift', 'rotating', 'individual')),
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Asia/Karachi';

-- ---------------------------------------------------------------------
-- work_schedule_days — the weekly pattern (Section 7) + daily
-- configuration (Section 8): exactly one row per shift per day-of-week
-- (0 = Sunday .. 6 = Saturday, the same convention Postgres's own
-- EXTRACT(DOW ...) and JS's Date#getUTCDay() both use, so no translation
-- table is needed anywhere this is read). `company_id` is denormalized
-- here rather than joined through `shift_id -> shifts.company_id` for
-- RLS, matching `employee_group_conditions`' own precedent
-- (0012_employee_groups_leave_policy.sql) for a child-of-a-tenant-owned-
-- parent table.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_schedule_days (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shift_id              uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  day_of_week           smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  is_working            boolean NOT NULL DEFAULT true,
  start_time            time,
  end_time              time,
  is_flexible           boolean NOT NULL DEFAULT false,
  flexible_start_time   time,
  flexible_end_time     time,
  core_start_time       time,
  core_end_time         time,
  is_half_day           boolean NOT NULL DEFAULT false,
  UNIQUE (shift_id, day_of_week),
  CHECK ((NOT is_working) OR (start_time IS NOT NULL AND end_time IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_work_schedule_days_shift ON work_schedule_days (shift_id);

-- ---------------------------------------------------------------------
-- work_schedule_breaks — multiple breaks per working day (Section 9).
-- Child of work_schedule_days, not of shifts directly, since a break
-- belongs to one specific day's configuration (a flexible Monday and a
-- fixed Tuesday on the same schedule can have completely different break
-- layouts).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_schedule_breaks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  work_schedule_day_id  uuid NOT NULL REFERENCES work_schedule_days(id) ON DELETE CASCADE,
  start_time            time NOT NULL,
  end_time              time NOT NULL,
  is_paid               boolean NOT NULL DEFAULT false,
  CHECK (end_time > start_time)
);
CREATE INDEX IF NOT EXISTS idx_work_schedule_breaks_day ON work_schedule_breaks (work_schedule_day_id);

-- ---------------------------------------------------------------------
-- work_schedule_assignment_rules — Section 15: "IF Department = IT AND
-- Employee Group = Software Engineers THEN Work Schedule = FLEX-01".
-- `condition_expression` stores a RulesEngine `RuleExpression` tree
-- (apps/api/src/rules-engine/rules-engine.engine.ts) evaluated against the
-- exact same employee-attribute vocabulary Employee Groups' conditions
-- already use (see employees/employee-condition-fields.util.ts,
-- extracted this same migration for exactly this reuse) — reusing the
-- existing Rules Engine per Section 15's own instruction ("Rules must use
-- the existing Rules Engine where possible. Do not create a second
-- unrelated rule engine.").
--
-- `priority` is a plain admin-settable integer (lower = evaluated first =
-- higher precedence) rather than a hard-coded hierarchy — Section 14
-- explicitly asks that this NOT be silently hard-coded, so precedence is
-- configuration, not code. Resolution order for ties: priority ASC, then
-- (in code) the rule with more leaf conditions wins, matching Employee
-- Groups' own resolvePolicyInternal() specificity tie-break exactly
-- (ShiftsService.resolveForEmployeeOnDate's new rule tier reuses that
-- same convention rather than inventing a second tie-break rule).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_schedule_assignment_rules (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                        text NOT NULL,
  priority                    int NOT NULL DEFAULT 100,
  condition_expression        jsonb NOT NULL,
  shift_id                    uuid NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
  is_active                   boolean NOT NULL DEFAULT true,
  created_by_user_account_id  uuid NOT NULL REFERENCES user_accounts(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);
CREATE INDEX IF NOT EXISTS idx_work_schedule_assignment_rules_company
  ON work_schedule_assignment_rules (company_id, priority) WHERE is_active;

GRANT SELECT, INSERT, UPDATE, DELETE ON work_schedule_days, work_schedule_breaks, work_schedule_assignment_rules TO app_role;

ALTER TABLE work_schedule_days              ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_schedule_days              FORCE ROW LEVEL SECURITY;
ALTER TABLE work_schedule_breaks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_schedule_breaks            FORCE ROW LEVEL SECURITY;
ALTER TABLE work_schedule_assignment_rules  ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_schedule_assignment_rules  FORCE ROW LEVEL SECURITY;

CREATE POLICY work_schedule_days_all ON work_schedule_days FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY work_schedule_breaks_all ON work_schedule_breaks FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY work_schedule_assignment_rules_all ON work_schedule_assignment_rules FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

-- ---------------------------------------------------------------------
-- Backfill: every EXISTING shift gets all 7 days marked "working," using
-- that shift's own top-level start_time/end_time — i.e. byte-identical
-- behavior to before this migration for every tenant that already
-- configured shifts (no day is silently marked off). Needs the same
-- RLS-bypass claims 0033/0034 already established for a cross-table
-- backfill under FORCE ROW LEVEL SECURITY.
-- ---------------------------------------------------------------------
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO work_schedule_days (company_id, shift_id, day_of_week, is_working, start_time, end_time)
SELECT s.company_id, s.id, d.day_of_week, true, s.start_time, s.end_time
FROM shifts s
CROSS JOIN generate_series(0, 6) AS d(day_of_week)
ON CONFLICT (shift_id, day_of_week) DO NOTHING;
