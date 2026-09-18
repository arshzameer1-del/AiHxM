-- Configuration Center: a unified, discoverable index of every place in the
-- product where an admin can change tenant-specific business configuration.
--
-- Today (verified against the running schema before this migration): leave
-- policies, tax slabs, workflow templates, custom field definitions, shifts,
-- and holidays each have their own real, working, per-module admin screen
-- (Admin Center's tabs, System Admin's Workflow Templates tab, Payroll
-- Settings) -- but there is no single place an HR Admin can go to see "what
-- is configurable in this system" without already knowing which of six
-- separate screens to open. This migration adds a small, GLOBAL (not
-- tenant-owned) catalog table describing those configuration domains --
-- mirroring `module_catalog` (0006_module_entitlement.sql) exactly: a plain
-- `key text PRIMARY KEY` row per domain, no `company_id`, no RLS, because
-- this describes the PRODUCT's configurable surface (which screens exist),
-- not any tenant's business data. It is not writable via any tenant-facing
-- API -- only ever read, the same way `module_catalog` is.
--
-- This is deliberately just a catalog/index, not a new place configuration
-- is stored: `ConfigurationCenterService` (apps/api/src/configuration-center/)
-- reads live counts from each domain's OWN existing service method
-- (EmployeeGroupsService.listLeavePolicies, PayrollService.listTaxSlabs,
-- WorkflowService.listTemplates, CustomFieldsService.listDefinitions,
-- ShiftsService.listShifts, HolidaysService.listHolidays) rather than
-- duplicating any of that data here -- consistent with this codebase's
-- "derive, don't duplicate" discipline (see Shift Management's attendance
-- status, which is computed at read time rather than stored).
--
-- Extending this catalog when a new configurable domain ships later is a
-- one-row INSERT in that increment's own migration, the same as adding a
-- new module to `module_catalog` today -- not a reason to add a new
-- mechanism.
CREATE TABLE IF NOT EXISTS configuration_registry (
  domain_key                text PRIMARY KEY,
  label                     text NOT NULL,
  description               text NOT NULL,
  manage_permission         text NOT NULL,
  -- Null when the manage permission itself already implies view access
  -- (e.g. holiday.manage.all does not separately need holiday.view.all --
  -- HolidaysService.createHoliday's own check already proves manage callers
  -- can act on holidays; a distinct view permission is listed here only
  -- when one exists and is meaningfully broader, e.g. holiday.view.all is
  -- also granted to non-managing roles).
  view_permission           text,
  admin_route               text NOT NULL,
  supports_effective_dating boolean NOT NULL DEFAULT false,
  sort_order                integer NOT NULL DEFAULT 0,
  created_at                timestamptz NOT NULL DEFAULT now()
);

INSERT INTO configuration_registry
  (domain_key, label, description, manage_permission, view_permission, admin_route, supports_effective_dating, sort_order)
VALUES
  ('leave_policy', 'Leave Policies', 'Leave types, entitlements, and the employee-group conditions that decide which policy applies to whom.', 'leave_policy.manage', NULL, '/app/admin?tab=policies', false, 10),
  ('employee_group', 'Employee Groups', 'The condition-matching rules (department, location, designation, employment type/status) that drive policy resolution.', 'employee_group.manage', NULL, '/app/admin?tab=groups', false, 20),
  ('shift', 'Shifts', 'Shift definitions and effective-dated per-employee shift assignments.', 'shift.manage.all', 'shift.view.team', '/app/admin?tab=shifts', true, 30),
  ('holiday', 'Holidays', 'The company holiday calendar, including which holidays are optional.', 'holiday.manage.all', 'holiday.view.all', '/app/admin?tab=holidays', false, 40),
  ('workflow_template', 'Workflow Templates', 'Approval chains: who approves what, in what order, with what SLA escalation.', 'workflow_template.manage.all', NULL, '/app/system-admin?tab=workflows', false, 50),
  ('custom_field', 'Custom Fields', 'Tenant-defined fields added to employees and other records.', 'custom_field.manage.all', NULL, '/app/admin?tab=custom-fields', false, 60),
  -- PayrollPage has no tab/anchor mechanism (it's one page with
  -- collapsible sections, not tabs like Admin Center/System Admin) --
  -- this links to the page itself; the "Settings & Tax Slabs" section
  -- is one click away, not deep-linked to directly.
  ('tax_slab', 'Tax Slabs & Statutory Rates', 'FBR income tax slabs and EOBI/social-security contribution rates.', 'payroll.manage.all', NULL, '/app/payroll', false, 70)
ON CONFLICT (domain_key) DO NOTHING;

-- Read-only from the app's perspective (see the table's own header
-- comment), but every runtime query still goes through `app_role` (the
-- role every tenant-context connection actually runs as, per
-- database.service.ts's own doc comment) — SELECT-only here, matching
-- that this catalog is never written by any tenant-facing API.
GRANT SELECT ON configuration_registry TO app_role;
