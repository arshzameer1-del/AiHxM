-- Phase 6 — seed the one new permission the Workflow engine introduces.
--
-- `workflow_template.manage.all` gates WorkflowService.createTemplate/
-- listTemplates (apps/api/src/workflow/workflow.service.ts) — this is
-- the plan doc's "a Module Admin defines their own approval chain ...
-- without engineering involvement" (Section 6), so it's a role-driven
-- RBAC permission like everything else in this codebase, not a
-- Platform-Admin-only action. Granted here to the existing
-- `rbac_demo_full_access` demo role (0004_rbac.sql) purely so this
-- phase's test suite has a role to exercise it with — the same
-- scaffolding-not-a-product-catalog posture that role has always had.
-- A real module's own migration seeds its own roles/permissions the same
-- way (see 0004_rbac.sql's own header comment on this pattern).

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('workflow_template.manage.all', 'Create and view workflow templates for the tenant');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'rbac_demo_full_access' AND p.key = 'workflow_template.manage.all';
