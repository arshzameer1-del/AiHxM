-- Attendance Policies — increment 1 of the Core HR phase's second item
-- (see claude/aihxm-master-audit-and-roadmap.md, Part 4): correction
-- requests. Shift Management (0026/0027) made late/on-time/early
-- detection possible; the real gap it left behind is that a wrong or
-- missed punch has no way to get fixed except a developer touching the
-- database directly — exactly the kind of gap Task #49's own "no
-- customer needs a developer to touch the database" bar exists to catch.
--
-- Deliberately NOT built on the generic Workflow Engine
-- (workflow_instances, the mechanism leave_requests uses): a correction
-- request has exactly one decision made by exactly one of two people (the
-- requester's own manager, or HR) — there is no multi-step chain to
-- route. The lighter RBAC self/team/all mechanism Shift Management already
-- proved (shift.view.team/self) fits this shape better than standing up a
-- workflow_instance for a single yes/no decision. If a real multi-step
-- attendance-correction approval chain is ever actually requested, that's
-- the trigger to switch this to the Workflow Engine — not before.
--
-- Deliberately NOT included in this increment: absence reporting. A
-- correct "was this employee absent today" answer needs a working-days/
-- holiday calendar concept that does not exist yet (Holiday Management is
-- next in the roadmap sequence) — a naive version today would silently
-- flag every Saturday and Sunday as an absence. Shipping that half-correct
-- would be worse than not shipping it yet (Section 10's "don't over-build
-- ahead of actual demand" guardrail, same one 0015/0026 already cite).

-- ---------------------------------------------------------------------
-- attendance_correction_requests — one row per requested fix. Can either
-- correct an EXISTING attendance_records row (attendance_record_id set;
-- e.g. "I clocked in but forgot to clock out") or, when null, create a
-- brand-new one on approval (e.g. "I forgot to clock in at all that day"
-- — there is no attendance_records row to reference yet). Exactly one of
-- requested_clock_in/requested_clock_out being null is allowed (correcting
-- only one side of a punch); both null is not (nothing would change).
-- `requested_date` is stored separately from the two timestamps because
-- it's needed even when both corrected times are for a record that
-- doesn't exist yet — AttendanceCorrectionsService needs it to resolve
-- which shift the corrected punch should be judged against.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_correction_requests (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  attendance_record_id          uuid REFERENCES attendance_records(id) ON DELETE SET NULL,
  requested_date                date NOT NULL,
  requested_clock_in            timestamptz,
  requested_clock_out           timestamptz,
  reason                        text NOT NULL,
  status                        text NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_by_user_account_id  uuid NOT NULL REFERENCES user_accounts(id),
  decided_by_user_account_id    uuid REFERENCES user_accounts(id),
  decision_comment              text,
  decided_at                    timestamptz,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CHECK (requested_clock_in IS NOT NULL OR requested_clock_out IS NOT NULL),
  CHECK (
    requested_clock_in IS NULL OR requested_clock_out IS NULL
    OR requested_clock_out >= requested_clock_in
  )
);
CREATE INDEX IF NOT EXISTS idx_attendance_correction_requests_employee
  ON attendance_correction_requests (employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_correction_requests_company_status
  ON attendance_correction_requests (company_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON attendance_correction_requests TO app_role;

ALTER TABLE attendance_correction_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_correction_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY attendance_correction_requests_all ON attendance_correction_requests FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
