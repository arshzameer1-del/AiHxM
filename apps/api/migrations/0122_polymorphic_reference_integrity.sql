-- Gap Register INT-02 (Step 1): integrity checks for polymorphic references.
--
-- These columns point at "some table, chosen by a sibling discriminator", so
-- a real FOREIGN KEY is impossible. Until now NOTHING stopped a typo'd or
-- cross-tenant id being stored. Each is now checked by a BEFORE INSERT/UPDATE
-- trigger (only when the reference columns actually change, so existing rows
-- are never re-validated and the migration cannot fail on legacy data):
--
--   employee_group_policy_assignments.policy_id   policy_type 'leave' -> leave_policies
--   data_scope_assignments.scope_entity_id        scope_type -> org_units / locations / cost_centers
--   payroll_area_scope_links.scope_entity_id      scope_type -> org_units / locations / cost_centers
--   configuration_rule_mappings.scope_value       scope_type -> org_units / locations / employees (uuid text)
--   custom_field_values.record_id                 object_key -> the record's table (known keys only)
--   workflow_instances.record_id                  object_key -> the record's table (known keys only)
--
-- The target must exist AND belong to the same company. The two
-- object_key-driven columns are INTENTIONALLY open-ended (new modules add new
-- object keys without a migration): keys listed below are verified, any other
-- key is accepted unchecked and documented as intentionally polymorphic.
-- Known gap that remains by design: these triggers validate at write time; a
-- later hard-delete of the target is prevented by the targets being archived
-- (not deleted) in the application — see INT-06.
--
-- ROLLBACK: DROP TRIGGER trg_poly_ref_* on each table; DROP FUNCTION
-- app.poly_ref_exists(text, uuid, uuid), app.check_poly_ref();

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- Returns true when `kind` names a verifiable target and the row exists in
-- `company`. Unknown kinds return NULL (= "not verifiable, allow").
CREATE OR REPLACE FUNCTION app.poly_ref_exists(kind text, ref uuid, company uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  tbl text;
  found boolean;
BEGIN
  tbl := CASE kind
    WHEN 'org_unit'            THEN 'org_units'
    WHEN 'location'            THEN 'locations'
    WHEN 'cost_center'         THEN 'cost_centers'
    WHEN 'employee'            THEN 'employees'
    WHEN 'leave'               THEN 'leave_policies'
    WHEN 'leave_request'       THEN 'leave_requests'
    WHEN 'payroll_run'         THEN 'payroll_runs'
    WHEN 'data_subject_request' THEN 'data_subject_requests'
    ELSE NULL
  END;
  IF tbl IS NULL THEN RETURN NULL; END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE id = $1 AND company_id = $2)', tbl) INTO found USING ref, company;
  RETURN found;
END $$;

-- TG_ARGV: [0] discriminator column, [1] reference column, [2] 'uuid' | 'text'
-- (text = reference stored as text; must be uuid-shaped for verifiable kinds)
CREATE OR REPLACE FUNCTION app.check_poly_ref() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  j jsonb := to_jsonb(NEW);
  kind text := j ->> TG_ARGV[0];
  refText text := j ->> TG_ARGV[1];
  ref uuid;
  ok boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(OLD) ->> TG_ARGV[0]) IS NOT DISTINCT FROM kind
       AND (to_jsonb(OLD) ->> TG_ARGV[1]) IS NOT DISTINCT FROM refText THEN
      RETURN NEW; -- reference unchanged: never re-validate legacy rows
    END IF;
  END IF;
  IF refText IS NULL THEN RETURN NEW; END IF;

  IF app.poly_ref_exists(kind, NULL, NULL) IS NULL AND kind NOT IN
     ('org_unit','location','cost_center','employee','leave','leave_request','payroll_run','data_subject_request') THEN
    RETURN NEW; -- intentionally polymorphic key: not verifiable
  END IF;

  IF refText !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Invalid % reference "%": expected an id of a % (table %)', TG_ARGV[1], refText, kind, TG_TABLE_NAME
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  ref := refText::uuid;
  ok := app.poly_ref_exists(kind, ref, NEW.company_id);
  IF ok IS NOT TRUE THEN
    RAISE EXCEPTION '% % does not exist in this company (referenced from %.%)', kind, ref, TG_TABLE_NAME, TG_ARGV[1]
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_poly_ref_group_policy ON employee_group_policy_assignments;
CREATE TRIGGER trg_poly_ref_group_policy BEFORE INSERT OR UPDATE ON employee_group_policy_assignments
  FOR EACH ROW EXECUTE FUNCTION app.check_poly_ref('policy_type', 'policy_id');

DROP TRIGGER IF EXISTS trg_poly_ref_data_scope ON data_scope_assignments;
CREATE TRIGGER trg_poly_ref_data_scope BEFORE INSERT OR UPDATE ON data_scope_assignments
  FOR EACH ROW EXECUTE FUNCTION app.check_poly_ref('scope_type', 'scope_entity_id');

DROP TRIGGER IF EXISTS trg_poly_ref_payroll_area_scope ON payroll_area_scope_links;
CREATE TRIGGER trg_poly_ref_payroll_area_scope BEFORE INSERT OR UPDATE ON payroll_area_scope_links
  FOR EACH ROW EXECUTE FUNCTION app.check_poly_ref('scope_type', 'scope_entity_id');

DROP TRIGGER IF EXISTS trg_poly_ref_rule_mapping ON configuration_rule_mappings;
CREATE TRIGGER trg_poly_ref_rule_mapping BEFORE INSERT OR UPDATE ON configuration_rule_mappings
  FOR EACH ROW EXECUTE FUNCTION app.check_poly_ref('scope_type', 'scope_value');

DROP TRIGGER IF EXISTS trg_poly_ref_custom_field_value ON custom_field_values;
CREATE TRIGGER trg_poly_ref_custom_field_value BEFORE INSERT OR UPDATE ON custom_field_values
  FOR EACH ROW EXECUTE FUNCTION app.check_poly_ref('object_key', 'record_id');

DROP TRIGGER IF EXISTS trg_poly_ref_workflow_instance ON workflow_instances;
CREATE TRIGGER trg_poly_ref_workflow_instance BEFORE INSERT OR UPDATE ON workflow_instances
  FOR EACH ROW EXECUTE FUNCTION app.check_poly_ref('object_key', 'record_id');
