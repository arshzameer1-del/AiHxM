-- Phase 10 seed — Recruitment & Onboarding permissions.
--
-- A single scope-less permission for the whole object graph
-- (requisitions, candidates, applications, offers), granted to
-- `hr_admin` only — unlike Leave (Phase 9), there is no self-service
-- caller here at all: a candidate never logs in, and this phase doesn't
-- yet build a "hiring manager reviews their own requisition's pipeline"
-- view (a real, deliberate scope narrowing — see KNOWN_ISSUES.md).
-- `workflow_template.manage.all` (0004_rbac.sql) is what actually lets
-- an admin configure the requisition-approval chain; nothing new needed
-- there either.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('recruitment.manage.all', 'Create/manage job requisitions, candidates, pipeline stages, and offers');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key = 'recruitment.manage.all';
