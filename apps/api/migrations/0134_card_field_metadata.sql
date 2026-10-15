-- Gap Register CFG-11, CFG-12 (Step 5B) + hire submission attribution. ADDITIVE.
--
--  CFG-11  core_employee_card_definitions: applicability rule, workflow mapping,
--          effective-dating flag, attachment requirement, editable-after-save,
--          completion gate, visibility rule, validation / default rule
--          references (rule_definitions.rule_key), localized display name,
--          configuration status + version. card_key stays the stable identity.
--  CFG-12  core_employee_card_field_definitions: field type, label, help text,
--          placeholder, option list or reference-catalog link, sensitivity
--          class, visibility / editability rules, data-scope rule, workflow
--          rule, audit policy, effective-dating flag, localized label / help.
--          Labels / types for the built-in fields are filled by the service from
--          card-field-catalog.ts (unambiguous only); unknown stays NULL.
--
-- The *_rule columns hold the existing inline JSON shape ({fieldKey, operator,
-- value}) or a reference object ({"ref": "<rule_key>"}) into rule_definitions
-- (CFG-14), so inline rules can migrate to references over time.
--
-- ROLLBACK: ALTER TABLE ... DROP COLUMN for every column added below;
--   ALTER TABLE hire_processes DROP COLUMN submitted_by_user_account_id.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE core_employee_card_definitions
  ADD COLUMN IF NOT EXISTS applicability_rule jsonb,
  ADD COLUMN IF NOT EXISTS workflow_template_key text,
  ADD COLUMN IF NOT EXISTS is_effective_dated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS attachment_requirement text NOT NULL DEFAULT 'none' CHECK (attachment_requirement IN ('none', 'optional', 'required')),
  ADD COLUMN IF NOT EXISTS editable_after_save boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS is_completion_gate boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS visibility_rule jsonb,
  ADD COLUMN IF NOT EXISTS validation_rule_keys text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS default_rule_keys text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS display_name_i18n jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS config_status text NOT NULL DEFAULT 'published' CHECK (config_status IN ('draft', 'validated', 'published', 'retired')),
  ADD COLUMN IF NOT EXISTS config_version integer NOT NULL DEFAULT 1 CHECK (config_version >= 1);

ALTER TABLE core_employee_card_field_definitions
  ADD COLUMN IF NOT EXISTS field_type text CHECK (field_type IN ('text', 'textarea', 'number', 'date', 'boolean', 'select', 'catalog', 'reference', 'file', 'email', 'phone')),
  ADD COLUMN IF NOT EXISTS label text,
  ADD COLUMN IF NOT EXISTS help_text text,
  ADD COLUMN IF NOT EXISTS placeholder text,
  ADD COLUMN IF NOT EXISTS option_values jsonb,
  ADD COLUMN IF NOT EXISTS reference_catalog_type text,
  ADD COLUMN IF NOT EXISTS reference_object text,
  ADD COLUMN IF NOT EXISTS sensitivity_class text CHECK (sensitivity_class IN ('normal', 'confidential', 'restricted', 'highly_restricted')),
  ADD COLUMN IF NOT EXISTS visibility_rule jsonb,
  ADD COLUMN IF NOT EXISTS editability_rule jsonb,
  ADD COLUMN IF NOT EXISTS data_scope_rule jsonb,
  ADD COLUMN IF NOT EXISTS workflow_rule jsonb,
  ADD COLUMN IF NOT EXISTS audit_policy text NOT NULL DEFAULT 'changes' CHECK (audit_policy IN ('none', 'changes', 'reads_and_changes')),
  ADD COLUMN IF NOT EXISTS is_effective_dated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS label_i18n jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS help_i18n jsonb NOT NULL DEFAULT '{}'::jsonb;

-- a select field must carry its options, a catalog field its catalog type
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'card_field_options_check') THEN
    ALTER TABLE core_employee_card_field_definitions ADD CONSTRAINT card_field_options_check CHECK (
      (field_type IS DISTINCT FROM 'select' OR option_values IS NOT NULL)
      AND (field_type IS DISTINCT FROM 'catalog' OR reference_catalog_type IS NOT NULL)
      AND (field_type IS DISTINCT FROM 'reference' OR reference_object IS NOT NULL));
  END IF;
END $$;

-- who submitted a hire for approval (maker-checker on approve)
ALTER TABLE hire_processes ADD COLUMN IF NOT EXISTS submitted_by_user_account_id uuid REFERENCES user_accounts(id);
