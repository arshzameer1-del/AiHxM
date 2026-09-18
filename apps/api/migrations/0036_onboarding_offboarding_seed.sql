-- Onboarding & Offboarding seed — permission keys, granted to the same
-- three real roles every module since Phase 7 has used. Split
-- manage/view.team/view.self the same way Shift Management (0027) and
-- Attendance Corrections (0029) already do, since (unlike Holiday
-- Management's company-wide calendar) an onboarding/offboarding
-- checklist genuinely IS a fact scoped to one specific employee that
-- needs the usual self/team/all narrowing.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('onboarding.manage.all', 'Manage onboarding checklist templates and any employee''s onboarding'),
  ('onboarding.view.team',  'View and complete onboarding checklist items for your direct reports'),
  ('onboarding.view.self',  'View and complete your own onboarding checklist items'),
  ('offboarding.manage.all', 'Manage offboarding checklist templates, initiate/finalize any employee''s offboarding'),
  ('offboarding.view.team',  'View and complete offboarding checklist items for your direct reports'),
  ('offboarding.view.self',  'View and complete your own offboarding checklist items');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key IN ('onboarding.manage.all', 'offboarding.manage.all');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'line_manager' AND p.key IN ('onboarding.view.team', 'offboarding.view.team');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'employee_self_service' AND p.key IN ('onboarding.view.self', 'offboarding.view.self');
