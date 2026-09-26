-- Organization Management, Phase 5 seed — permissions for the
-- Reorganization workflow, same pattern as every prior phase's own seed
-- migration (0066/0069/0072/0074).
--
-- Two permissions, split the same "manage vs. view" way every prior phase
-- split its own: drafting/validating/submitting/executing a reorg batch
-- is an HR Admin action (`org_change.manage.all`); SEEING one (a manager
-- watching a pending reorg that will touch their team, an employee
-- self-service session with nothing to act on but a right to see change
-- history) is the same broader audience every other Organization
-- Management view permission already reaches.
--
-- Deciding on a step (approve/reject) is deliberately NOT gated by a
-- separate permission here — exactly LeaveRequestsService's own precedent
-- (its decide() doc comment): WorkflowService.decide() itself throws
-- ForbiddenException for a caller who isn't a resolved approver on the
-- template's current step, so the workflow IS the authorization
-- mechanism for that action, not `org_change.manage.all`.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('org_change.manage.all', 'Draft, validate, submit, and execute reorganization changes'),
  ('org_change.view.all',   'View reorganization changes and their approval/execution history');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key IN ('org_change.manage.all', 'org_change.view.all');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'line_manager' AND p.key IN ('org_change.view.all');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'employee_self_service' AND p.key IN ('org_change.view.all');
