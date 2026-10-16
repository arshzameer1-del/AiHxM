-- Parked B4 (2026-10-16): Employee Self Service and Line Manager must not list other people's organizational
-- assignments or reporting-line relationships. Those two views name who sits where and who reports to whom for the whole
-- company; an Employee gets their own position from My Org Chart (GET /employees/me/org-chart, self scoped) and the
-- screens that use these lists (Assignments, Reporting Lines, org unit and position details) are HR Admin only.
--
-- employee_self_service, ess_portal and line_manager lose employee_org_assignment.view.all and org_relationship.view.all.
-- hr_admin keeps them; regional_hr keeps its scoped view (employee_org_assignment.view.scoped).
-- The org chart itself (org_unit/job/position/location view.all) is NOT touched.
-- The two Employee roles change together (ess-role-parity.spec.ts fails if they drift). Idempotent.
--
-- ROLLBACK:
--   INSERT INTO role_permissions (role_id, permission_id)
--   SELECT r.id, p.id FROM roles r, permissions p
--   WHERE r.key IN ('employee_self_service','ess_portal','line_manager')
--     AND p.key IN ('employee_org_assignment.view.all','org_relationship.view.all')
--   ON CONFLICT DO NOTHING;

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

DELETE FROM role_permissions rp
USING roles r, permissions p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND r.key IN ('employee_self_service', 'ess_portal', 'line_manager')
  AND p.key IN ('employee_org_assignment.view.all', 'org_relationship.view.all');
