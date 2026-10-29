-- 0193 - ess_portal must hold exactly what employee_self_service holds (see 0154). 0188 (assets) and 0189 (travel) granted their
-- own-data permissions to employee_self_service only, so people whose login holds just the Employee Self Service (ess_portal) role could
-- not see My Assets or ask to travel. Copy the two grants. Idempotent.
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);
INSERT INTO role_permissions (role_id, permission_id)
SELECT ess.id, rp.permission_id
FROM roles ess
JOIN roles base ON base.key = 'employee_self_service'
JOIN role_permissions rp ON rp.role_id = base.id
WHERE ess.key = 'ess_portal'
ON CONFLICT DO NOTHING;
