-- Configuration Center registration for Core Employee Enterprise Phase 3
-- (the Hiring Card Designer's scoped admin surface — enable/disable and
-- reorder, per kumail's own scoping decision on this initiative). Same
-- one-row-INSERT pattern as 0067/0070/0075's own header comments.
--
-- ConfigurationCenterService.getSummary() (this migration's companion
-- code change) calls HiringProcessService.listCardDefinitions() with the
-- caller's real claims — no new store, no duplicate query, same
-- "reuse the domain's own gated method" discipline as every other row.
--
-- sort_order = 11, after every existing domain (5-10) — hiring
-- configuration builds on Org Unit/Job/Location/Cost/Profit Center all
-- being in place first. Existing rows' sort_order values are untouched.
INSERT INTO configuration_registry
  (domain_key, label, description, manage_permission, view_permission, admin_route, supports_effective_dating, sort_order)
VALUES
  ('core_employee_hiring', 'Hiring Cards', 'Which hiring cards are enabled, and their order.', 'employee.manage.all', 'employee.manage.all', '/app/configuration-center/hiring', false, 11)
ON CONFLICT (domain_key) DO NOTHING;
