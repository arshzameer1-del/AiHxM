-- ---------------------------------------------------------------------
-- Phase 2 gap-fill item #5 — data subject request queue. Lets an employee
-- submit a formal privacy request (access / correction / deletion) about
-- their own data, and routes it through the SAME generic WorkflowService
-- multi-step approval engine leave_requests already uses — per the
-- roadmap's own wording ("reusing the existing workflow module") — rather
-- than the single-decider pattern attendance_correction_requests chose.
-- The difference is deliberate: a correction has exactly one decider,
-- but a DSR plausibly needs a real review chain (e.g. HR then a
-- compliance officer), which is exactly what WorkflowService is for.
--
-- Structural template is leave_requests (0015_leave_attendance.sql):
-- own domain table + workflow_instance_id FK, submitted separately from
-- workflow submission by the service layer (see WorkflowService's own
-- documented non-atomicity). "Fulfillment" is intentionally its own
-- explicit step, not something this migration or the service automates:
-- honoring a granted access/correction/deletion request is a real-world
-- action (exporting data, editing a record, redacting/erasing data)
-- that HR or a Data Protection Officer completes by hand and confirms
-- here — this table records that it happened and a plain-text note of
-- what was done, not machinery that performs the erasure itself.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS data_subject_requests (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  request_type                  text NOT NULL CHECK (request_type IN ('access', 'correction', 'deletion')),
  description                   text NOT NULL,
  status                        text NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending', 'approved', 'rejected', 'fulfilled')),
  submitted_by_user_account_id  uuid NOT NULL REFERENCES user_accounts(id),
  workflow_instance_id          uuid REFERENCES workflow_instances(id),
  decision_comment              text,
  fulfilled_by_user_account_id  uuid REFERENCES user_accounts(id),
  fulfilled_at                  timestamptz,
  fulfillment_note              text,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status <> 'fulfilled')
    OR (fulfilled_by_user_account_id IS NOT NULL AND fulfilled_at IS NOT NULL AND fulfillment_note IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_data_subject_requests_employee ON data_subject_requests (employee_id);
-- Powers the HR queue view: "everything pending/actionable for my company."
CREATE INDEX IF NOT EXISTS idx_data_subject_requests_company_status
  ON data_subject_requests (company_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON data_subject_requests TO app_role;

-- Same genuine tenant-scoped-write RLS shape as leave_requests and
-- attendance_correction_requests before it.
ALTER TABLE data_subject_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_subject_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY data_subject_requests_all ON data_subject_requests FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

-- Permissions. `data_subject_request.request.self` is new — submitting a
-- formal privacy request about your own data is a distinct action from
-- anything that already exists. Reviewing/deciding, viewing the queue,
-- and fulfilling a request are all HR/DPO authority over employee data
-- that already exists as `employee.manage.all` — a DSR queue action is
-- that same authority, just routed through a request row, so no new
-- decide/fulfill permission is added for it.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('data_subject_request.request.self', 'Submit a data subject (access / correction / deletion) request about your own data');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'employee_self_service' AND p.key = 'data_subject_request.request.self';
