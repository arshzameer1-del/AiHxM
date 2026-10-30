-- FORMCFG1: one reusable place where a company changes how a form field looks and behaves
-- (label, help text, placeholder, required, hidden, maximum length), instead of a separate hardcoded
-- setting per screen. Every change is kept in a history table so it can be restored.
-- Which forms and fields can be changed is decided in code (form-catalog.ts): a field the business
-- always needs (an employee, a date range) can be relabelled but never hidden or made optional.
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

CREATE TABLE IF NOT EXISTS form_field_settings (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  form_key text NOT NULL CHECK (form_key ~ '^[a-z][a-z0-9_]{1,59}$'),
  field_key text NOT NULL CHECK (field_key ~ '^[a-zA-Z][a-zA-Z0-9_]{0,59}$'),
  label text CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 80),
  help_text text CHECK (help_text IS NULL OR char_length(help_text) <= 300),
  placeholder text CHECK (placeholder IS NULL OR char_length(placeholder) <= 120),
  is_hidden boolean NOT NULL DEFAULT false,
  -- NULL means "keep the form's own default"; true / false overrides it
  is_required boolean,
  max_length integer CHECK (max_length IS NULL OR max_length BETWEEN 1 AND 20000),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, form_key, field_key)
);

CREATE TABLE IF NOT EXISTS form_field_setting_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  form_key text NOT NULL,
  field_key text NOT NULL,
  action text NOT NULL CHECK (action IN ('change', 'reset', 'restore')),
  before jsonb,
  after jsonb,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS form_field_setting_history_lookup ON form_field_setting_history (company_id, form_key, field_key, changed_at DESC);

ALTER TABLE form_field_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_field_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS form_field_settings_all ON form_field_settings;
CREATE POLICY form_field_settings_all ON form_field_settings
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

ALTER TABLE form_field_setting_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_field_setting_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS form_field_setting_history_all ON form_field_setting_history;
CREATE POLICY form_field_setting_history_all ON form_field_setting_history
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON form_field_settings TO app_role;
GRANT SELECT, INSERT ON form_field_setting_history TO app_role;

INSERT INTO configuration_registry (domain_key, label, description, manage_permission, view_permission, admin_route, supports_effective_dating, sort_order, layer, owner_module, is_versioned, show_in_center)
VALUES ('form_field_settings', 'Form settings', 'Rename a field, add help text, make it required or hide it, and set a length limit on leave, expense and help desk forms. Every change is kept and can be restored.',
        'employee.manage.all', 'employee.manage.all', '/app/configuration-center/form-settings', false, 16, 'configuration', 'employee', true, true)
ON CONFLICT (domain_key) DO NOTHING;
