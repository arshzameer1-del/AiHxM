-- Organization Management, Phase 3 seed — permissions for Employee
-- Organizational Assignment + Reporting Relationships, same pattern as
-- 0066_organization_units_seed.sql/0069_job_position_seed.sql.
--
-- Four permissions, split the same way Phase 1/2 split `*.manage.all` from
-- `*.view.all`: creating/ending an employee's org assignment or reporting
-- relationship is an HR Admin configuration action, while SEEING them is
-- useful to the same broader audience Org Units/Jobs/Positions already
-- are — a Line Manager needs to see their own reports' assignments and
-- reporting lines, and an employee benefits from seeing their own the same
-- way they can already see their own org unit/position. All four are
-- deliberately scope-less, same as every other Organization Management
-- permission so far.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('employee_org_assignment.manage.all', 'Create, edit, and end employee organizational assignments'),
  ('employee_org_assignment.view.all',   'View employee organizational assignments'),
  ('org_relationship.manage.all',        'Create, edit, and end typed reporting relationships'),
  ('org_relationship.view.all',          'View typed reporting relationships');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key IN (
  'employee_org_assignment.manage.all', 'employee_org_assignment.view.all',
  'org_relationship.manage.all', 'org_relationship.view.all'
);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'line_manager' AND p.key IN ('employee_org_assignment.view.all', 'org_relationship.view.all');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'employee_self_service' AND p.key IN ('employee_org_assignment.view.all', 'org_relationship.view.all');
