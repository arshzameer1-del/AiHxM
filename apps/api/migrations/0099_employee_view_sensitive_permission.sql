-- ---------------------------------------------------------------------
-- Cross-module integration audit Item 8 (2026-10-01) — Employee field
-- sensitivity tiers as an ENFORCED default floor, not just audit labels.
--
-- `employee-field-sensitivity.ts` classifies `cnic` as Restricted and
-- `bankAccountNumber` as Highly Restricted, but until now the tiers only
-- drove view-audit-logging; redaction came solely from whichever
-- `field_permission_rules` rows a role happened to have. The tiers now act
-- as the default for any Restricted/Highly Restricted field a viewer's
-- roles have NO explicit rule for (see `RbacService.evaluateFieldAccess()`'s
-- `unruledDefaults`):
--   - viewer holds `employee.view_sensitive.all` -> visible ('view');
--   - otherwise                                   -> redacted (key omitted).
-- An explicit rule always wins in either direction — a tenant can still
-- grant a role view on a Restricted field without this permission, or set
-- 'hidden' to withhold it from a role that does hold it. The floor only
-- decides what was previously left implicit.
--
-- `hr_admin` already holds explicit 'view' rules on both fields
-- (0011_employee_seed.sql), so granting it this permission changes nothing
-- for it today; it is granted so that a NEW Restricted/Highly Restricted
-- field added later (a classification-only change in
-- employee-field-sensitivity.ts) is visible to HR Admin by default and
-- redacted for everyone else, without needing a field_permission_rules
-- seed for every role. No other role is granted it.
-- ---------------------------------------------------------------------

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('employee.view_sensitive.all', 'View Restricted and Highly Restricted employee fields (e.g. CNIC, bank account number) that no explicit field rule covers for your role')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key = 'employee.view_sensitive.all'
ON CONFLICT DO NOTHING;
