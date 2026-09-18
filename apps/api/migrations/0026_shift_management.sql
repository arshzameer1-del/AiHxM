-- Shift Management — the first increment of the AIHXM master instructions'
-- "Core HR gaps" priority (see claude/aihxm-master-audit-and-roadmap.md,
-- Part 3): a real gap today is that Attendance only has raw clock-in/out
-- (0015_leave_attendance.sql) with no concept of what time an employee
-- was actually SUPPOSED to start, so there is no way to tell "on time"
-- from "late" at all. This migration adds shift definitions and
-- effective-dated employee-shift assignments; AttendanceService (leave
-- module) is what actually resolves a punch against them — see the
-- ShiftsService doc comment for why that computation is derived at read
-- time rather than stored as a column on attendance_records (same
-- "derive it, don't store it twice" discipline 0015's own header comment
-- already used for On-Behalf leave requests).
--
-- Deliberately scoped down from Section 4.10's full list (rotations,
-- swaps, premiums, rostering) — this increment is definitions +
-- assignments + late/early detection only. Section 10's own "don't
-- over-build ahead of actual demand" guardrail applies here exactly as
-- it did to leave_type back in 0015.
--
-- Licensed under the existing `leave` module_catalog key, not a new one:
-- Attendance already lives there (0006_module_entitlement.sql's own
-- description already reads "...biometric/GPS clock-in"), and Shift
-- Management only exists to make Attendance's late/early detection
-- possible — it is not a separately-sellable capability, so this
-- deliberately does not touch package_tier_modules/module_catalog
-- (a pricing-tier decision, not an engineering one).

-- ---------------------------------------------------------------------
-- shifts — one row per named shift definition. `start_time`/`end_time`
-- are local wall-clock time-of-day (no timezone component), matching
-- every other date/time field in this schema (Postgres `date` for leave
-- dates, `timestamptz` only for actual instants like clock_in_at) — a
-- shift is "9 to 5", not tied to a specific calendar day. `crosses_midnight`
-- is stored explicitly rather than inferred from `end_time < start_time`:
-- inference breaks for the degenerate 24-hour-shift case and an explicit
-- flag is one column cheaper than a comment explaining the inference the
-- next person has to re-derive.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shifts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name               text NOT NULL,
  start_time         time NOT NULL,
  end_time           time NOT NULL,
  crosses_midnight   boolean NOT NULL DEFAULT false,
  grace_minutes_late  int NOT NULL DEFAULT 0 CHECK (grace_minutes_late >= 0),
  grace_minutes_early int NOT NULL DEFAULT 0 CHECK (grace_minutes_early >= 0),
  is_default         boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);
-- Same "at most one default" shape as leave_policies
-- (0012_employee_groups_leave_policy.sql's idx_leave_policies_one_default)
-- — the shift an employee is assumed to work when nobody has explicitly
-- assigned them one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_one_default
  ON shifts (company_id) WHERE is_default;

-- ---------------------------------------------------------------------
-- shift_assignments — effective-dated, following the exact pattern
-- employee_compensation (0022_payroll.sql) already established for "this
-- fact about an employee changes over time and history must remain
-- reconstructable": effective_from/effective_to rather than a single
-- mutable current-shift column on `employees`. A payroll dispute or a
-- late-attendance dispute about a punch from three months ago must
-- resolve against the shift that was actually assigned on THAT date, not
-- whatever the employee is assigned today.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shift_assignments (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                 uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  shift_id                    uuid NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
  effective_from              date NOT NULL,
  effective_to                date,
  created_by_user_account_id  uuid NOT NULL REFERENCES user_accounts(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS idx_shift_assignments_employee
  ON shift_assignments (employee_id, effective_from);

GRANT SELECT, INSERT, UPDATE, DELETE ON shifts, shift_assignments TO app_role;

ALTER TABLE shifts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts             FORCE ROW LEVEL SECURITY;
ALTER TABLE shift_assignments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_assignments  FORCE ROW LEVEL SECURITY;

CREATE POLICY shifts_all ON shifts FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY shift_assignments_all ON shift_assignments FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
