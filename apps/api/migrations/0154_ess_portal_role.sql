-- 0154 - "Employee Self Service" role (key ess_portal): the role whose home is the ESS tile launchpad.
--
-- A separate role next to employee_self_service (label "Employee (Self-Service)"). At the time of this migration it
-- grants exactly what employee_self_service grants: every role_permissions row and every field_permission_rules row of
-- employee_self_service is copied. Nothing is invented. Permissions added to employee_self_service by LATER migrations
-- are not copied automatically; ess-role-parity.spec.ts fails when the two sets drift, so the later migration must grant
-- the same permission to ess_portal as well.
--
-- Idempotent: the role is inserted once; copies skip rows that already exist.
--
-- ROLLBACK: DELETE FROM user_role_assignments WHERE role_id = (SELECT id FROM roles WHERE key = 'ess_portal');
--           DELETE FROM roles WHERE key = 'ess_portal';   -- role_permissions and field_permission_rules cascade.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO roles (key, name, description) VALUES
  ('ess_portal', 'Employee Self Service',
   'Self-service employee with the Employee Self Service launchpad as home. Same access as the Employee (Self-Service) role: own record, own leave, attendance, payslips, performance, expenses and learning; no access to anyone else''s data.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT ess.id, rp.permission_id
FROM roles ess
JOIN roles base ON base.key = 'employee_self_service'
JOIN role_permissions rp ON rp.role_id = base.id
WHERE ess.key = 'ess_portal'
ON CONFLICT DO NOTHING;

INSERT INTO field_permission_rules (role_id, object_key, field_key, access, condition)
SELECT ess.id, fpr.object_key, fpr.field_key, fpr.access, fpr.condition
FROM roles ess
JOIN roles base ON base.key = 'employee_self_service'
JOIN field_permission_rules fpr ON fpr.role_id = base.id
WHERE ess.key = 'ess_portal'
  AND NOT EXISTS (
    SELECT 1 FROM field_permission_rules x
    WHERE x.role_id = ess.id AND x.object_key = fpr.object_key AND x.field_key = fpr.field_key
      AND x.access = fpr.access AND x.condition IS NOT DISTINCT FROM fpr.condition
  );
