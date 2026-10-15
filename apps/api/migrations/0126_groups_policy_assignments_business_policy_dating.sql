-- Gap Register CAT-05, CAT-06, CAT-07 (Step 3). ADDITIVE ONLY.
--
-- CAT-05  Employee groups become a real HR grouping master:
--   * employee_subgroups (a group's finer split; code, name, dating)
--   * employees.employee_subgroup_id (nullable FK)
--   * employee_group_memberships: materialised, effective-dated membership
--     (source 'rule' = computed from conditions, 'manual'); written by
--     EmployeeGroupsService.refreshMemberships(), history is closed, not deleted
--   * employee_groups.effective_from / effective_to
--   * employee_group_conditions.field is widened to canonical-ID fields
--     (orgUnitId, locationId, positionId, jobId, subgroupId). The text
--     conditions (department, location, ...) keep working unchanged.
-- CAT-06  employee_group_policy_assignments.policy_type is no longer limited
--   to 'leave': any lowercase key is allowed, and the polymorphic-reference
--   trigger verifies the id against hr_business_policies for those types
--   (same company, same policy_type). Assignments get effective_from/to,
--   honoured by policy resolution.
-- CAT-07  hr_business_policies gets effective_from/to, applicability (jsonb),
--   version, and the one-default-per-type unique index is replaced by an
--   EXCLUDE constraint so a successor default can be scheduled with a
--   non-overlapping window. Changes still go through
--   configuration_change_requests (domain 'hr_business_policy').
--
-- ROLLBACK: drop employee_group_memberships, employees.employee_subgroup_id,
--   employee_subgroups; drop the added columns; restore the old CHECKs
--   (field_check list of five, policy_type = 'leave') and the partial unique
--   index idx_hr_business_policies_one_default_per_type; drop constraint
--   hr_business_policies_one_default_per_window.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ------------------------------------------------------------ CAT-05
ALTER TABLE employee_groups
  ADD COLUMN IF NOT EXISTS effective_from date,
  ADD COLUMN IF NOT EXISTS effective_to   date;

CREATE TABLE IF NOT EXISTS employee_subgroups (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  group_id       uuid NOT NULL REFERENCES employee_groups(id) ON DELETE CASCADE,
  code           text NOT NULL,
  name           text NOT NULL,
  description    text,
  sort_order     int  NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT true,
  effective_from date,
  effective_to   date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, code),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS idx_employee_subgroups_company ON employee_subgroups (company_id, group_id);

ALTER TABLE employees ADD COLUMN IF NOT EXISTS employee_subgroup_id uuid REFERENCES employee_subgroups(id);
CREATE INDEX IF NOT EXISTS idx_employees_subgroup ON employees (employee_subgroup_id) WHERE employee_subgroup_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS employee_group_memberships (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  group_id       uuid NOT NULL REFERENCES employee_groups(id) ON DELETE CASCADE,
  employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  source         text NOT NULL DEFAULT 'rule' CHECK (source IN ('rule', 'manual')),
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT employee_group_memberships_no_overlap
    EXCLUDE USING gist (group_id WITH =, employee_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&)
);
CREATE INDEX IF NOT EXISTS idx_egm_employee ON employee_group_memberships (employee_id);
CREATE INDEX IF NOT EXISTS idx_egm_group_open ON employee_group_memberships (group_id) WHERE effective_to IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employee_subgroups', 'employee_group_memberships'] LOOP
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
END $$;

-- A rule-based membership that opens and closes on the same day never took
-- effect for a full day, so refreshMemberships() removes it instead of
-- leaving a misleading one-day row. Only memberships are deletable.
GRANT DELETE ON employee_group_memberships TO app_role;
DROP POLICY IF EXISTS employee_group_memberships_delete ON employee_group_memberships;
CREATE POLICY employee_group_memberships_delete ON employee_group_memberships FOR DELETE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

-- a subgroup must belong to the same company as the employee that uses it
CREATE OR REPLACE FUNCTION app.check_employee_subgroup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.employee_subgroup_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.employee_subgroup_id IS DISTINCT FROM OLD.employee_subgroup_id) THEN
    IF NOT EXISTS (SELECT 1 FROM employee_subgroups WHERE id = NEW.employee_subgroup_id AND company_id = NEW.company_id) THEN
      RAISE EXCEPTION 'employee_subgroup % does not exist in this company', NEW.employee_subgroup_id USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_employee_subgroup_company ON employees;
CREATE TRIGGER trg_employee_subgroup_company BEFORE INSERT OR UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION app.check_employee_subgroup();

ALTER TABLE employee_group_conditions DROP CONSTRAINT IF EXISTS employee_group_conditions_field_check;
ALTER TABLE employee_group_conditions ADD CONSTRAINT employee_group_conditions_field_check
  CHECK (field = ANY (ARRAY['department','location','designation','employmentType','employmentStatus',
                            'orgUnitId','locationId','positionId','jobId','subgroupId']));

-- ------------------------------------------------------------ CAT-06
ALTER TABLE employee_group_policy_assignments
  ADD COLUMN IF NOT EXISTS effective_from date,
  ADD COLUMN IF NOT EXISTS effective_to   date;
ALTER TABLE employee_group_policy_assignments DROP CONSTRAINT IF EXISTS employee_group_policy_assignments_policy_type_check;
ALTER TABLE employee_group_policy_assignments ADD CONSTRAINT employee_group_policy_assignments_policy_type_check
  CHECK (policy_type ~ '^[a-z][a-z0-9_]{1,59}$');
ALTER TABLE employee_group_policy_assignments ADD CONSTRAINT employee_group_policy_assignments_window_chk
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from);

-- Known kinds for the polymorphic-reference check now include every HR
-- business policy type (the id must be an hr_business_policies row of that
-- type in the same company). Unknown kinds remain "not verifiable, allowed".
CREATE OR REPLACE FUNCTION app.poly_ref_exists(kind text, ref uuid, company uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  tbl text;
  found boolean;
BEGIN
  IF kind IN ('probation','confirmation','document','correction','transfer','rehire','termination_exit','retention','required_info') THEN
    IF ref IS NULL THEN RETURN TRUE; END IF; -- probe: this kind is verifiable
    RETURN EXISTS (SELECT 1 FROM hr_business_policies WHERE id = ref AND company_id = company AND policy_type = kind);
  END IF;
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

  -- probe with a NULL ref: NULL means "kind is not verifiable"
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

-- ------------------------------------------------------------ CAT-07
ALTER TABLE hr_business_policies
  ADD COLUMN IF NOT EXISTS effective_from date,
  ADD COLUMN IF NOT EXISTS effective_to   date,
  ADD COLUMN IF NOT EXISTS applicability jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS version        int  NOT NULL DEFAULT 1;
ALTER TABLE hr_business_policies ADD CONSTRAINT hr_business_policies_window_chk
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from);

DROP INDEX IF EXISTS idx_hr_business_policies_one_default_per_type;
ALTER TABLE hr_business_policies ADD CONSTRAINT hr_business_policies_one_default_per_window
  EXCLUDE USING gist (
    company_id WITH =, policy_type WITH =,
    daterange(COALESCE(effective_from, '-infinity'::date), COALESCE(effective_to, 'infinity'::date), '[]') WITH &&
  ) WHERE (is_default AND is_active);
