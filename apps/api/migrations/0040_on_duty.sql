-- On-Duty — the second half of Part 2 row #13 ("Overtime & On-Duty"),
-- deliberately deferred out of 0038_overtime.sql's own first increment
-- (see that migration's header comment) because it's a genuinely
-- different kind of record, not a variant of an overtime claim:
--
--   Overtime  — claimed AFTER THE FACT, for a single date, by comparing
--               an already-clocked-out attendance record against the
--               resolved schedule (WorkScheduleResolutionService).
--   On-Duty   — authorized AHEAD OF TIME, over a date RANGE, for being
--               away from the ordinary workplace/schedule on official
--               business (a field visit, client site, training, business
--               travel). There is no "actual minutes worked" comparison
--               to make — the point of the request is exactly that the
--               employee won't be punching in at their normal location,
--               and the schedule engine has no opinion on that; On-Duty
--               deliberately does NOT call WorkScheduleResolutionService
--               at all, unlike Overtime, since nothing about this record
--               depends on what the employee was scheduled to work.
--
-- Decided via the same plain RBAC self/team/all mechanism Attendance
-- Corrections (0028) and Overtime (0038) both already use — one manager
-- or HR decides one request, no multi-step chain, for the identical
-- reasoning both of those migrations' own header comments already gave.
-- On-behalf submission reuses the existing `attendance.record.all`
-- permission rather than a new one, the same reuse Attendance Corrections
-- and Overtime both already established.
--
-- Deliberately NOT built this increment: any Payroll/attendance
-- integration (an approved On-Duty request doesn't mark the employee
-- "present" on any attendance record or feed a payroll run — Attendance
-- and Leave today don't cross-reference each other's state either, per
-- the precedent that `AttendanceStatus` has no "on_leave" value; adding
-- one for On-Duty would be new coupling this increment doesn't need to
-- introduce) and a Rules-Engine-backed eligibility layer (same "wait for
-- a second real need" discipline Overtime's own migration already
-- applied to itself).
CREATE TABLE IF NOT EXISTS on_duty_requests (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  start_date                    date NOT NULL,
  end_date                      date NOT NULL CHECK (end_date >= start_date),
  location                      text,
  reason                        text,
  status                        text NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_by_user_account_id  uuid NOT NULL REFERENCES user_accounts(id),
  decided_by_user_account_id    uuid REFERENCES user_accounts(id),
  decision_comment              text,
  decided_at                    timestamptz,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_on_duty_requests_employee
  ON on_duty_requests (employee_id, start_date DESC);
CREATE INDEX IF NOT EXISTS idx_on_duty_requests_company_status
  ON on_duty_requests (company_id, status);
-- No DB-level overlap exclusion (would need btree_gist for a real
-- date-range EXCLUDE constraint, a new extension dependency this
-- increment doesn't need) — OnDutyService.submit() checks for an
-- overlapping pending/approved request for the same employee in
-- application code and raises a clear 409, the same "loud failure over
-- quiet wrongness" discipline this session applies throughout, and the
-- exact query shape LeaveRequestsService.findOverlapWarnings() already
-- uses for a date-range overlap check (there: a non-blocking notice
-- across different employees; here: a same-employee conflict, so it
-- blocks rather than merely warns).

GRANT SELECT, INSERT, UPDATE, DELETE ON on_duty_requests TO app_role;

ALTER TABLE on_duty_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE on_duty_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY on_duty_requests_all ON on_duty_requests FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
