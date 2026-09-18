-- Attendance correction permissions. `attendance_correction.request.self`
-- is new (self-requesting a fix to your own record is a distinct action
-- from `attendance.record.self`, which is clocking in/out directly, not
-- asking for a past punch to be changed). On-behalf submission (HR fixing
-- an employee's record for them) deliberately reuses the EXISTING
-- `attendance.record.all` permission rather than adding a redundant one —
-- the authority "can touch any employee's attendance" already exists and
-- a correction is the same authority, just routed through a request row
-- instead of a direct write.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('attendance_correction.request.self', 'Request a correction to your own attendance record'),
  ('attendance_correction.decide.team',  'Approve or reject your direct reports'' attendance correction requests'),
  ('attendance_correction.decide.all',   'Approve or reject any attendance correction request');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'employee_self_service' AND p.key = 'attendance_correction.request.self';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'line_manager' AND p.key = 'attendance_correction.decide.team';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key = 'attendance_correction.decide.all';
