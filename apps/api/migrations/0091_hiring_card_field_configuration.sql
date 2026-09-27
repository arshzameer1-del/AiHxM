-- Hiring Card Field Configuration (2026-09-27) — kumail's own request,
-- looking at the Hiring Card Designer's card-level toggles: "there should
-- be configuration available for their fields under their respective tile
-- — field enable/disable, add custom field option — custom field once
-- added will be visible in respective tile." This is the field-level
-- depth the v2 gap analysis flagged as "then 2" (see
-- `core-employee-configuration-hr-admin-v2-gap-analysis-and-roadmap.md`,
-- gap #3) — kumail chose to build it for all 20 cards at once rather than
-- a pilot subset, and to have a custom field added during hiring also
-- appear on the employee's own profile afterward, not just in the wizard.
--
-- Two pieces:
--
-- 1. `core_employee_card_field_definitions` — enable/disable + required +
--    order for each card's BUILT-IN fields (the ones already hardcoded in
--    `cardForms.tsx`, e.g. Personal Identity's firstName/lastName/cnic/...).
--    Same "one generic table, lazily seeded per company from an
--    application-code catalog" shape `hr_reference_catalog_items` (0090)
--    and `core_employee_card_definitions` (0082) already use — the
--    canonical field list per card lives in `card-field-catalog.ts`, not
--    a CHECK constraint, so it can grow without another migration.
--
-- 2. "Add custom field" is NOT a second, parallel field-definition engine
--    — it reuses the existing WRICEF custom-fields tables from
--    0009_wricef_fields_notifications_forms.sql (`custom_field_definitions`/
--    `custom_field_values`), scoped under `object_key = 'hiring_card:<cardKey>'`.
--    That engine never had a delete/deactivate path (fields were assumed
--    permanent), so this migration adds `is_active` to
--    `custom_field_definitions` — existing rows default to `true`, so
--    nothing already using this table changes behavior.
--
-- Custom fields were also never actually reachable by an HR Admin: Phase
-- 6's own permission seed only granted `custom_field.manage.all` to the
-- `rbac_demo_full_access` role, never to `hr_admin` — Admin Center's own
-- "Custom Fields" tab (linked from Configuration Center's domain card,
-- `/app/admin?tab=custom-fields`) was never built either. This migration
-- grants that permission to `hr_admin` so the new "add custom field"
-- action on a hiring card actually works for the role that will use it;
-- the missing Admin Center tab is a separate, still-open gap.

CREATE TABLE IF NOT EXISTS core_employee_card_field_definitions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  card_key     text NOT NULL,
  field_key    text NOT NULL,
  is_enabled   boolean NOT NULL DEFAULT true,
  is_required  boolean NOT NULL DEFAULT false,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, card_key, field_key)
);
CREATE INDEX IF NOT EXISTS idx_core_employee_card_field_definitions_lookup
  ON core_employee_card_field_definitions (company_id, card_key);

GRANT SELECT, INSERT, UPDATE ON core_employee_card_field_definitions TO app_role;

ALTER TABLE core_employee_card_field_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE core_employee_card_field_definitions FORCE ROW LEVEL SECURITY;

CREATE POLICY core_employee_card_field_definitions_select ON core_employee_card_field_definitions FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY core_employee_card_field_definitions_insert ON core_employee_card_field_definitions FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY core_employee_card_field_definitions_update ON core_employee_card_field_definitions FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

-- ---------------------------------------------------------------------
-- custom_field_definitions.is_active — soft-deactivation, matching every
-- other reference/catalog table this project has added (never a hard
-- delete: `custom_field_values` rows already written against a field must
-- stay interpretable). Existing rows all default to true, so every custom
-- field defined before this migration keeps behaving exactly as before.
-- ---------------------------------------------------------------------
ALTER TABLE custom_field_definitions ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------
-- Grant custom_field.manage.all to hr_admin — see this migration's own
-- header comment for why this was missing entirely until now.
-- ---------------------------------------------------------------------
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key = 'custom_field.manage.all'
ON CONFLICT DO NOTHING;
