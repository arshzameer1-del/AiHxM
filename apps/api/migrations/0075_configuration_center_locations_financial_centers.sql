-- Configuration Center registration for Organization Management Phase 4's
-- Location hierarchy, Cost Centers, and Profit Centers
-- (0073_locations_and_financial_centers.sql) — same one-row-INSERT pattern
-- as 0067_configuration_center_org_units.sql/0070_configuration_center_job.sql.
--
-- All three ARE setup data (a company defines its locations/cost centers/
-- profit centers once and reuses them across employees/positions), the
-- same reasoning that put Org Units and Job in this index. This is the
-- direct counterpart to Phase 2's own precedent of registering Job (a
-- reusable catalog) while leaving Position out (transactional) — none of
-- Location/Cost Center/Profit Center are transactional in that sense, so
-- all three get a card.
--
-- ConfigurationCenterService.getSummary() (this migration's companion code
-- change) calls each service's own `list()` with the caller's real claims
-- — no new store, no duplicate query, same "reuse the domain's own gated
-- method" discipline as every other row.
--
-- sort_order = 7/8/9, immediately after job (6).
INSERT INTO configuration_registry
  (domain_key, label, description, manage_permission, view_permission, admin_route, supports_effective_dating, sort_order)
VALUES
  ('location', 'Locations', 'The company''s location hierarchy — countries, regions, cities, sites, and buildings.', 'location.manage.all', 'location.view.all', '/app/organization/locations', true, 7),
  ('cost_center', 'Cost Centers', 'Cost centers used to tag positions for financial reporting.', 'cost_center.manage.all', 'cost_center.view.all', '/app/organization/financial-centers', true, 8),
  ('profit_center', 'Profit Centers', 'Profit centers used to tag positions for financial reporting.', 'profit_center.manage.all', 'profit_center.view.all', '/app/organization/financial-centers', true, 9)
ON CONFLICT (domain_key) DO NOTHING;
