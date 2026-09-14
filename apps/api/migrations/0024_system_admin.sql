-- Decision #20 (Task #52) — System Admin role.
--
-- Closes the single most urgent functional gap named in Decisions #18/#19:
-- `workflow_template.manage.all` (0008_workflow_seed.sql) was granted only
-- to `rbac_demo_full_access`, a Phase 4 proof-of-concept role never
-- assigned to a real company — meaning no real tenant login could ever
-- configure the approval routing both Leave (Decision #18) and
-- Recruitment (Decision #19) require. This migration does not touch that
-- permission's existing grant (the demo role keeps it, unchanged, since
-- Phase 4/6's own test suites still reference it); it adds a second,
-- real, additive grant path.
--
-- This is also this session's answer to the user's own request for a
-- distinct "System/Module Admin" role, modeled on SAP SuccessFactors'
-- Admin Center: separate from `hr_admin`, able to configure approval
-- workflows and manage who has which login/role. The comparison against
-- the user-supplied SuccessFactors-style RBP specification (see Decision
-- #19's closing section) concluded the current fixed-catalog RBAC engine
-- stays as-is for now — this role is one more hardcoded row in that
-- catalog, not a step toward the full data-driven rebuild that comparison
-- also considered and deliberately deferred.
--
-- Additive, not exclusive: `system_admin` is a fourth real tenant role
-- alongside `hr_admin`/`line_manager`/`employee_self_service`
-- (0011_employee_seed.sql). `user_role_assignments` already supports a
-- user_account_id holding multiple roles in the same company — a company
-- can assign this to the same person as `hr_admin`, or split the two
-- across different people. Nothing here removes or narrows any existing
-- role's permissions.
--
-- Two new permissions, deliberately narrow rather than one broad
-- "system_admin.manage.all":
--   - `role_assignment.manage.all` gates the new tenant-scoped role
--     assignment API (apps/api/src/system-admin/) — the real-tenant
--     counterpart to the Platform-Admin-only `/platform/role-assignments`
--     (0004_rbac.sql's own header comment named this as a deliberately
--     deferred "Company Super Admin self-service" enhancement; this is
--     that enhancement, now that a real need exists).
--   - `user_account.manage.all` widens who may call the ALREADY-EXISTING
--     `POST /employees/:id/account` (EmployeesService.createLogin(),
--     Decision #12) beyond `employee.manage.all` alone — a System Admin
--     who does not hold full HR-Admin employee-management rights can
--     still provision a login for an existing employee, matching real
--     SuccessFactors' separation between Employee Central management and
--     User/Permission administration. See employees.service.ts's own
--     updated comment on `requireModuleAndAccountPermission()`.
--
-- Bootstrap note (not solved here, deliberately): creating a BRAND NEW
-- company's very first login of any kind already requires Platform Admin
-- staff assistance today — there is no self-service onboarding wizard for
-- `hr_admin` either (0002/0004's `is_service`-only INSERT policies see to
-- that, by design). This migration doesn't change that. Once a company's
-- first `hr_admin` login exists (staff-assisted, as today), that HR Admin
-- can grant `system_admin` to themselves or anyone else the same way they
-- already grant `hr_admin`/`line_manager`/`employee_self_service` today:
-- via `createLogin()`, whose allowed role list this migration's
-- accompanying `employees.service.ts` change widens to include
-- `system_admin`. No further Platform Admin involvement is needed after
-- that first login exists.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('role_assignment.manage.all', 'View, assign, and revoke tenant roles for logins in your own company'),
  ('user_account.manage.all', 'Create a login for an existing employee record in your own company');

INSERT INTO roles (key, name, description) VALUES
  ('system_admin', 'System Admin',
   'Module Admin tier (plan doc Section 3), SuccessFactors Admin-Center-style: configures approval workflows for every licensed module and manages who has which login and role. Deliberately holds no rights over employee HR data itself (no employee.* permissions) — that stays hr_admin''s job, additive alongside this role rather than replaced by it.');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'system_admin'
  AND p.key IN ('workflow_template.manage.all', 'role_assignment.manage.all', 'user_account.manage.all');
