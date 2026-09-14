-- Phase 9 — Leave & Attendance: the real go/no-go checkpoint (plan doc
-- Section 7). Two real objects, `leave_requests` (+ `leave_balances`) and
-- `attendance_records`, both licensed under the existing `leave` module
-- key (module_catalog already described it as "Leave lifecycle, On-Behalf
-- requests, biometric/GPS clock-in" back in 0006_module_entitlement.sql —
-- this phase is what actually builds that).
--
-- `leave_type` is a fixed three-value set — 'annual' | 'casual' | 'sick'
-- — matching the three entitlement-day buckets `leave_policies` (Phase 8)
-- already has. Adding a fourth leave type later means adding a matching
-- column to `leave_policies` too; not attempted here since none is asked
-- for yet (Section 10's own "don't over-build ahead of actual demand"
-- guardrail).

-- ---------------------------------------------------------------------
-- leave_balances — one row per employee, per leave_type, per calendar
-- year. Lazily created (EmployeeGroupsService.resolvePolicy's applicable
-- policy's entitlement-days seeds it) the first time an employee's
-- balance for that type/year is ever needed, rather than pre-populated
-- for every employee on a schedule — most SMB employees never touch most
-- leave types in a given year.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leave_balances (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type     text NOT NULL CHECK (leave_type IN ('annual', 'casual', 'sick')),
  year           int NOT NULL,
  entitled_days  numeric(5,2) NOT NULL CHECK (entitled_days >= 0),
  used_days      numeric(5,2) NOT NULL DEFAULT 0 CHECK (used_days >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, leave_type, year)
);
CREATE INDEX IF NOT EXISTS idx_leave_balances_employee ON leave_balances (employee_id);

-- ---------------------------------------------------------------------
-- leave_requests — the lifecycle object itself. `workflow_instance_id`
-- links each request to the Phase 6 approval-routing engine instance
-- that governs it (nullable only for the brief instant between the
-- request row and the workflow instance both being created inside the
-- same transaction — LeaveRequestsService.submit() never leaves it null
-- once that transaction commits). `submitted_by_user_account_id` vs the
-- employee's own `user_account_id` (joined via `employee_id`) is what
-- distinguishes an On-Behalf submission from an ordinary self-submission
-- — no separate boolean column needed, the same "derive it, don't store
-- it twice" discipline the rest of this codebase already uses.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leave_requests (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type                   text NOT NULL CHECK (leave_type IN ('annual', 'casual', 'sick')),
  start_date                   date NOT NULL,
  end_date                     date NOT NULL CHECK (end_date >= start_date),
  days_requested               numeric(5,2) NOT NULL CHECK (days_requested > 0),
  reason                       text,
  status                       text NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  submitted_by_user_account_id uuid NOT NULL REFERENCES user_accounts(id),
  workflow_instance_id         uuid REFERENCES workflow_instances(id),
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leave_requests_employee ON leave_requests (employee_id);
-- Powers both the overlap-notice check (any other request whose date
-- range intersects a candidate one) and, combined with employees.manager_id,
-- "does this overlap someone on the SAME team."
CREATE INDEX IF NOT EXISTS idx_leave_requests_dates ON leave_requests (company_id, start_date, end_date);

-- ---------------------------------------------------------------------
-- attendance_records — biometric/GPS clock-in, keyed off employee_number
-- per plan doc Section 5's own rule ("any external interface... never
-- the internal UUID") — a real device or kiosk knows the number it
-- scanned, never the internal UUID. `employee_number` is stored
-- denormalized alongside the resolved `employee_id` FK: the interface
-- speaks employee_number, the rest of the schema still joins on the
-- stable UUID, exactly the two-IDs-two-jobs split Section 5 describes.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  employee_number text NOT NULL,
  source          text NOT NULL CHECK (source IN ('biometric', 'gps', 'manual')),
  clock_in_at     timestamptz NOT NULL DEFAULT now(),
  clock_out_at    timestamptz,
  gps_lat         numeric(9,6),
  gps_lng         numeric(9,6),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (clock_out_at IS NULL OR clock_out_at >= clock_in_at)
);
CREATE INDEX IF NOT EXISTS idx_attendance_records_employee ON attendance_records (employee_id);
-- Powers "is this employee already clocked in" (find their one open row,
-- if any) without scanning the whole table.
CREATE INDEX IF NOT EXISTS idx_attendance_records_open
  ON attendance_records (employee_id) WHERE clock_out_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON leave_balances, leave_requests, attendance_records TO app_role;

-- Same genuine tenant-scoped-write RLS shape as Phase 7's `employees` and
-- Phase 8's `employee_groups` — real end users (HR Admins, managers,
-- employees themselves) write these tables directly, not just Platform-
-- Admin fixture tooling.
ALTER TABLE leave_balances     ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_balances     FORCE ROW LEVEL SECURITY;
ALTER TABLE leave_requests     ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_requests     FORCE ROW LEVEL SECURITY;
ALTER TABLE attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_records FORCE ROW LEVEL SECURITY;

CREATE POLICY leave_balances_all ON leave_balances FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY leave_requests_all ON leave_requests FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY attendance_records_all ON attendance_records FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
