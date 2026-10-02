-- Core Employee Configuration/HR-Admin v2, "then 2" Phases 4+5
-- (2026-10-02) — gap-table items #11 ("Configuration Hierarchy &
-- Resolution": global -> country -> tenant -> legal entity -> business
-- unit -> location -> position/job/group -> employee-level scoped
-- overrides) and #12 ("Mapping / Control Engine": a generic
-- configuration_domain/configuration_key/object_type/rule_type/
-- scope_type/priority rule-mapping table, Section 21).
--
-- Built as ONE engine, not two, and deliberately placed here in
-- HR Administration rather than a new module or Configuration Center
-- itself. Reasoning:
--
-- 1. #11 and #12 are the same underlying mechanism described from two
--    angles in the original spec — a scoped override resolved by
--    specificity IS a generic domain/key/scope/priority rule mapping;
--    building them as two separate subsystems would mean two resolvers
--    that have to agree on the same semantics anyway. The gap-analysis
--    doc's own prior note on `hr_reference_catalog_items` — "confirming
--    it really is the natural home for catalog family #8 too" —
--    already established HR Administration as where this project puts
--    a second generic configuration-data engine rather than forking a
--    new module; this is the third.
-- 2. Scope is deliberately bounded to the levels this codebase actually
--    has real, resolvable structure for TODAY, rather than the full
--    global/country/tenant/legal-entity/.../position/job hierarchy the
--    spec's prose lists (this platform is single-country/Pakistan-SMB
--    scoped per the project's own North Star, and "tenant" is already
--    the company_id isolation boundary every table has):
--      - `org_unit`  — walks `org_units.parent_id` (0065_organization_units.sql),
--                      whose own `unit_type` already spans
--                      department/division/business_unit/function, so
--                      ONE scope type here covers what the spec lists as
--                      several hierarchy levels (legal entity through
--                      department), resolved by nearest-ancestor-wins.
--      - `location`  — `employees.location_id` (0073_locations_and_financial_centers.sql).
--      - `employee`  — the single most specific override, one person.
--    Employee-GROUP-scoped policy assignment is deliberately NOT
--    reinvented here — `employee_group_policy_assignments`
--    (0012_employee_groups_leave_policy.sql) and
--    `EmployeeGroupsService.resolvePolicy()` already solve that for
--    attribute-condition-based groups; this engine is the complementary,
--    ORG-HIERARCHY-based half, not a second copy of the group resolver.
--    "Position"/"job"-level scoping is real, separately-scoped follow-up
--    work once a concrete policy needs it — not built speculatively.
--
-- Generic by design, like `hr_reference_catalog_items`/`hr_business_policies`:
-- `config_domain`/`config_key` are free text, registered in application
-- code per consuming domain, not a CHECK-constrained enum — so a THIRD
-- domain (beyond `hr_business_policy`, this phase's only real consumer)
-- can reuse this table with zero new migrations.
CREATE TABLE IF NOT EXISTS configuration_rule_mappings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  config_domain text NOT NULL,
  config_key    text NOT NULL,
  scope_type    text NOT NULL CHECK (scope_type IN ('org_unit', 'location', 'employee')),
  scope_value   text NOT NULL,
  rule_value    jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority      integer,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, config_domain, config_key, scope_type, scope_value)
);
CREATE INDEX IF NOT EXISTS idx_configuration_rule_mappings_lookup
  ON configuration_rule_mappings (company_id, config_domain, config_key, is_active);

GRANT SELECT, INSERT, UPDATE ON configuration_rule_mappings TO app_role;

ALTER TABLE configuration_rule_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE configuration_rule_mappings FORCE ROW LEVEL SECURITY;

CREATE POLICY configuration_rule_mappings_select ON configuration_rule_mappings FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY configuration_rule_mappings_insert ON configuration_rule_mappings FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY configuration_rule_mappings_update ON configuration_rule_mappings FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

INSERT INTO permissions (key, description) VALUES
  ('configuration_rule_mapping.manage.all', 'Create, edit, and deactivate scoped configuration overrides (org unit / location / employee) for any registered configuration domain.'),
  ('configuration_rule_mapping.view.all',   'View the company''s scoped configuration overrides')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key IN ('configuration_rule_mapping.manage.all', 'configuration_rule_mapping.view.all')
ON CONFLICT DO NOTHING;
