-- Configuration Center registration for Onboarding & Offboarding's
-- checklist-item TEMPLATES (0035_onboarding_offboarding.sql) — same
-- one-row-INSERT pattern as 0067/0070/0075/0083's own header comments.
--
-- Onboarding and Offboarding each let a company configure a list of
-- checklist-item templates once (title/category/responsible role),
-- which get cloned into a real employee's checklist at
-- initiate()/complete() time — the exact same "definition vs. instance"
-- split that put Job (not Position) and Org Unit in this index already.
-- ConfigurationCenterService.getSummary() (this migration's companion
-- code change) calls OnboardingService.listItemTemplates() and
-- OffboardingService.listItemTemplates() with the caller's real claims
-- — no new store, no duplicate query, same "reuse the domain's own
-- gated method" discipline as every other row.
--
-- Deliberately only these two rows, not three: Recruitment and
-- Performance were both read for this increment and neither currently
-- has an analogous "setup data" catalog to register (see the companion
-- comment in configuration-center.service.ts's countFor() for the full
-- reasoning — recruitment's pipeline stages are a fixed code constant,
-- not stored/configurable, and performance's review cycles are
-- transactional instances, not reusable templates, with its 1-5 rating
-- scale explicitly documented in 0019_performance.sql as deliberately
-- not tenant-configurable yet).
--
-- sort_order = 12/13, immediately after core_employee_hiring (11).
-- Existing rows' sort_order values are untouched.
INSERT INTO configuration_registry
  (domain_key, label, description, manage_permission, view_permission, admin_route, supports_effective_dating, sort_order)
VALUES
  ('onboarding_checklist_template', 'Onboarding Checklists', 'Checklist-item templates cloned onto every new hire''s onboarding.', 'onboarding.manage.all', NULL, '/app/admin?tab=checklists', false, 12),
  ('offboarding_checklist_template', 'Offboarding Checklists', 'Checklist-item templates cloned onto every exiting employee''s offboarding.', 'offboarding.manage.all', NULL, '/app/admin?tab=checklists', false, 13)
ON CONFLICT (domain_key) DO NOTHING;
