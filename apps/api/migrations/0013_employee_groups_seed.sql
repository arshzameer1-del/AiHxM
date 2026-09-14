-- Phase 8 seed — permissions for Employee Groups & Leave Policy config.
--
-- Both new permissions are deliberately scope-less (no .self/.all/.team
-- suffix) — RbacService.can()'s own doc comment already covers this case
-- ("a permission with neither suffix is treated as scope-less: holding it
-- is sufficient on its own"). These are tenant-wide configuration actions
-- (define a group, define a policy, wire them together), not per-record
-- data access the way employee.view is — there is no "your own employee
-- group" concept to scope against.
--
-- Granted to hr_admin only, matching Section 3's Module Admin tier: an
-- HR Admin configures policy for their company; a Line Manager or an
-- employee themselves never should.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('employee_group.manage', 'Define employee groups (attribute-based segments) and their conditions'),
  ('leave_policy.manage',   'Define leave policies and assign them to employee groups');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key IN ('employee_group.manage', 'leave_policy.manage');
