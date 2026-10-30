-- FORMDESIGN1: a company designs how a form is laid out: sections, which fields sit where and in what order, extra fields
-- (the company's own custom fields), when a field shows or becomes required, and read-only fields.
-- The built-in fields and their rules still come from code (form-catalog.ts); this stores only the company's arrangement.
-- A layout is edited as a draft and goes live only when someone publishes it; every publish is kept in history.
-- Nothing is configured by default: a form with no published layout looks and behaves exactly as before.
-- ROLLBACK: DROP TABLE form_layout_history, form_layouts; DELETE FROM configuration_registry WHERE domain_key = 'form_designer';
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

CREATE TABLE IF NOT EXISTS form_layouts (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  form_key text NOT NULL CHECK (form_key ~ '^[a-z][a-z0-9_]{1,59}$'),
  published jsonb CHECK (published IS NULL OR jsonb_typeof(published) = 'object'),
  draft jsonb CHECK (draft IS NULL OR jsonb_typeof(draft) = 'object'),
  version integer NOT NULL DEFAULT 0,
  published_at timestamptz,
  published_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  PRIMARY KEY (company_id, form_key)
);

CREATE TABLE IF NOT EXISTS form_layout_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  form_key text NOT NULL,
  action text NOT NULL CHECK (action IN ('publish', 'reset', 'restore')),
  version integer NOT NULL,
  layout jsonb,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS form_layout_history_lookup ON form_layout_history (company_id, form_key, changed_at DESC);

ALTER TABLE form_layouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_layouts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS form_layouts_all ON form_layouts;
CREATE POLICY form_layouts_all ON form_layouts
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

ALTER TABLE form_layout_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_layout_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS form_layout_history_all ON form_layout_history;
CREATE POLICY form_layout_history_all ON form_layout_history
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON form_layouts TO app_role;
GRANT SELECT, INSERT ON form_layout_history TO app_role;

-- One Configuration Center card for the whole thing: the designer includes the per-field settings (label, help text, required, hide, length).
-- The card is the 'form_settings' row added by 0202 (FORMCFG3); it becomes the Form designer. The older 'form_field_settings' row from 0200 is hidden so there is one card, not two.
-- ROLLBACK: UPDATE configuration_registry SET label='Form settings', admin_route='/app/configuration-center/form-settings' WHERE domain_key='form_settings'; UPDATE configuration_registry SET show_in_center=true WHERE domain_key='form_field_settings';
UPDATE configuration_registry
   SET label = 'Form designer',
       description = 'Design a form: sections, field order, extra fields of your own, when a field shows or is required, and each field''s wording, help text and limits.',
       admin_route = '/app/configuration-center/form-designer'
 WHERE domain_key = 'form_settings';
UPDATE configuration_registry SET show_in_center = false WHERE domain_key = 'form_field_settings';
