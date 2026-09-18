-- Shift Management seed — permissions granted to the same three real
-- roles every module since Phase 7 has used, same reasoning as
-- 0016_leave_attendance_seed.sql: a shift assignment is just another
-- fact about the same Employee object those roles already govern.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('shift.manage.all', 'Create/edit shift definitions and assign employees to shifts'),
  ('shift.view.team',  'View shift assignments of your direct reports'),
  ('shift.view.self',  'View your own assigned shift');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key = 'shift.manage.all';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'line_manager' AND p.key = 'shift.view.team';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'employee_self_service' AND p.key = 'shift.view.self';
