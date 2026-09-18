-- Holiday Management seed — unlike every other module so far (one
-- narrower permission per role: shift.manage.all/view.team/view.self,
-- attendance_correction.request.self/decide.team/decide.all), a holiday
-- is non-sensitive, company-wide public data: there is nothing to scope
-- down to "self" or "team" because every employee already needs to see
-- the same calendar. So `holiday.view.all` is granted broadly to all
-- three real roles at once, and only management is restricted.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('holiday.manage.all', 'Create/edit/delete the company holiday calendar'),
  ('holiday.view.all',   'View the company holiday calendar');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key = 'holiday.manage.all';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key IN ('hr_admin', 'line_manager', 'employee_self_service') AND p.key = 'holiday.view.all';
