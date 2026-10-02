-- Payroll Areas seed (companion to 0101_payroll_areas.sql) — the
-- permissions that make Payroll Area-based Data Scope enforceable, plus
-- one role that exercises them.
--
-- `.all`/`.scoped` are ALTERNATIVES, never layers — the convention 0079
-- established for Organization Management: a role holds one or the other
-- per object. `.all` = every run/area in the company, exactly as before
-- this migration. `.scoped` = only runs whose payroll_area_id resolves
-- (via payroll_area_scope_links) into the caller's own
-- data_scope_assignments; a company-wide run (payroll_area_id NULL) is
-- NEVER reachable with `.scoped` alone. Enforced in PayrollService /
-- PayrollAreasService (see each one's `resolve*Access()` helpers).
--
-- Deliberately NOT given `.scoped` variants: `payroll.approve.all` (the
-- segregation-of-duties approver gate stays company-wide), and run
-- reversal (still requires BOTH `payroll.finalize.all` AND
-- `payroll.disburse.all` — "elevated authorization", Section 36).
-- Settings and tax slabs are company-wide configuration and stay `.all`.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('payroll_area.manage.all', 'Create, update, deactivate and scope-link every payroll area in the company, and assign any employee to one'),
  ('payroll_area.manage.scoped', 'View and update only the payroll areas within the caller''s data scope, and assign employees to them'),
  ('payroll.calculate.scoped', 'Create, calculate and submit payroll runs only for payroll areas within the caller''s data scope'),
  ('payroll.finalize.scoped', 'Finalize approved payroll runs only for payroll areas within the caller''s data scope'),
  ('payroll.disburse.scoped', 'Generate bank disbursement files only for payroll runs of payroll areas within the caller''s data scope')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key = 'payroll_area.manage.all'
ON CONFLICT DO NOTHING;

INSERT INTO roles (key, name, description) VALUES
  ('regional_payroll', 'Regional Payroll',
   'A payroll preparer restricted to the payroll areas inside their assigned org unit / location / cost center data scope — can create, calculate, submit, finalize and disburse only those areas'' runs, never a company-wide run.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'regional_payroll' AND p.key IN (
  'payroll_area.manage.scoped',
  'payroll.calculate.scoped',
  'payroll.finalize.scoped',
  'payroll.disburse.scoped'
)
ON CONFLICT DO NOTHING;
