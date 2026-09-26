-- Configuration Center registration for Organization Management Phase 1's
-- Org Unit hierarchy (0065_organization_units.sql).
--
-- Per the product owner's standing instruction for this initiative going
-- forward ("all objects relevant which required configuration should be in
-- configuration center of admin user"): Org Units ARE a configuration
-- object — a tenant-defined setup structure (departments/divisions/
-- business units) that other things (Employee Groups' department
-- condition, employee records) reference, exactly the same shape as
-- Employee Groups or Shifts already registered in 0032. This is a plain
-- one-row INSERT into the existing global `configuration_registry`
-- catalog — 0032's own header comment already names this the intended
-- extension mechanism ("a one-row INSERT in that increment's own
-- migration, not a reason to add a new mechanism"). No new store, no new
-- generic editing shell: ConfigurationCenterService.getSummary() (this
-- migration's companion code change) calls OrgUnitsService's own
-- `list()` with the caller's real claims, the same "reuse the domain's
-- own gated method" discipline every other row already follows.
--
-- sort_order = 5, ahead of every existing domain (10-70): the org unit
-- hierarchy is the most foundational of the configuration domains listed
-- here — Employee Groups' own `department` condition now resolves against
-- it (0065/EmployeeGroupsService) — so it reads first, not appended at
-- the end. Existing rows' sort_order values are untouched.
INSERT INTO configuration_registry
  (domain_key, label, description, manage_permission, view_permission, admin_route, supports_effective_dating, sort_order)
VALUES
  ('org_unit', 'Organization Structure', 'Departments, divisions, and business units.', 'org_unit.manage.all', 'org_unit.view.all', '/app/organization', true, 5)
ON CONFLICT (domain_key) DO NOTHING;
