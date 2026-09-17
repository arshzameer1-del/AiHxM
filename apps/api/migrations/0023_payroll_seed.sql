-- Phase 12 seed — permissions for Compensation & Payroll. Exactly two,
-- per Decision #14's "no separate Finance Admin role" call: hr_admin
-- keeps the same "one HR-only permission for a whole object graph" shape
-- Decision #10/#11 already used for recruitment.manage.all and
-- performance.manage.all (settings, tax slabs, compensation, run
-- calculate/finalize, disbursement all live behind it), and employees
-- get a single self-scoped permission to view their own released
-- payslip. Segregation-of-duties (a real, deferred concern — one role
-- can both run and disburse payroll) is logged in KNOWN_ISSUES.md, not
-- solved here.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('payroll.manage.all',       'Manage payroll settings and tax slabs, set employee compensation, calculate/finalize payroll runs, and view any payslip'),
  ('payroll_review.view.self', 'View your own finalized payslip');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key = 'payroll.manage.all';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'employee_self_service' AND p.key = 'payroll_review.view.self';
