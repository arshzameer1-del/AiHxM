-- On-Duty seed — same self/team/all shape Attendance Corrections (0029)
-- and Overtime (0039) both already established: `on_duty.request.self`
-- lets an employee submit their own request (HR/managers get it too, the
-- same "on-behalf submission reuses attendance.record.all, not this
-- permission" split those two migrations already use); `on_duty.decide
-- .team`/`.decide.all` gate approving/rejecting a request and, per both
-- precedents, also gate read access to a request list — no separate view
-- permission, since deciding implies viewing and self implies viewing
-- your own.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('on_duty.request.self', 'Submit an on-duty request for oneself'),
  ('on_duty.decide.team',  'Approve/reject direct reports'' on-duty requests'),
  ('on_duty.decide.all',   'Approve/reject any employee''s on-duty request');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key = 'on_duty.decide.all';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'line_manager' AND p.key = 'on_duty.decide.team';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key IN ('hr_admin', 'line_manager', 'employee_self_service') AND p.key = 'on_duty.request.self';
