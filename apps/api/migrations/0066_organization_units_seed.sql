-- Organization Management, Phase 1 seed — permissions for the Org Unit
-- hierarchy, same pattern as every other feature module's own seed
-- migration (0013_employee_groups_seed.sql, 0027_shift_management_seed.sql).
--
-- Two permissions, deliberately split the same way Shift Management split
-- `shift.manage.all` from `shift.view.*`: defining/reorganizing the
-- hierarchy is an HR Admin configuration action (no self/team concept —
-- there is no "your own org unit"), while SEEING the hierarchy (the
-- Hierarchy Explorer) is useful to a much broader audience — a Line
-- Manager needs to see where their team sits, and an ordinary employee
-- benefits from an org chart of their own company the same way
-- `employee.view.self` already lets them see their own record. Both are
-- deliberately scope-less (no .self/.team suffix) — RbacService.can()'s
-- own doc comment already covers this ("a permission with neither suffix
-- is treated as scope-less: holding it is sufficient on its own"), the
-- same shape `employee_group.manage` uses.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('org_unit.manage.all', 'Create, edit, move, and archive the company''s org unit hierarchy'),
  ('org_unit.view.all',   'View the company''s org unit hierarchy');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key IN ('org_unit.manage.all', 'org_unit.view.all');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'line_manager' AND p.key = 'org_unit.view.all';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'employee_self_service' AND p.key = 'org_unit.view.all';
