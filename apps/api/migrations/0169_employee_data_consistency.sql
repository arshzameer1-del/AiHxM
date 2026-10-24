-- 0169_employee_data_consistency.sql
-- BACKLOG46: one value, one place. The employee record carries copies of values that are
-- really owned elsewhere (department <- org unit, designation <- position, location <- location
-- master, email/phone <- contact records). The copies drifted. This migration keeps them equal
-- inside the same transaction and repairs the rows that already drifted.
--
--   * employees.department/designation/location always follow org_unit_id / position_id / location_id
--   * renaming an org unit, location or position updates every employee that points to it
--   * employees.email/phone and the primary employee_contacts rows follow each other
--   * app.repair_employee_consistency() fixes drift for one company (or all) and returns counts
--
-- Idempotent: safe to run twice.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- ---------------------------------------------------------------- canonical text on employees

CREATE OR REPLACE FUNCTION app.trg_employee_canonical_text() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v text;
BEGIN
  -- department follows the org unit
  IF NEW.org_unit_id IS NOT NULL THEN
    SELECT name INTO v FROM org_units WHERE id = NEW.org_unit_id;
    IF v IS NOT NULL THEN NEW.department := v; END IF;
  ELSIF TG_OP = 'UPDATE' AND OLD.org_unit_id IS NOT NULL AND NEW.department IS NOT DISTINCT FROM OLD.department THEN
    NEW.department := NULL;
  END IF;

  -- designation follows the position title
  IF NEW.position_id IS NOT NULL THEN
    SELECT position_title INTO v FROM positions WHERE id = NEW.position_id;
    IF v IS NOT NULL THEN NEW.designation := v; END IF;
  ELSIF TG_OP = 'UPDATE' AND OLD.position_id IS NOT NULL AND NEW.designation IS NOT DISTINCT FROM OLD.designation THEN
    NEW.designation := NULL;
  END IF;

  -- location follows the location master
  IF NEW.location_id IS NOT NULL THEN
    SELECT name INTO v FROM locations WHERE id = NEW.location_id;
    IF v IS NOT NULL THEN NEW.location := v; END IF;
  ELSIF TG_OP = 'UPDATE' AND OLD.location_id IS NOT NULL AND NEW.location IS NOT DISTINCT FROM OLD.location THEN
    NEW.location := NULL;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_employee_05_canonical_text ON employees;
CREATE TRIGGER trg_employee_05_canonical_text
  BEFORE INSERT OR UPDATE OF org_unit_id, position_id, location_id, department, designation, location ON employees
  FOR EACH ROW EXECUTE FUNCTION app.trg_employee_canonical_text();

-- ---------------------------------------------------------------- renames push to employees

CREATE OR REPLACE FUNCTION app.trg_org_unit_name_propagate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE employees SET department = NEW.name, updated_at = now()
     WHERE org_unit_id = NEW.id AND department IS DISTINCT FROM NEW.name;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_org_unit_name_propagate ON org_units;
CREATE TRIGGER trg_org_unit_name_propagate
  AFTER UPDATE OF name ON org_units FOR EACH ROW EXECUTE FUNCTION app.trg_org_unit_name_propagate();

CREATE OR REPLACE FUNCTION app.trg_location_name_propagate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE employees SET location = NEW.name, updated_at = now()
     WHERE location_id = NEW.id AND location IS DISTINCT FROM NEW.name;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_location_name_propagate ON locations;
CREATE TRIGGER trg_location_name_propagate
  AFTER UPDATE OF name ON locations FOR EACH ROW EXECUTE FUNCTION app.trg_location_name_propagate();

CREATE OR REPLACE FUNCTION app.trg_position_title_propagate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.position_title IS DISTINCT FROM OLD.position_title THEN
    UPDATE employees SET designation = NEW.position_title, updated_at = now()
     WHERE position_id = NEW.id AND designation IS DISTINCT FROM NEW.position_title;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_position_title_propagate ON positions;
CREATE TRIGGER trg_position_title_propagate
  AFTER UPDATE OF position_title ON positions FOR EACH ROW EXECUTE FUNCTION app.trg_position_title_propagate();

-- ---------------------------------------------------------------- contacts <-> employees.email/phone
-- employees.email  mirrors the primary active business_email contact.
-- employees.phone  mirrors the primary active business_phone contact, else the primary personal_phone.
-- A guard setting (app.contact_sync) stops the two directions from calling each other.

CREATE OR REPLACE FUNCTION app.employee_contact_value(p_employee uuid, VARIADIC p_types text[]) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT c.value FROM employee_contacts c
   WHERE c.employee_id = p_employee AND c.is_primary AND c.status = 'active' AND c.contact_type = ANY (p_types)
   ORDER BY array_position(p_types, c.contact_type) LIMIT 1
$$;

CREATE OR REPLACE FUNCTION app.trg_contact_to_employee() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  emp uuid := COALESCE(NEW.employee_id, OLD.employee_id);
  em text;
  ph text;
BEGIN
  IF current_setting('app.contact_sync', true) = 'on' THEN RETURN NULL; END IF;
  em := app.employee_contact_value(emp, 'business_email');
  ph := app.employee_contact_value(emp, 'business_phone', 'personal_phone');
  PERFORM set_config('app.contact_sync', 'on', true);
  UPDATE employees SET
      email = COALESCE(em, email),
      phone = COALESCE(ph, phone),
      updated_at = now()
    WHERE id = emp
      AND (email IS DISTINCT FROM COALESCE(em, email) OR phone IS DISTINCT FROM COALESCE(ph, phone));
  PERFORM set_config('app.contact_sync', 'off', true);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.contact_sync', 'off', true);
  RAISE;
END $$;
DROP TRIGGER IF EXISTS trg_contact_to_employee ON employee_contacts;
CREATE TRIGGER trg_contact_to_employee
  AFTER INSERT OR UPDATE OF value, is_primary, status, contact_type ON employee_contacts
  FOR EACH ROW EXECUTE FUNCTION app.trg_contact_to_employee();

-- Put `p_value` as the primary active contact of `p_type` (reusing a matching one, demoting the old primary).
CREATE OR REPLACE FUNCTION app.set_primary_contact(p_company uuid, p_employee uuid, p_type text, p_value text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  existing uuid;
BEGIN
  IF p_value IS NULL OR btrim(p_value) = '' THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM employee_contacts WHERE employee_id = p_employee AND contact_type = p_type
               AND is_primary AND status = 'active' AND lower(btrim(value)) = lower(btrim(p_value))) THEN
    RETURN;
  END IF;
  UPDATE employee_contacts SET is_primary = false, updated_at = now()
   WHERE employee_id = p_employee AND contact_type = p_type AND status = 'active' AND is_primary;
  SELECT id INTO existing FROM employee_contacts
   WHERE employee_id = p_employee AND contact_type = p_type AND status = 'active'
     AND lower(btrim(value)) = lower(btrim(p_value)) LIMIT 1;
  IF existing IS NOT NULL THEN
    UPDATE employee_contacts SET is_primary = true, updated_at = now() WHERE id = existing;
  ELSE
    INSERT INTO employee_contacts (company_id, employee_id, contact_type, value, is_primary)
    VALUES (p_company, p_employee, p_type, btrim(p_value), true);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.trg_employee_to_contact() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ph_type text;
BEGIN
  IF current_setting('app.contact_sync', true) = 'on' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW.email IS NOT DISTINCT FROM OLD.email AND NEW.phone IS NOT DISTINCT FROM OLD.phone THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('app.contact_sync', 'on', true);
  IF NEW.email IS NOT NULL AND btrim(NEW.email) <> '' AND (TG_OP = 'INSERT' OR NEW.email IS DISTINCT FROM OLD.email) THEN
    PERFORM app.set_primary_contact(NEW.company_id, NEW.id, 'business_email', NEW.email);
  END IF;
  IF NEW.phone IS NOT NULL AND btrim(NEW.phone) <> '' AND (TG_OP = 'INSERT' OR NEW.phone IS DISTINCT FROM OLD.phone) THEN
    SELECT c.contact_type INTO ph_type FROM employee_contacts c
     WHERE c.employee_id = NEW.id AND c.is_primary AND c.status = 'active' AND c.contact_type IN ('business_phone', 'personal_phone')
     ORDER BY CASE c.contact_type WHEN 'business_phone' THEN 0 ELSE 1 END LIMIT 1;
    PERFORM app.set_primary_contact(NEW.company_id, NEW.id, COALESCE(ph_type, 'personal_phone'), NEW.phone);
  END IF;
  PERFORM set_config('app.contact_sync', 'off', true);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.contact_sync', 'off', true);
  RAISE;
END $$;
DROP TRIGGER IF EXISTS trg_employee_60_to_contact ON employees;
CREATE TRIGGER trg_employee_60_to_contact
  AFTER INSERT OR UPDATE OF email, phone ON employees
  FOR EACH ROW EXECUTE FUNCTION app.trg_employee_to_contact();

-- ---------------------------------------------------------------- repair

-- Fixes drift for one company (or every company when p_company is NULL) and returns what it changed.
CREATE OR REPLACE FUNCTION app.repair_employee_consistency(p_company uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  n_dept int := 0; n_desig int := 0; n_loc int := 0; n_email int := 0; n_phone int := 0;
  n_contact int := 0; n_mgr int := 0; n_rel int := 0; r record;
BEGIN
  UPDATE employees e SET department = o.name, updated_at = now()
    FROM org_units o WHERE o.id = e.org_unit_id AND e.department IS DISTINCT FROM o.name
     AND (p_company IS NULL OR e.company_id = p_company);
  GET DIAGNOSTICS n_dept = ROW_COUNT;

  UPDATE employees e SET designation = p.position_title, updated_at = now()
    FROM positions p WHERE p.id = e.position_id AND p.position_title IS NOT NULL AND e.designation IS DISTINCT FROM p.position_title
     AND (p_company IS NULL OR e.company_id = p_company);
  GET DIAGNOSTICS n_desig = ROW_COUNT;

  UPDATE employees e SET location = l.name, updated_at = now()
    FROM locations l WHERE l.id = e.location_id AND e.location IS DISTINCT FROM l.name
     AND (p_company IS NULL OR e.company_id = p_company);
  GET DIAGNOSTICS n_loc = ROW_COUNT;

  PERFORM set_config('app.contact_sync', 'on', true);
  -- contact records win when they exist
  UPDATE employees e SET email = app.employee_contact_value(e.id, 'business_email'), updated_at = now()
   WHERE (p_company IS NULL OR e.company_id = p_company)
     AND app.employee_contact_value(e.id, 'business_email') IS NOT NULL
     AND e.email IS DISTINCT FROM app.employee_contact_value(e.id, 'business_email');
  GET DIAGNOSTICS n_email = ROW_COUNT;

  UPDATE employees e SET phone = app.employee_contact_value(e.id, 'business_phone', 'personal_phone'), updated_at = now()
   WHERE (p_company IS NULL OR e.company_id = p_company)
     AND app.employee_contact_value(e.id, 'business_phone', 'personal_phone') IS NOT NULL
     AND e.phone IS DISTINCT FROM app.employee_contact_value(e.id, 'business_phone', 'personal_phone');
  GET DIAGNOSTICS n_phone = ROW_COUNT;

  -- values that exist only on the employee row become contact records
  FOR r IN SELECT e.id, e.company_id, e.email FROM employees e
            WHERE (p_company IS NULL OR e.company_id = p_company) AND e.email IS NOT NULL AND btrim(e.email) <> ''
              AND app.employee_contact_value(e.id, 'business_email') IS NULL LOOP
    PERFORM app.set_primary_contact(r.company_id, r.id, 'business_email', r.email);
    n_contact := n_contact + 1;
  END LOOP;
  FOR r IN SELECT e.id, e.company_id, e.phone FROM employees e
            WHERE (p_company IS NULL OR e.company_id = p_company) AND e.phone IS NOT NULL AND btrim(e.phone) <> ''
              AND app.employee_contact_value(e.id, 'business_phone', 'personal_phone') IS NULL LOOP
    PERFORM app.set_primary_contact(r.company_id, r.id, 'personal_phone', r.phone);
    n_contact := n_contact + 1;
  END LOOP;
  PERFORM set_config('app.contact_sync', 'off', true);

  -- reporting line: the direct relationship is the organisation's record; the flat manager follows it
  UPDATE employees e SET manager_id = rel.manager_employee_id, updated_at = now()
    FROM org_relationships rel
   WHERE rel.employee_id = e.id AND rel.relationship_type = 'direct' AND rel.status = 'active'
     AND e.manager_id IS DISTINCT FROM rel.manager_employee_id
     AND (p_company IS NULL OR e.company_id = p_company);
  GET DIAGNOSTICS n_mgr = ROW_COUNT;

  -- a flat manager with no direct relationship gets one
  INSERT INTO org_relationships (company_id, employee_id, manager_employee_id, relationship_type, status)
  SELECT e.company_id, e.id, e.manager_id, 'direct', 'active'
    FROM employees e
   WHERE e.manager_id IS NOT NULL AND e.manager_id <> e.id
     AND (p_company IS NULL OR e.company_id = p_company)
     AND NOT EXISTS (SELECT 1 FROM org_relationships rel WHERE rel.employee_id = e.id AND rel.relationship_type = 'direct' AND rel.status = 'active');
  GET DIAGNOSTICS n_rel = ROW_COUNT;

  RETURN jsonb_build_object('department', n_dept, 'designation', n_desig, 'location', n_loc,
    'email', n_email, 'phone', n_phone, 'contactsCreated', n_contact, 'managerFixed', n_mgr, 'reportingLinesCreated', n_rel);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.contact_sync', 'off', true);
  RAISE;
END $$;

-- one-time repair of existing rows
SELECT app.repair_employee_consistency(NULL);
