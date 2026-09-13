-- Phase 6 — WRICEF Framework Skeleton: Enhancements (custom fields),
-- Interfaces (notification dispatch), and Forms (document templates).
--
-- Deliberately grouped in one migration — these three WRICEF pillars are
-- each small and share no relationships with each other, unlike the
-- Workflow engine (0007/0008), which earned its own file for its real
-- internal complexity. Import/export (the fourth remaining pillar,
-- "Conversions") needs no new tables at all — see
-- apps/api/src/import-export/import-export.service.ts, which works
-- directly against whatever table a caller hands it.

-- ---------------------------------------------------------------------
-- Enhancements: tenant-defined custom fields on core objects
-- ---------------------------------------------------------------------
-- JSONB values rather than a wide EAV table with typed columns per type
-- (plan doc Section 6's own wording: "all data-driven rather than
-- requiring a code deploy per client") — deliberately the same call this
-- plan already made for company_config's settings blob (Decision area:
-- see development-plan.md Section 11's BPD-gap comparison, which
-- confirms JSONB-over-EAV as the intended design here, not a shortcut).

CREATE TABLE IF NOT EXISTS custom_field_definitions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  object_key   text NOT NULL,
  field_key    text NOT NULL,
  label        text NOT NULL,
  field_type   text NOT NULL CHECK (field_type IN ('text', 'number', 'boolean', 'date', 'select')),
  -- Only meaningful (and required) when field_type = 'select': a JSON
  -- array of allowed option strings.
  options      jsonb,
  is_required  boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, object_key, field_key)
);

CREATE TABLE IF NOT EXISTS custom_field_values (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  object_key   text NOT NULL,
  record_id    uuid NOT NULL,
  field_key    text NOT NULL,
  value        jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, object_key, record_id, field_key)
);
CREATE INDEX IF NOT EXISTS idx_custom_field_values_record
  ON custom_field_values (company_id, object_key, record_id);

-- ---------------------------------------------------------------------
-- Interfaces: notification dispatch
-- ---------------------------------------------------------------------
-- Phase 6's own plan-doc wording is explicit: "even if only
-- logged/stubbed against a real provider for now." This table IS the
-- entire implementation — NotificationsService.dispatch writes a row
-- here and returns it; nothing calls out to a real email/WhatsApp/push
-- provider yet. Swapping in a real provider later means changing what
-- happens after the INSERT, not this schema. See KNOWN_ISSUES.md.

CREATE TABLE IF NOT EXISTS notification_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  channel       text NOT NULL CHECK (channel IN ('email', 'whatsapp', 'push', 'in_app')),
  recipient     text NOT NULL,
  template_key  text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'logged' CHECK (status IN ('logged', 'sent', 'failed')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notification_log_company
  ON notification_log (company_id, created_at DESC);

-- ---------------------------------------------------------------------
-- Forms: template-based document generation
-- ---------------------------------------------------------------------
-- `template_body` uses `{{fieldKey}}` placeholders, substituted against
-- whatever record dict the caller provides — same "engine never queries
-- an arbitrary object's own table" decoupling the Workflow engine uses
-- (0007's header comment), for the same reason: Forms shouldn't need to
-- know Employee Core's schema any more than Workflows do.

CREATE TABLE IF NOT EXISTS document_templates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key            text NOT NULL,
  name           text NOT NULL,
  object_key     text NOT NULL,
  template_body  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, key)
);

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON custom_field_definitions TO app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON custom_field_values TO app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_log TO app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON document_templates TO app_role;

-- ---------------------------------------------------------------------
-- Row Level Security — all four are tenant data, same posture as
-- workflow_templates/workflow_instances (0007).
-- ---------------------------------------------------------------------

ALTER TABLE custom_field_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE custom_field_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field_values FORCE ROW LEVEL SECURITY;
ALTER TABLE custom_field_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_log FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE document_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY custom_field_definitions_rw ON custom_field_definitions FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY custom_field_values_rw ON custom_field_values FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY notification_log_rw ON notification_log FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY document_templates_rw ON document_templates FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

-- ---------------------------------------------------------------------
-- Seed: one new permission per manageable pillar, granted to the same
-- rbac_demo_full_access demo role 0008 already extended — same
-- scaffolding-not-a-product-catalog posture.
-- ---------------------------------------------------------------------

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('custom_field.manage.all', 'Define and view custom fields for the tenant'),
  ('document_template.manage.all', 'Define and view document templates for the tenant');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'rbac_demo_full_access' AND p.key IN ('custom_field.manage.all', 'document_template.manage.all');
