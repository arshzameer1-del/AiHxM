-- Gap Register CFG-02, CFG-03, CFG-04, CFG-05, CFG-06, CFG-07, CFG-14 (Step 3).
-- ADDITIVE ONLY: no existing column, value or row is changed except the
-- priority backfill noted below.
--
--  CFG-06  configuration_registry gains layer ('configuration' | 'hr_admin' |
--          'domain'), owner_module, is_versioned and show_in_center. Every
--          existing domain is classified. The three HR-Administration change
--          domains are registered (hidden from the Configuration Center page).
--  CFG-02  configuration_versions: immutable published snapshots per
--          (company, domain), version_no, status draft/validated/published/
--          retired, effective window. configuration_change_requests.
--          config_domain is no longer a 3-value CHECK: a trigger requires the
--          domain to exist in configuration_registry.
--  CFG-07  configuration_change_requests gains impact_summary, affected_counts,
--          risk_level, impact_computed_at; approval requires a computed impact.
--  CFG-04  configuration_rule_mappings gains object_type, object_id, field_key,
--          rule_type, rule_reference, effective_from/to, configuration_version,
--          status, change_reason, created_by/updated_by, typed scope_id.
--          priority becomes NOT NULL (existing NULLs -> 100). Resolution order
--          is documented in ConfigurationRuleMappingService.
--  CFG-05  scope types extended: tenant, employee_group, position, job (plus
--          the existing employee, location, org_unit). The legal-entity scope
--          stays DEFERRED (ORG-15).
--  CFG-14  rule_definitions + rule_versions: the central, versioned, effective-
--          dated rule registry (expression jsonb evaluated by RulesEngine).
--  CFG-03  tenant_configuration / tenant_configuration_versions gain
--          effective_from/to, status, change_reason, scope so a value can be
--          scheduled for a future date without touching earlier results.
--
-- ROLLBACK: drop rule_versions, rule_definitions, configuration_versions;
--   drop the added columns on the five altered tables; restore
--   configuration_change_requests_config_domain_check and the scope_type CHECK
--   (org_unit, location, employee); drop triggers trg_config_change_domain,
--   trg_rule_mapping_sync, trg_configuration_versions_guard,
--   trg_rule_versions_guard and their functions; delete the three registry rows
--   and the permission rows added below.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ------------------------------------------------------------ CFG-06
ALTER TABLE configuration_registry
  ADD COLUMN IF NOT EXISTS layer          text    NOT NULL DEFAULT 'configuration' CHECK (layer IN ('configuration', 'hr_admin', 'domain')),
  ADD COLUMN IF NOT EXISTS owner_module   text,
  ADD COLUMN IF NOT EXISTS is_versioned   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_in_center boolean NOT NULL DEFAULT true;

UPDATE configuration_registry SET layer = 'domain', owner_module = 'organization' WHERE domain_key IN ('org_unit', 'job', 'location', 'cost_center', 'profit_center');
UPDATE configuration_registry SET layer = 'domain', owner_module = 'leave'        WHERE domain_key IN ('leave_policy', 'holiday');
UPDATE configuration_registry SET layer = 'domain', owner_module = 'attendance'   WHERE domain_key = 'shift';
UPDATE configuration_registry SET layer = 'domain', owner_module = 'payroll'      WHERE domain_key = 'tax_slab';
UPDATE configuration_registry SET layer = 'hr_admin', owner_module = 'employee'   WHERE domain_key = 'employee_group';
UPDATE configuration_registry SET layer = 'configuration', owner_module = 'employee'    WHERE domain_key = 'core_employee_hiring';
UPDATE configuration_registry SET layer = 'configuration', owner_module = 'onboarding'  WHERE domain_key = 'onboarding_checklist_template';
UPDATE configuration_registry SET layer = 'configuration', owner_module = 'offboarding' WHERE domain_key = 'offboarding_checklist_template';
UPDATE configuration_registry SET layer = 'configuration', owner_module = 'workflow'    WHERE domain_key = 'workflow_template';
UPDATE configuration_registry SET layer = 'configuration', owner_module = 'platform'    WHERE domain_key = 'custom_field';
UPDATE configuration_registry SET is_versioned = supports_effective_dating;

INSERT INTO configuration_registry (domain_key, label, description, manage_permission, view_permission, admin_route, supports_effective_dating, sort_order, layer, owner_module, is_versioned, show_in_center)
VALUES
  ('hr_reference_catalog_item', 'HR reference catalog item', 'An item of an HR Administration reference catalog (employment types, reasons, ...).', 'hr_reference_catalog.manage.all', 'hr_reference_catalog.view.all', '/app/hr-administration', true, 900, 'hr_admin', 'employee', true, false),
  ('hr_business_policy', 'HR business policy', 'A named HR business policy (probation, rehire, document, ...).', 'hr_business_policy.manage.all', 'hr_business_policy.view.all', '/app/hr-administration', true, 901, 'hr_admin', 'employee', true, false),
  ('configuration_rule_mapping', 'Configuration override', 'A scoped override of a configuration value.', 'configuration_rule_mapping.manage.all', 'configuration_rule_mapping.view.all', '/app/hr-administration', true, 902, 'hr_admin', 'employee', true, false)
ON CONFLICT (domain_key) DO NOTHING;

-- ------------------------------------------------------------ CFG-02 / 07
ALTER TABLE configuration_change_requests DROP CONSTRAINT IF EXISTS configuration_change_requests_config_domain_check;

CREATE OR REPLACE FUNCTION app.check_config_change_domain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM configuration_registry WHERE domain_key = NEW.config_domain) THEN
    RAISE EXCEPTION 'Unknown configuration domain "%": register it in configuration_registry first', NEW.config_domain
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_config_change_domain ON configuration_change_requests;
CREATE TRIGGER trg_config_change_domain BEFORE INSERT ON configuration_change_requests
  FOR EACH ROW EXECUTE FUNCTION app.check_config_change_domain();

ALTER TABLE configuration_change_requests
  ADD COLUMN IF NOT EXISTS impact_summary     jsonb,
  ADD COLUMN IF NOT EXISTS affected_counts    jsonb,
  ADD COLUMN IF NOT EXISTS risk_level         text CHECK (risk_level IN ('low', 'medium', 'high')),
  ADD COLUMN IF NOT EXISTS impact_computed_at timestamptz;

CREATE TABLE IF NOT EXISTS configuration_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  domain         text NOT NULL REFERENCES configuration_registry(domain_key),
  version_no     int  NOT NULL CHECK (version_no >= 1),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'validated', 'published', 'retired')),
  snapshot       jsonb NOT NULL,
  effective_from date,
  effective_to   date,
  change_reason  text,
  change_request_id uuid REFERENCES configuration_change_requests(id),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_by   uuid,
  published_at   timestamptz,
  UNIQUE (company_id, domain, version_no),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from),
  CHECK (status NOT IN ('published', 'retired') OR effective_from IS NOT NULL),
  CONSTRAINT configuration_versions_one_published_per_window
    EXCLUDE USING gist (company_id WITH =, domain WITH =,
      daterange(effective_from, effective_to, '[]') WITH &&) WHERE (status = 'published')
);
CREATE INDEX IF NOT EXISTS idx_configuration_versions_lookup ON configuration_versions (company_id, domain, status, effective_from);

CREATE OR REPLACE FUNCTION app.guard_configuration_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- only the cascade from deleting the whole company may remove history
    IF EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id) THEN
      RAISE EXCEPTION 'configuration versions are never deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('published', 'retired') THEN
    IF NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.version_no <> OLD.version_no OR NEW.domain <> OLD.domain
       OR NEW.company_id <> OLD.company_id OR NEW.change_reason IS DISTINCT FROM OLD.change_reason
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from AND OLD.effective_from IS NOT NULL THEN
      RAISE EXCEPTION 'a published configuration version is immutable (only effective_to and retirement may change)'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
      RAISE EXCEPTION 'a retired configuration version cannot be reopened' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft'     AND NEW.status IN ('validated'))
    OR (OLD.status = 'validated' AND NEW.status IN ('draft', 'published'))
    OR (OLD.status = 'published' AND NEW.status = 'retired')
  ) THEN
    RAISE EXCEPTION 'invalid configuration version transition % -> %', OLD.status, NEW.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_configuration_versions_guard ON configuration_versions;
CREATE TRIGGER trg_configuration_versions_guard BEFORE UPDATE OR DELETE ON configuration_versions
  FOR EACH ROW EXECUTE FUNCTION app.guard_configuration_version();

-- ------------------------------------------------------------ CFG-14
CREATE TABLE IF NOT EXISTS rule_definitions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rule_key      text NOT NULL CHECK (rule_key ~ '^[a-z][a-z0-9_.-]{1,99}$'),
  rule_type     text NOT NULL CHECK (rule_type IN ('validation', 'default', 'visibility', 'editability', 'applicability', 'eligibility', 'calculation')),
  name          text NOT NULL,
  description   text,
  target_object text,
  target_field  text,
  owner_module  text,
  is_active     boolean NOT NULL DEFAULT true,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, rule_key)
);

CREATE TABLE IF NOT EXISTS rule_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rule_definition_id uuid NOT NULL REFERENCES rule_definitions(id) ON DELETE CASCADE,
  version_no         int  NOT NULL CHECK (version_no >= 1),
  expression         jsonb NOT NULL,
  message            text,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  effective_from     date,
  effective_to       date,
  change_reason      text,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  published_by       uuid,
  published_at       timestamptz,
  UNIQUE (rule_definition_id, version_no),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from),
  CHECK (status NOT IN ('published', 'retired') OR effective_from IS NOT NULL),
  CONSTRAINT rule_versions_one_published_per_window
    EXCLUDE USING gist (rule_definition_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&) WHERE (status = 'published')
);
CREATE INDEX IF NOT EXISTS idx_rule_versions_def ON rule_versions (rule_definition_id, status, effective_from);

CREATE OR REPLACE FUNCTION app.guard_rule_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' AND EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id) THEN
      RAISE EXCEPTION 'only a draft rule version can be deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('published', 'retired') THEN
    IF NEW.expression IS DISTINCT FROM OLD.expression OR NEW.version_no <> OLD.version_no
       OR NEW.rule_definition_id <> OLD.rule_definition_id OR NEW.message IS DISTINCT FROM OLD.message THEN
      RAISE EXCEPTION 'a published rule version is immutable; create a new version' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
      RAISE EXCEPTION 'a retired rule version cannot be reopened' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status = 'published') OR (OLD.status = 'published' AND NEW.status = 'retired')
  ) THEN
    RAISE EXCEPTION 'invalid rule version transition % -> %', OLD.status, NEW.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_rule_versions_guard ON rule_versions;
CREATE TRIGGER trg_rule_versions_guard BEFORE UPDATE OR DELETE ON rule_versions
  FOR EACH ROW EXECUTE FUNCTION app.guard_rule_version();

-- ------------------------------------------------------------ CFG-04 / 05
UPDATE configuration_rule_mappings SET priority = 100 WHERE priority IS NULL;
ALTER TABLE configuration_rule_mappings
  ALTER COLUMN priority SET DEFAULT 100,
  ALTER COLUMN priority SET NOT NULL,
  ADD COLUMN IF NOT EXISTS scope_id              uuid,
  ADD COLUMN IF NOT EXISTS object_type           text,
  ADD COLUMN IF NOT EXISTS object_id             uuid,
  ADD COLUMN IF NOT EXISTS field_key             text,
  ADD COLUMN IF NOT EXISTS rule_type             text,
  ADD COLUMN IF NOT EXISTS rule_reference        uuid REFERENCES rule_versions(id),
  ADD COLUMN IF NOT EXISTS effective_from        date,
  ADD COLUMN IF NOT EXISTS effective_to          date,
  ADD COLUMN IF NOT EXISTS configuration_version int,
  ADD COLUMN IF NOT EXISTS status                text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'retired')),
  ADD COLUMN IF NOT EXISTS change_reason         text,
  ADD COLUMN IF NOT EXISTS created_by            uuid,
  ADD COLUMN IF NOT EXISTS updated_by            uuid;

ALTER TABLE configuration_rule_mappings DROP CONSTRAINT IF EXISTS configuration_rule_mappings_scope_type_check;
ALTER TABLE configuration_rule_mappings ADD CONSTRAINT configuration_rule_mappings_scope_type_check
  CHECK (scope_type = ANY (ARRAY['org_unit', 'location', 'employee', 'tenant', 'employee_group', 'position', 'job']));
ALTER TABLE configuration_rule_mappings ADD CONSTRAINT configuration_rule_mappings_window_chk
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from);

UPDATE configuration_rule_mappings SET status = CASE WHEN is_active THEN 'active' ELSE 'retired' END;
UPDATE configuration_rule_mappings SET scope_id = scope_value::uuid
 WHERE scope_id IS NULL AND scope_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
CREATE INDEX IF NOT EXISTS idx_configuration_rule_mappings_scope ON configuration_rule_mappings (company_id, scope_type, scope_id);

-- keep scope_id (typed) and status in step with the legacy scope_value / is_active
CREATE OR REPLACE FUNCTION app.sync_rule_mapping() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scope_id IS NULL AND NEW.scope_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    NEW.scope_id := NEW.scope_value::uuid;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.is_active IS DISTINCT FROM OLD.is_active AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
      NEW.status := CASE WHEN NEW.is_active THEN 'active' ELSE 'retired' END;
    ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.is_active IS NOT DISTINCT FROM OLD.is_active THEN
      NEW.is_active := (NEW.status = 'active');
    END IF;
  ELSE
    NEW.is_active := (NEW.status = 'active') AND NEW.is_active;
    IF NOT NEW.is_active AND NEW.status = 'active' THEN NEW.status := 'retired'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_rule_mapping_sync ON configuration_rule_mappings;
CREATE TRIGGER trg_rule_mapping_sync BEFORE INSERT OR UPDATE ON configuration_rule_mappings
  FOR EACH ROW EXECUTE FUNCTION app.sync_rule_mapping();

-- poly-ref: the new scope kinds are verifiable (same company)
CREATE OR REPLACE FUNCTION app.poly_ref_exists(kind text, ref uuid, company uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  tbl text;
  found boolean;
BEGIN
  IF kind IN ('probation','confirmation','document','correction','transfer','rehire','termination_exit','retention','required_info') THEN
    IF ref IS NULL THEN RETURN TRUE; END IF;
    RETURN EXISTS (SELECT 1 FROM hr_business_policies WHERE id = ref AND company_id = company AND policy_type = kind);
  END IF;
  IF kind = 'tenant' THEN
    IF ref IS NULL THEN RETURN TRUE; END IF;
    RETURN ref = company;
  END IF;
  tbl := CASE kind
    WHEN 'org_unit'            THEN 'org_units'
    WHEN 'location'            THEN 'locations'
    WHEN 'cost_center'         THEN 'cost_centers'
    WHEN 'employee'            THEN 'employees'
    WHEN 'position'            THEN 'positions'
    WHEN 'job'                 THEN 'jobs'
    WHEN 'employee_group'      THEN 'employee_groups'
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

-- ------------------------------------------------------------ CFG-03
ALTER TABLE tenant_configuration
  ADD COLUMN IF NOT EXISTS effective_from date,
  ADD COLUMN IF NOT EXISTS effective_to   date,
  ADD COLUMN IF NOT EXISTS status         text NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published')),
  ADD COLUMN IF NOT EXISTS change_reason  text,
  ADD COLUMN IF NOT EXISTS scope_type     text NOT NULL DEFAULT 'tenant',
  ADD COLUMN IF NOT EXISTS scope_id       uuid;
ALTER TABLE tenant_configuration_versions
  ADD COLUMN IF NOT EXISTS effective_from date,
  ADD COLUMN IF NOT EXISTS status         text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'scheduled', 'cancelled')),
  ADD COLUMN IF NOT EXISTS change_reason  text;

-- ------------------------------------------------------------ RLS + grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['configuration_versions', 'rule_definitions', 'rule_versions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_update', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())', t || '_update', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO app_role', t);
  END LOOP;
  -- only an unpublished draft rule version may be deleted
  EXECUTE 'GRANT DELETE ON rule_versions TO app_role';
  EXECUTE 'DROP POLICY IF EXISTS rule_versions_delete ON rule_versions';
  EXECUTE 'CREATE POLICY rule_versions_delete ON rule_versions FOR DELETE USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())';
END $$;

INSERT INTO permissions (key, description) VALUES
  ('configuration_version.manage.all', 'Create, validate and publish immutable configuration versions (snapshots) for a configuration domain.'),
  ('configuration_version.view.all',   'View configuration versions and what was in force on a given date.'),
  ('rule_definition.manage.all',       'Create rule definitions and draft, publish and retire their versions in the central rule registry.'),
  ('rule_definition.view.all',         'View rule definitions and their versions.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key IN ('configuration_version.manage.all', 'configuration_version.view.all', 'rule_definition.manage.all', 'rule_definition.view.all')
ON CONFLICT DO NOTHING;
