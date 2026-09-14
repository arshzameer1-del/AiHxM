-- Phase 9 seed — permissions for Leave & Attendance, granted to the same
-- three real roles Phase 7 introduced (hr_admin/line_manager/
-- employee_self_service) rather than inventing new ones: leave requests
-- and attendance are just more facts about the same Employee object
-- those roles already govern.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('leave_request.view.self',   'View your own leave requests'),
  ('leave_request.view.team',   'View leave requests of your direct reports'),
  ('leave_request.view.all',    'View any leave request in your company'),
  ('leave_request.create.self', 'Submit a leave request for yourself'),
  ('leave_request.manage.all',  'Submit a leave request on behalf of any employee (On-Behalf), and cancel any leave request'),
  ('attendance.record.self',    'Clock yourself in and out'),
  ('attendance.record.all',     'Clock any employee in or out (kiosk/biometric-device/HR use)');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin'
  AND p.key IN ('leave_request.view.all', 'leave_request.manage.all', 'attendance.record.all');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'line_manager' AND p.key = 'leave_request.view.team';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'employee_self_service'
  AND p.key IN ('leave_request.view.self', 'leave_request.create.self', 'attendance.record.self');
