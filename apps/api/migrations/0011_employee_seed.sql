-- Phase 7 — Employee Core RBAC seed
--
-- Real product roles, not the "rbac_demo_*" proof-of-concept ones from
-- 0004_rbac.sql (those stay untouched — dummy.service.spec/e2e specs
-- still reference them by key). These three are Section 3's "ordinary
-- end-user roles" made concrete against a real object for the first time:
-- HR Admin (Module Admin tier), Line Manager, and Employee (self-service).
--
-- `employee.view` gets a THIRD scope suffix beyond Phase 4's `.self`/
-- `.all`: `.team` — exactly the case plan doc Section 2 names explicitly
-- ("a Manager sees their team's salary only if the tenant specifically
-- grants salary.view.team"). RbacService.can()'s `.team` branch (added
-- this phase, see Decision #7) resolves it as "the record's manager has
-- the same user_account_id as the caller" — direct reports only, not the
-- whole org subtree beneath a manager. A recursive "see your entire
-- reporting chain" scope is a real future refinement, deliberately not
-- built now (Section 10's guardrail against over-building ahead of an
-- actual BPD need) — tracked in DECISIONS.md.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('employee.view.self',    'View your own employee record'),
  ('employee.view.team',    'View employee records of your direct reports'),
  ('employee.view.all',     'View any employee record in your company'),
  ('employee.manage.all',   'Create, update, and terminate employee records; attach documents; record job history');

INSERT INTO roles (key, name, description) VALUES
  ('hr_admin', 'HR Admin',
   'Module Admin tier (plan doc Section 3): full read/write on every employee record in the company, including every sensitive field, subject to the conditional Termination Reason rule below.'),
  ('line_manager', 'Line Manager',
   'Sees their direct reports'' records (not the whole company) and, per Section 2''s own example, their team''s salary band specifically — nothing else sensitive.'),
  ('employee_self_service', 'Employee (Self-Service)',
   'Sees only their own record, including their own CNIC/DOB/bank details (their own data) but not their own Termination Reason and not anyone else''s record at all.');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key IN ('employee.view.all', 'employee.manage.all');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'line_manager' AND p.key = 'employee.view.team';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'employee_self_service' AND p.key = 'employee.view.self';

-- hr_admin: every sensitive field visible, Termination Reason only when
-- employmentStatus = 'terminated' — the plan doc's own Termination Reason
-- example (Section 2), now built against a real object instead of only
-- described in prose.
INSERT INTO field_permission_rules (role_id, object_key, field_key, access, condition)
SELECT id, 'employee', f.field_key, 'view', NULL
FROM roles, unnest(ARRAY['cnic', 'dateOfBirth', 'salaryBand', 'bankAccountNumber']) AS f(field_key)
WHERE roles.key = 'hr_admin';
INSERT INTO field_permission_rules (role_id, object_key, field_key, access, condition)
SELECT id, 'employee', 'terminationReason', 'view', '{"field": "employmentStatus", "equals": "terminated"}'::jsonb
FROM roles WHERE key = 'hr_admin';

-- line_manager: salaryBand only, view access — Section 2's own example,
-- verbatim. cnic/dateOfBirth/bankAccountNumber/terminationReason all fall
-- through to the engine's safe-deny default for this role.
INSERT INTO field_permission_rules (role_id, object_key, field_key, access, condition)
SELECT id, 'employee', 'salaryBand', 'view', NULL FROM roles WHERE key = 'line_manager';

-- employee_self_service: an employee can see their own CNIC/DOB/bank/
-- salary — it's their own data — but not their own Termination Reason
-- (kept HR-only, same default-hidden posture as everything not listed
-- here).
INSERT INTO field_permission_rules (role_id, object_key, field_key, access, condition)
SELECT id, 'employee', f.field_key, 'view', NULL
FROM roles, unnest(ARRAY['cnic', 'dateOfBirth', 'salaryBand', 'bankAccountNumber']) AS f(field_key)
WHERE roles.key = 'employee_self_service';
