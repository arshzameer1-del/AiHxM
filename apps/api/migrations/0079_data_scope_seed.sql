-- Organization Management, Phase 11 seed — the `.scoped` view permissions
-- Section 19's Data Scope capability actually gates on, plus two new
-- roles that exercise them: `regional_hr` and `regional_finance`, named
-- directly after Section 19's own two examples. Every prior Organization
-- Management permission was deliberately scope-less (`.all` only, see
-- 0074's own header comment); this is the first phase to add a second
-- scope suffix, `.scoped`, alongside the existing `.all` — a role gets
-- ONE or the other per object, never both, the same way Employee Core's
-- `salary.view.self`/`.team`/`.all` are three alternatives, not layers.
--
-- `.scoped` is enforced by each object's own service (OrgUnitsService,
-- PositionsService, EmployeeOrgAssignmentsService, LocationsService,
-- CostCentersService — see each one's own `resolveViewAccess()`), which
-- restricts `list()`/`get()` to whatever `data_scope_assignments` rows
-- (0078) the caller holds, expanded to a subtree where the object is
-- hierarchical (org unit, location) or used flat where it isn't (cost
-- center). Holding a `.scoped` permission with zero assignment rows sees
-- nothing for that object — fails closed, not open.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('org_unit.view.scoped', 'View only the org units within the caller''s assigned org-unit data scope (each assigned unit''s own subtree)'),
  ('position.view.scoped', 'View only positions within the caller''s assigned org-unit or cost-center data scope'),
  ('employee_org_assignment.view.scoped', 'View only employee org assignments within the caller''s assigned org-unit or location data scope'),
  ('location.view.scoped', 'View only the locations within the caller''s assigned location data scope (each assigned location''s own subtree)'),
  ('cost_center.view.scoped', 'View only the cost centers within the caller''s assigned cost-center data scope');

INSERT INTO roles (key, name, description) VALUES
  ('regional_hr', 'Regional HR',
   'Section 19''s own example: an HR user restricted to their assigned org unit(s) — sees only that org unit''s (and its descendants'') org units, positions, employee org assignments, and locations, never the whole company.'),
  ('regional_finance', 'Regional Finance',
   'Section 19''s own example: a Finance user restricted to their assigned cost center(s) — sees only positions and cost centers tagged with those cost centers, never the whole company''s financial dimensions.');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'regional_hr' AND p.key IN (
  'org_unit.view.scoped',
  'position.view.scoped',
  'employee_org_assignment.view.scoped',
  'location.view.scoped'
);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'regional_finance' AND p.key IN (
  'cost_center.view.scoped',
  'position.view.scoped'
);
