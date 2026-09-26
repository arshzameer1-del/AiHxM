-- Organization Management, Phase 4 seed — permissions for Location,
-- Cost Center, and Profit Center, same pattern as
-- 0066_organization_units_seed.sql/0069_job_position_seed.sql.
--
-- Six permissions, split the same way every prior phase split
-- `*.manage.all` from `*.view.all`: defining/editing this setup data is an
-- HR Admin (or Finance-adjacent) configuration action, while SEEING it is
-- useful to the same broader audience org units/jobs/positions already
-- are. All six are deliberately scope-less, same as every other
-- Organization Management permission so far.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('location.manage.all',      'Create, edit, move, and archive the company''s location hierarchy'),
  ('location.view.all',        'View the company''s location hierarchy'),
  ('cost_center.manage.all',   'Create, edit, and archive the company''s cost centers'),
  ('cost_center.view.all',     'View the company''s cost centers'),
  ('profit_center.manage.all', 'Create, edit, and archive the company''s profit centers'),
  ('profit_center.view.all',   'View the company''s profit centers');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key IN (
  'location.manage.all', 'location.view.all',
  'cost_center.manage.all', 'cost_center.view.all',
  'profit_center.manage.all', 'profit_center.view.all'
);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'line_manager' AND p.key IN ('location.view.all', 'cost_center.view.all', 'profit_center.view.all');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'employee_self_service' AND p.key IN ('location.view.all', 'cost_center.view.all', 'profit_center.view.all');
