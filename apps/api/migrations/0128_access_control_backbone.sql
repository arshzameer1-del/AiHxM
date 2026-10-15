-- 0128_access_control_backbone.sql
--
-- Gap Register Step 3 (Part C) -- access control tables.
--
--  ACC-01  field_permission_rules: company_id (NULL = platform default),
--          effective_from/to, mask_rule, priority, deny_overrides,
--          sensitivity_class, and the 'masked' access value.
--  ACC-02  roles: company_id / is_system / is_active (tenant-owned roles, system
--          roles protected); permissions: object_key / action / scope derived
--          from the key (permission matrix).
--  ACC-03  user_role_assignments: effective_from/to, source, granted_by, reason.
--          Expiry is enforced by every authorization read, so a lapsed
--          grant stops working on its own.
--  ACC-04  data_scope_assignments: include_descendants, effective_from/to,
--          granted_by, role_id / object_key linkage, 'payroll_area' scope type;
--          entity existence is validated by the existing poly-ref trigger,
--          now also covering payroll areas.
--
-- Additive. Existing rows keep today's behaviour: system roles, manual
-- assignments that never expire, descendants included, global field rules.
--
-- ROLLBACK: drop triggers trg_roles_defaults, trg_roles_guard,
--   trg_permissions_derive, trg_role_assignment_company, trg_field_rule_company;
--   drop their functions; drop the added columns on field_permission_rules,
--   roles, permissions, user_role_assignments, data_scope_assignments; restore
--   field_permission_rules_access_check (view, edit, hidden) and
--   data_scope_assignments_scope_type_check (org_unit, location, cost_center);
--   restore the original roles_select / role_permissions / field_permission_rules
--   policies from 0004_rbac.sql; re-create app.poly_ref_exists from 0127 (without
--   the payroll_area line); delete permissions field_permission.manage.all and
--   role.manage.all.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);


-- ------------------------------------------------------------ ACC-02 roles
ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS is_system  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_active  boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
UPDATE roles SET is_system = true WHERE company_id IS NULL AND is_system = false;
ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_tenant_key_format;
ALTER TABLE roles ADD CONSTRAINT roles_tenant_key_format
  CHECK (company_id IS NULL OR key ~ '^[a-z][a-z0-9_]{2,63}$');
CREATE INDEX IF NOT EXISTS idx_roles_company ON roles (company_id) WHERE company_id IS NOT NULL;

-- is_system always follows ownership: platform roles are system roles, tenant roles never are.
CREATE OR REPLACE FUNCTION app.roles_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.is_system := (NEW.company_id IS NULL);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_roles_defaults ON roles;
CREATE TRIGGER trg_roles_defaults BEFORE INSERT ON roles FOR EACH ROW EXECUTE FUNCTION app.roles_defaults();

CREATE OR REPLACE FUNCTION app.roles_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system AND NOT (app.is_service() OR app.is_platform_admin()) THEN
      RAISE EXCEPTION 'system roles can only be deleted by the platform' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.is_system <> OLD.is_system OR NEW.key <> OLD.key THEN
    RAISE EXCEPTION 'a role''s key, owner and system flag are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.is_system AND NEW.is_active = false AND NOT (app.is_platform_admin() OR app.is_service()) THEN
    RAISE EXCEPTION 'a system role can only be deactivated by the platform' USING ERRCODE = 'restrict_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_roles_guard ON roles;
CREATE TRIGGER trg_roles_guard BEFORE UPDATE OR DELETE ON roles FOR EACH ROW EXECUTE FUNCTION app.roles_guard();

DROP POLICY IF EXISTS roles_select ON roles;
CREATE POLICY roles_select ON roles FOR SELECT
  USING (app.is_platform_admin() OR app.is_service()
         OR (app.jwt() ? 'sub' AND (company_id IS NULL OR company_id = app.current_company_id())));
DROP POLICY IF EXISTS roles_tenant_insert ON roles;
CREATE POLICY roles_tenant_insert ON roles FOR INSERT
  WITH CHECK (company_id IS NOT NULL AND company_id = app.current_company_id() AND NOT is_system);
DROP POLICY IF EXISTS roles_tenant_update ON roles;
CREATE POLICY roles_tenant_update ON roles FOR UPDATE
  USING (company_id IS NOT NULL AND company_id = app.current_company_id() AND NOT is_system)
  WITH CHECK (company_id IS NOT NULL AND company_id = app.current_company_id() AND NOT is_system);
DROP POLICY IF EXISTS roles_tenant_delete ON roles;
CREATE POLICY roles_tenant_delete ON roles FOR DELETE
  USING (company_id IS NOT NULL AND company_id = app.current_company_id() AND NOT is_system);
GRANT INSERT, UPDATE, DELETE ON roles TO app_role;

-- a tenant role's permission grants are visible/editable only by its own tenant
DROP POLICY IF EXISTS role_permissions_tenant_write ON role_permissions;
CREATE POLICY role_permissions_tenant_write ON role_permissions FOR ALL
  USING (EXISTS (SELECT 1 FROM roles r WHERE r.id = role_id AND r.company_id = app.current_company_id() AND NOT r.is_system))
  WITH CHECK (EXISTS (SELECT 1 FROM roles r WHERE r.id = role_id AND r.company_id = app.current_company_id() AND NOT r.is_system));
GRANT INSERT, UPDATE, DELETE ON role_permissions TO app_role;

-- permission matrix columns, derived from "<object>.<action>.<scope>" keys
ALTER TABLE permissions
  ADD COLUMN IF NOT EXISTS object_key text,
  ADD COLUMN IF NOT EXISTS action     text,
  ADD COLUMN IF NOT EXISTS scope      text;

CREATE OR REPLACE FUNCTION app.permissions_derive() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parts text[];
BEGIN
  parts := string_to_array(NEW.key, '.');
  IF array_length(parts, 1) >= 3 THEN
    IF NEW.scope      IS NULL THEN NEW.scope      := parts[array_length(parts, 1)]; END IF;
    IF NEW.action     IS NULL THEN NEW.action     := parts[array_length(parts, 1) - 1]; END IF;
    IF NEW.object_key IS NULL THEN NEW.object_key := array_to_string(parts[1:array_length(parts, 1) - 2], '.'); END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_permissions_derive ON permissions;
CREATE TRIGGER trg_permissions_derive BEFORE INSERT ON permissions FOR EACH ROW EXECUTE FUNCTION app.permissions_derive();
-- backfill existing permission rows
UPDATE permissions p SET
  scope      = (string_to_array(p.key, '.'))[array_length(string_to_array(p.key, '.'), 1)],
  action     = (string_to_array(p.key, '.'))[array_length(string_to_array(p.key, '.'), 1) - 1],
  object_key = array_to_string((string_to_array(p.key, '.'))[1:array_length(string_to_array(p.key, '.'), 1) - 2], '.')
WHERE p.object_key IS NULL AND array_length(string_to_array(p.key, '.'), 1) >= 3;
CREATE INDEX IF NOT EXISTS idx_permissions_object_action ON permissions (object_key, action);

-- ------------------------------------------------------------ ACC-03 role assignments
ALTER TABLE user_role_assignments
  ADD COLUMN IF NOT EXISTS effective_from date,
  ADD COLUMN IF NOT EXISTS effective_to   date,
  ADD COLUMN IF NOT EXISTS source         text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS granted_by     uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reason         text;
ALTER TABLE user_role_assignments DROP CONSTRAINT IF EXISTS user_role_assignments_source_check;
ALTER TABLE user_role_assignments ADD CONSTRAINT user_role_assignments_source_check
  CHECK (source IN ('manual', 'scim', 'sso', 'workflow', 'delegation', 'system'));
ALTER TABLE user_role_assignments DROP CONSTRAINT IF EXISTS user_role_assignments_window_check;
ALTER TABLE user_role_assignments ADD CONSTRAINT user_role_assignments_window_check
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from);
CREATE INDEX IF NOT EXISTS idx_user_role_assignments_active ON user_role_assignments (user_account_id, company_id, effective_to);

-- a tenant role can only be granted inside its own tenant
CREATE OR REPLACE FUNCTION app.check_role_assignment_company() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner uuid;
BEGIN
  SELECT company_id INTO owner FROM roles WHERE id = NEW.role_id;
  IF owner IS NOT NULL AND owner <> NEW.company_id THEN
    RAISE EXCEPTION 'role belongs to a different company' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_role_assignment_company ON user_role_assignments;
CREATE TRIGGER trg_role_assignment_company BEFORE INSERT OR UPDATE OF role_id, company_id ON user_role_assignments
  FOR EACH ROW EXECUTE FUNCTION app.check_role_assignment_company();

-- ------------------------------------------------------------ ACC-01 field rules
ALTER TABLE field_permission_rules
  ADD COLUMN IF NOT EXISTS company_id        uuid REFERENCES companies(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS effective_from    date,
  ADD COLUMN IF NOT EXISTS effective_to      date,
  ADD COLUMN IF NOT EXISTS mask_rule         text,
  ADD COLUMN IF NOT EXISTS priority          int NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS deny_overrides    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sensitivity_class text;
ALTER TABLE field_permission_rules DROP CONSTRAINT IF EXISTS field_permission_rules_access_check;
ALTER TABLE field_permission_rules ADD CONSTRAINT field_permission_rules_access_check
  CHECK (access IN ('view', 'edit', 'hidden', 'masked'));
ALTER TABLE field_permission_rules DROP CONSTRAINT IF EXISTS field_permission_rules_mask_rule_check;
ALTER TABLE field_permission_rules ADD CONSTRAINT field_permission_rules_mask_rule_check
  CHECK (mask_rule IS NULL OR mask_rule IN ('full', 'last4', 'first1', 'email'));
ALTER TABLE field_permission_rules DROP CONSTRAINT IF EXISTS field_permission_rules_window_check;
ALTER TABLE field_permission_rules ADD CONSTRAINT field_permission_rules_window_check
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from);
ALTER TABLE field_permission_rules DROP CONSTRAINT IF EXISTS field_permission_rules_sensitivity_check;
ALTER TABLE field_permission_rules ADD CONSTRAINT field_permission_rules_sensitivity_check
  CHECK (sensitivity_class IS NULL OR sensitivity_class IN ('public', 'internal', 'confidential', 'restricted'));
CREATE INDEX IF NOT EXISTS idx_field_permission_rules_company ON field_permission_rules (company_id) WHERE company_id IS NOT NULL;

-- a rule on a tenant role belongs to that tenant; a tenant rule never targets another tenant's role
CREATE OR REPLACE FUNCTION app.check_field_rule_company() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner uuid;
BEGIN
  SELECT company_id INTO owner FROM roles WHERE id = NEW.role_id;
  IF owner IS NOT NULL THEN
    IF NEW.company_id IS NULL THEN NEW.company_id := owner; END IF;
    IF NEW.company_id <> owner THEN
      RAISE EXCEPTION 'field rule company does not match the role''s company' USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_field_rule_company ON field_permission_rules;
CREATE TRIGGER trg_field_rule_company BEFORE INSERT OR UPDATE OF role_id, company_id ON field_permission_rules
  FOR EACH ROW EXECUTE FUNCTION app.check_field_rule_company();

DROP POLICY IF EXISTS field_permission_rules_select ON field_permission_rules;
CREATE POLICY field_permission_rules_select ON field_permission_rules FOR SELECT
  USING (app.is_platform_admin() OR app.is_service()
         OR (app.jwt() ? 'sub' AND (company_id IS NULL OR company_id = app.current_company_id())));
DROP POLICY IF EXISTS field_permission_rules_tenant_write ON field_permission_rules;
CREATE POLICY field_permission_rules_tenant_write ON field_permission_rules FOR ALL
  USING (company_id IS NOT NULL AND company_id = app.current_company_id())
  WITH CHECK (company_id IS NOT NULL AND company_id = app.current_company_id());
GRANT INSERT, UPDATE, DELETE ON field_permission_rules TO app_role;

-- ------------------------------------------------------------ ACC-04 data scope
ALTER TABLE data_scope_assignments
  ADD COLUMN IF NOT EXISTS include_descendants boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS effective_from      date,
  ADD COLUMN IF NOT EXISTS effective_to        date,
  ADD COLUMN IF NOT EXISTS granted_by          uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reason              text,
  ADD COLUMN IF NOT EXISTS role_id             uuid REFERENCES roles(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS object_key          text;
ALTER TABLE data_scope_assignments DROP CONSTRAINT IF EXISTS data_scope_assignments_scope_type_check;
ALTER TABLE data_scope_assignments ADD CONSTRAINT data_scope_assignments_scope_type_check
  CHECK (scope_type IN ('org_unit', 'location', 'cost_center', 'payroll_area'));
ALTER TABLE data_scope_assignments DROP CONSTRAINT IF EXISTS data_scope_assignments_window_check;
ALTER TABLE data_scope_assignments ADD CONSTRAINT data_scope_assignments_window_check
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from);
CREATE INDEX IF NOT EXISTS idx_data_scope_assignments_active ON data_scope_assignments (user_account_id, company_id, scope_type, effective_to);

-- the poly-ref trigger already validates org_unit/location/cost_center existence
-- (same company); teach it payroll areas too.
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
    WHEN 'payroll_area'        THEN 'payroll_areas'
    WHEN 'data_subject_request' THEN 'data_subject_requests'
    ELSE NULL
  END;
  IF tbl IS NULL THEN RETURN NULL; END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE id = $1 AND company_id = $2)', tbl) INTO found USING ref, company;
  RETURN found;
END $$;

-- ------------------------------------------------------------ ACC-05
-- Team scope (".team" permissions) resolves a record's manager through
-- employees.manager_id. org_relationships is the canonical source; every write
-- path keeps the mirror in step. This reports any employee whose mirror differs
-- from the canonical active direct relationship (never-migrated rows with no
-- direct relationship at all are not drift).
CREATE OR REPLACE FUNCTION app.manager_mirror_drift(p_company uuid)
RETURNS TABLE (employee_id uuid, mirror_manager_id uuid, canonical_manager_id uuid)
LANGUAGE sql STABLE AS $$
  SELECT e.id, e.manager_id,
         (SELECT r.manager_employee_id FROM org_relationships r
           WHERE r.employee_id = e.id AND r.relationship_type = 'direct' AND r.status = 'active' LIMIT 1)
    FROM employees e
   WHERE e.company_id = p_company
     AND e.manager_id IS DISTINCT FROM
         (SELECT r.manager_employee_id FROM org_relationships r
           WHERE r.employee_id = e.id AND r.relationship_type = 'direct' AND r.status = 'active' LIMIT 1)
     AND EXISTS (SELECT 1 FROM org_relationships r2 WHERE r2.employee_id = e.id AND r2.relationship_type = 'direct');
$$;
GRANT EXECUTE ON FUNCTION app.manager_mirror_drift(uuid) TO app_role;

-- ------------------------------------------------------------ permissions
INSERT INTO permissions (key, description) VALUES
  ('role.manage.all',             'Create and edit tenant-owned custom roles and their permission grants.'),
  ('field_permission.manage.all', 'Configure tenant field-level security rules (hide, mask, view, edit) per role.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'system_admin' AND p.key IN ('role.manage.all', 'field_permission.manage.all')
ON CONFLICT DO NOTHING;
