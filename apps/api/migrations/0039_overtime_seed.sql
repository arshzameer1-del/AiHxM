-- Overtime & On-Duty seed — same self/team/all + a separate manage-only
-- policy permission shape Attendance Corrections (0029) and Holiday
-- Management (0031) already established: `overtime.policy.manage.all`
-- gates the company-wide rate/threshold settings (HR only, same as a
-- holiday calendar's `holiday.manage.all`); `overtime.request.self` lets
-- an employee submit their own claim; `overtime.decide.team`/`.decide.all`
-- gate approving/rejecting a claim, and (per attendance corrections'
-- exact precedent) also gate read access to a claim list — no separate
-- view permission is needed since deciding implies viewing and self
-- implies viewing your own.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('overtime.policy.manage.all', 'Set the company overtime policy (rate multipliers, thresholds)'),
  ('overtime.request.self',      'Submit an overtime claim for oneself'),
  ('overtime.decide.team',       'Approve/reject direct reports'' overtime claims'),
  ('overtime.decide.all',        'Approve/reject any employee''s overtime claim');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key IN ('overtime.policy.manage.all', 'overtime.decide.all');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'line_manager' AND p.key = 'overtime.decide.team';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key IN ('hr_admin', 'line_manager', 'employee_self_service') AND p.key = 'overtime.request.self';
