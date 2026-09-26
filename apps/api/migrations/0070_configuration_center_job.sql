-- Configuration Center registration for Organization Management Phase 2's
-- Job catalog (0068_job_position_architecture.sql) — same one-row-INSERT
-- pattern as 0067_configuration_center_org_units.sql.
--
-- Job IS setup data (a company defines its job titles/families/levels
-- once and reuses them across many positions) and belongs in the
-- Configuration Center index, the same shape as Org Units. Position is
-- deliberately NOT registered here: it is operational/transactional data
-- (a Position Workbench concern — who occupies which seat right now),
-- not a reusable setup catalog, per the product owner's explicit
-- instruction for this phase. ConfigurationCenterService.getSummary()
-- (this migration's companion code change) calls JobsService's own
-- `list()` with the caller's real claims — no new store, no duplicate
-- query, same "reuse the domain's own gated method" discipline as every
-- other row.
--
-- sort_order = 6, immediately after org_unit (5) — Job is the next most
-- foundational configuration domain Position Management builds on.
-- Existing rows' sort_order values are untouched.
INSERT INTO configuration_registry
  (domain_key, label, description, manage_permission, view_permission, admin_route, supports_effective_dating, sort_order)
VALUES
  ('job', 'Job Catalog', 'Job titles, families, and levels used across positions.', 'job.manage.all', 'job.view.all', '/app/organization/jobs', true, 6)
ON CONFLICT (domain_key) DO NOTHING;
