-- Role access review (2026-10): Employee Self Service and Line Manager must not read finance master data or
-- reorganization plans (decision: Kumail, 2026-10-16).
--
-- employee_self_service, ess_portal and line_manager held cost_center.view.all, profit_center.view.all and
-- org_change.view.all only because they were seeded together with org_unit.view.all (the org chart). Cost centers and
-- profit centers are finance master data; reorganizations are confidential plans until published. The permissions stay
-- with hr_admin (view and manage); regional_finance keeps its scoped cost-center view.
--
-- The two Employee roles are changed together (ess-role-parity.spec.ts fails if they drift).
-- Idempotent: deleting rows that are already gone does nothing.
--
-- ROLLBACK:
--   INSERT INTO role_permissions (role_id, permission_id)
--   SELECT r.id, p.id FROM roles r, permissions p
--   WHERE r.key IN ('employee_self_service','ess_portal','line_manager')
--     AND p.key IN ('cost_center.view.all','profit_center.view.all','org_change.view.all')
--   ON CONFLICT DO NOTHING;

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

DELETE FROM role_permissions rp
USING roles r, permissions p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND r.key IN ('employee_self_service', 'ess_portal', 'line_manager')
  AND p.key IN ('cost_center.view.all', 'profit_center.view.all', 'org_change.view.all');
