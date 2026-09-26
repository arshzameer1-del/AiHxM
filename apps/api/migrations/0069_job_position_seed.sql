-- Organization Management, Phase 2 seed — permissions for Job + Position,
-- same pattern as 0066_organization_units_seed.sql.
--
-- Four permissions, split the same way Phase 1 split org_unit.manage.all
-- from org_unit.view.all: defining Job/Position setup data and running
-- position lifecycle actions (create/freeze/abolish/assign/unassign) is
-- an HR Admin configuration action, while SEEING jobs/positions is useful
-- to the same broader audience org units already are (a Line Manager
-- needs to see their own team's open positions; an employee benefits
-- from seeing their own position's title/job the same way they can
-- already see their own org unit). All four are deliberately scope-less,
-- same as org_unit.manage.all/org_unit.view.all.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('job.manage.all',      'Create, edit, and archive the company''s job catalog'),
  ('job.view.all',        'View the company''s job catalog'),
  ('position.manage.all', 'Create, edit, freeze/abolish positions, and assign or unassign employees'),
  ('position.view.all',   'View the company''s positions');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key IN ('job.manage.all', 'job.view.all', 'position.manage.all', 'position.view.all');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'line_manager' AND p.key IN ('job.view.all', 'position.view.all');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'employee_self_service' AND p.key IN ('job.view.all', 'position.view.all');
