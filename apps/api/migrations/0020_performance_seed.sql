-- Phase 11 seed — permissions and field-visibility rules for
-- Performance & Goals, granted to the same three real roles Phase 7
-- introduced.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- `performance.manage.all` is deliberately one scope-less permission
-- covering cycle/goal administration AND calibration/release for
-- hr_admin, the same "one HR-only permission for a whole object graph"
-- shape Decision #10 used for `recruitment.manage.all` — nothing in this
-- object graph needs a finer HR-facing split yet.
INSERT INTO permissions (key, description) VALUES
  ('performance.manage.all',        'Create and launch review cycles, manage any goal, and calibrate/release any performance review'),
  ('performance_goal.manage.self',  'Create and update your own goals'),
  ('performance_goal.manage.team',  'Create and update goals for your direct reports'),
  ('performance_review.view.self',  'View your own performance review'),
  ('performance_review.view.team',  'View performance reviews of your direct reports'),
  ('performance_review.view.all',   'View any performance review in your company'),
  ('performance_review.submit_self.self',    'Submit your own self-assessment'),
  ('performance_review.submit_manager.team', 'Submit a manager assessment for a direct report');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin'
  AND p.key IN ('performance.manage.all', 'performance_review.view.all');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'line_manager'
  AND p.key IN ('performance_goal.manage.team', 'performance_review.view.team', 'performance_review.submit_manager.team');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'employee_self_service'
  AND p.key IN ('performance_goal.manage.self', 'performance_review.view.self', 'performance_review.submit_self.self');

-- Field-visibility rules on the `performance_review` object — the same
-- conditional mechanism Phase 7 seeded for `terminationReason`, applied
-- here to a status the record transitions through over its own
-- lifecycle rather than a fixed classification. hr_admin sees everything
-- unconditionally (they run calibration); line_manager sees their own
-- input (managerAssessment/managerRating) unconditionally but the
-- calibration/final fields only once released; employee_self_service
-- sees NONE of it until released, at which point all five become
-- visible together.
INSERT INTO field_permission_rules (role_id, object_key, field_key, access, condition)
SELECT id, 'performance_review', f.field_key, 'view', NULL
FROM roles, unnest(ARRAY['managerAssessment', 'managerRating', 'finalRating', 'calibrationRating', 'calibrationComment']) AS f(field_key)
WHERE key = 'hr_admin';

INSERT INTO field_permission_rules (role_id, object_key, field_key, access, condition)
SELECT id, 'performance_review', f.field_key, 'view', NULL
FROM roles, unnest(ARRAY['managerAssessment', 'managerRating']) AS f(field_key)
WHERE key = 'line_manager';

INSERT INTO field_permission_rules (role_id, object_key, field_key, access, condition)
SELECT id, 'performance_review', f.field_key, 'view', '{"field": "status", "equals": "released"}'::jsonb
FROM roles, unnest(ARRAY['finalRating', 'calibrationRating', 'calibrationComment']) AS f(field_key)
WHERE key = 'line_manager';

INSERT INTO field_permission_rules (role_id, object_key, field_key, access, condition)
SELECT id, 'performance_review', f.field_key, 'view', '{"field": "status", "equals": "released"}'::jsonb
FROM roles, unnest(ARRAY['managerAssessment', 'managerRating', 'finalRating', 'calibrationRating', 'calibrationComment']) AS f(field_key)
WHERE key = 'employee_self_service';
