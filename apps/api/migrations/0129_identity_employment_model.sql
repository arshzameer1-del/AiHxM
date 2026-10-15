-- Gap Register EMP-01, EMP-02, EMP-03, EMP-04, EMP-05, EMP-06 (Step 4A/4B).
-- ADDITIVE: no column is dropped, no value rewritten except the explicit
-- backfills noted below. `employees` stays the current projection that every
-- existing reader keeps using.
--
--  EMP-01  `persons` becomes the canonical identity. Every employee has a
--          person_id (BEFORE INSERT trigger links by CNIC blind index/CNIC or
--          creates the person; backfill for existing rows; then NOT NULL).
--          employees' identity columns (first/last name, gender, marital
--          status, CNIC, DOB) stay as a compatibility projection kept in sync
--          BOTH ways by triggers (persons -> employees is the canonical
--          direction; employees -> persons only exists for legacy writers and
--          is loop-guarded by the app.identity_sync setting). Deprecation plan
--          is in the Step 4 report; nothing is dropped.
--  EMP-02  duplicate protection: persons already has UNIQUE (company, cnic) and
--          UNIQUE (company, cnic_bidx) - this resolves the "unique CNIC per
--          company" VERIFY item. persons.date_of_birth_bidx supports the
--          CNIC + DOB duplicate-candidate search in PersonsService.
--  EMP-03  persons gains first/middle/last/preferred name, title, place of
--          birth, second nationality, language, marital status (+date),
--          passport number/expiry, NTN, national id type. passport_number and
--          ntn are encrypted by the application (crypto registry). person_versions keeps
--          effective-dated history (app.roll_version).
--  EMP-04  employments (one row per employment period of a person; rehire =
--          next period linked by rehire_of_employment_id) and
--          employment_versions (status/type/termination state per period).
--  EMP-05  employee_versions (assignment snapshot with canonical ids per
--          period: org unit, position, job, location, manager, subgroup,
--          payroll area ...) and app.employee_as_of(date, employee) for
--          point-in-time reporting. Versions are maintained by triggers on
--          employees, written only by SECURITY DEFINER code (app_role has
--          SELECT only).
--  EMP-06  employment_status is catalog-backed: employment_status /
--          employment_status_reason catalog types, status_reason_catalog_item_id,
--          the 3-value CHECK is replaced by a format CHECK plus a trigger that
--          allows the system states (active, on_leave, terminated) always and
--          any other state only if it is an active catalog item.
--
-- LIMITS (stated honestly): history before this migration is one version per
-- employee (valid from date_of_joining; terminated employees get an
-- active -> terminated pair); employee_job_history stays text-only for old
-- rows. A retroactive change is clamped to the start of the open version
-- (never deletes history); the exact retro timeline comes from LIF-01 events.
--
-- ROLLBACK: DROP FUNCTION app.employee_as_of, app.identity_drift, app.roll_version,
--   app.effective_date and the trigger functions app.trg_*; DROP TRIGGER
--   trg_employee_* ON employees, trg_person_* ON persons; ALTER TABLE employees
--   DROP COLUMN employment_id, employment_status_catalog_item_id,
--   employment_status_reason, status_reason_catalog_item_id, ALTER person_id DROP
--   NOT NULL, restore employees_employment_status_check (active|on_leave|
--   terminated); DROP TABLE employee_versions, employment_versions, employments,
--   person_versions; ALTER TABLE persons DROP the added columns; delete the
--   employment_status / employment_status_reason catalog rows.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ------------------------------------------------------------- EMP-03 columns
ALTER TABLE persons
  ADD COLUMN IF NOT EXISTS first_name        text,
  ADD COLUMN IF NOT EXISTS middle_name       text,
  ADD COLUMN IF NOT EXISTS last_name         text,
  ADD COLUMN IF NOT EXISTS preferred_name    text,
  ADD COLUMN IF NOT EXISTS title             text,
  ADD COLUMN IF NOT EXISTS place_of_birth    text,
  ADD COLUMN IF NOT EXISTS second_nationality text,
  ADD COLUMN IF NOT EXISTS second_nationality_catalog_item_id uuid REFERENCES hr_reference_catalog_items(id),
  ADD COLUMN IF NOT EXISTS language          text,
  ADD COLUMN IF NOT EXISTS marital_status    text,
  ADD COLUMN IF NOT EXISTS marital_status_catalog_item_id uuid REFERENCES hr_reference_catalog_items(id),
  ADD COLUMN IF NOT EXISTS marital_status_date date,
  ADD COLUMN IF NOT EXISTS passport_number   text,
  ADD COLUMN IF NOT EXISTS passport_expiry   date,
  ADD COLUMN IF NOT EXISTS ntn               text,
  ADD COLUMN IF NOT EXISTS national_id_type  text NOT NULL DEFAULT 'cnic',
  ADD COLUMN IF NOT EXISTS date_of_birth_bidx text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'persons_national_id_type_check') THEN
    ALTER TABLE persons ADD CONSTRAINT persons_national_id_type_check
      CHECK (national_id_type IN ('cnic', 'nicop', 'passport', 'b_form', 'other'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_persons_company_dob_bidx ON persons (company_id, date_of_birth_bidx) WHERE date_of_birth_bidx IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_persons_marital_status_catalog_item_id ON persons (marital_status_catalog_item_id) WHERE marital_status_catalog_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_persons_second_nationality_catalog_item_id ON persons (second_nationality_catalog_item_id) WHERE second_nationality_catalog_item_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_catalog_marital_status_catalog_item_id ON persons;
CREATE TRIGGER trg_catalog_marital_status_catalog_item_id BEFORE INSERT OR UPDATE ON persons
  FOR EACH ROW EXECUTE FUNCTION app.fill_catalog_item_id('marital_status', 'marital_status_catalog_item_id', 'marital_status');
DROP TRIGGER IF EXISTS trg_catalog_second_nationality_catalog_item_id ON persons;
CREATE TRIGGER trg_catalog_second_nationality_catalog_item_id BEFORE INSERT OR UPDATE ON persons
  FOR EACH ROW EXECUTE FUNCTION app.fill_catalog_item_id('second_nationality', 'second_nationality_catalog_item_id', 'nationality');

-- ------------------------------------------------------------- EMP-06 columns
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS employment_id                     uuid,
  ADD COLUMN IF NOT EXISTS employment_status_catalog_item_id uuid REFERENCES hr_reference_catalog_items(id),
  ADD COLUMN IF NOT EXISTS employment_status_reason          text,
  ADD COLUMN IF NOT EXISTS status_reason_catalog_item_id     uuid REFERENCES hr_reference_catalog_items(id);

CREATE INDEX IF NOT EXISTS idx_employees_employment ON employees (employment_id) WHERE employment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employees_status_catalog_item_id ON employees (employment_status_catalog_item_id) WHERE employment_status_catalog_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employees_status_reason_catalog_item_id ON employees (status_reason_catalog_item_id) WHERE status_reason_catalog_item_id IS NOT NULL;

ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_employment_status_check;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_employment_status_format_check') THEN
    ALTER TABLE employees ADD CONSTRAINT employees_employment_status_format_check
      CHECK (employment_status ~ '^[a-z][a-z0-9_]{0,39}$');
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_catalog_employment_status_catalog_item_id ON employees;
CREATE TRIGGER trg_catalog_employment_status_catalog_item_id BEFORE INSERT OR UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION app.fill_catalog_item_id('employment_status', 'employment_status_catalog_item_id', 'employment_status');
DROP TRIGGER IF EXISTS trg_catalog_status_reason_catalog_item_id ON employees;
CREATE TRIGGER trg_catalog_status_reason_catalog_item_id BEFORE INSERT OR UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION app.fill_catalog_item_id('employment_status_reason', 'status_reason_catalog_item_id', 'employment_status_reason');

-- catalog seeds for existing companies (new companies: default-catalog-seed.ts)
INSERT INTO hr_reference_catalog_items (company_id, catalog_type, code, label, sort_order)
SELECT c.id, s.catalog_type, s.code, s.label, s.sort_order
  FROM companies c
 CROSS JOIN (VALUES
   ('employment_status','active','Active',0), ('employment_status','on_leave','On leave',1),
   ('employment_status','suspended','Suspended',2), ('employment_status','notice_period','Serving notice',3),
   ('employment_status','terminated','Terminated',4),
   ('employment_status_reason','joined','Joined',0), ('employment_status_reason','leave_started','Leave started',1),
   ('employment_status_reason','returned_from_leave','Returned from leave',2),
   ('employment_status_reason','disciplinary','Disciplinary action',3),
   ('employment_status_reason','resignation_notice','Resignation notice served',4),
   ('employment_status_reason','separated','Employment ended',5)
 ) AS s(catalog_type, code, label, sort_order)
ON CONFLICT (company_id, catalog_type, code) DO NOTHING;

-- ------------------------------------------------------------ version tables
CREATE TABLE IF NOT EXISTS person_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  person_id        uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  valid_from       date NOT NULL,
  valid_to         date,
  full_name        text,
  first_name       text,
  middle_name      text,
  last_name        text,
  preferred_name   text,
  title            text,
  gender           text,
  nationality      text,
  second_nationality text,
  language         text,
  marital_status   text,
  marital_status_date date,
  place_of_birth   text,
  national_id_type text,
  cnic             text,
  cnic_bidx        text,
  date_of_birth    date,
  date_of_birth_enc text,
  passport_number  text,
  passport_expiry  date,
  ntn              text,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_versions_window CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT person_versions_no_overlap EXCLUDE USING gist (person_id WITH =, daterange(valid_from, valid_to, '[]') WITH &&)
);
CREATE INDEX IF NOT EXISTS idx_person_versions_company ON person_versions (company_id);

CREATE TABLE IF NOT EXISTS employments (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  person_id               uuid NOT NULL REFERENCES persons(id),
  employee_id             uuid REFERENCES employees(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  period_number           integer NOT NULL CHECK (period_number >= 1),
  start_date              date NOT NULL,
  end_date                date,
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  employee_number         text,
  rehire_of_employment_id uuid REFERENCES employments(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employments_window CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT employments_period_unique UNIQUE (company_id, person_id, period_number)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employments_one_open_per_employee ON employments (employee_id) WHERE end_date IS NULL AND employee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employments_person ON employments (person_id);
CREATE INDEX IF NOT EXISTS idx_employments_employee ON employments (employee_id) WHERE employee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employments_rehire_of ON employments (rehire_of_employment_id) WHERE rehire_of_employment_id IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_employment_id_fkey') THEN
    ALTER TABLE employees ADD CONSTRAINT employees_employment_id_fkey
      FOREIGN KEY (employment_id) REFERENCES employments(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS employment_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employment_id    uuid NOT NULL REFERENCES employments(id) ON DELETE CASCADE,
  employee_id      uuid,
  valid_from       date NOT NULL,
  valid_to         date,
  employment_status text NOT NULL,
  employment_status_catalog_item_id uuid,
  status_reason    text,
  status_reason_catalog_item_id uuid,
  employment_type  text,
  employment_type_catalog_item_id uuid,
  worker_type_catalog_item_id uuid,
  date_of_joining  date,
  termination_date date,
  termination_reason text,
  termination_reason_catalog_item_id uuid,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employment_versions_window CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT employment_versions_no_overlap EXCLUDE USING gist (employment_id WITH =, daterange(valid_from, valid_to, '[]') WITH &&)
);
CREATE INDEX IF NOT EXISTS idx_employment_versions_company ON employment_versions (company_id);
CREATE INDEX IF NOT EXISTS idx_employment_versions_employee ON employment_versions (employee_id) WHERE employee_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS employee_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  employment_id    uuid,
  valid_from       date NOT NULL,
  valid_to         date,
  employee_number  text,
  org_unit_id      uuid,
  position_id      uuid,
  job_id           uuid,
  location_id      uuid,
  manager_id       uuid,
  employee_subgroup_id uuid,
  payroll_area_id  uuid,
  department       text,
  designation      text,
  salary_band      text,
  salary_band_catalog_item_id uuid,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_versions_window CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT employee_versions_no_overlap EXCLUDE USING gist (employee_id WITH =, daterange(valid_from, valid_to, '[]') WITH &&)
);
CREATE INDEX IF NOT EXISTS idx_employee_versions_company ON employee_versions (company_id);
CREATE INDEX IF NOT EXISTS idx_employee_versions_org_unit ON employee_versions (org_unit_id) WHERE org_unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employee_versions_position ON employee_versions (position_id) WHERE position_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['person_versions', 'employments', 'employment_versions', 'employee_versions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_update', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())', t || '_update', t);
    EXECUTE format('GRANT SELECT ON %I TO app_role', t);
  END LOOP;
END $$;
-- employments is written by triggers running as the caller (employees triggers),
-- so the caller needs write privileges there; the three version tables are
-- written only through app.roll_version (SECURITY DEFINER).
GRANT INSERT, UPDATE ON employments TO app_role;

-- ------------------------------------------------------------------ helpers
CREATE OR REPLACE FUNCTION app.effective_date() RETURNS date LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.effective_date', true), '')::date, CURRENT_DATE)
$$;

-- Rolls an effective-dated snapshot: unchanged -> no-op; same start day -> update
-- in place; later day -> close the open window the day before and open a new one.
-- Never deletes. A retroactive date is clamped to the open version's start.
CREATE OR REPLACE FUNCTION app.roll_version(p_table text, p_key_col text, p_key uuid, p_eff date, p_snapshot jsonb, p_cols text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  cur jsonb;
  cur_id uuid;
  cur_from date;
  eff date := p_eff;
  changed boolean;
  collist text;
  ins_cols text[];
BEGIN
  EXECUTE format('SELECT to_jsonb(t), t.id, t.valid_from FROM %I t WHERE %I = $1 AND t.valid_to IS NULL', p_table, p_key_col)
    INTO cur, cur_id, cur_from USING p_key;
  IF cur_id IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM unnest(p_cols) c WHERE (cur ->> c) IS DISTINCT FROM (p_snapshot ->> c)) INTO changed;
    IF NOT changed THEN RETURN; END IF;
    eff := GREATEST(eff, cur_from);
    IF eff = cur_from THEN
      SELECT string_agg(format('%I', c), ', ') INTO collist FROM unnest(p_cols) c;
      EXECUTE format('UPDATE %I SET (%s) = (SELECT %s FROM jsonb_populate_record(NULL::%I, $1) r) WHERE id = $2',
                     p_table, collist, (SELECT string_agg(format('r.%I', c), ', ') FROM unnest(p_cols) c), p_table)
        USING p_snapshot, cur_id;
      RETURN;
    END IF;
    EXECUTE format('UPDATE %I SET valid_to = $1 WHERE id = $2', p_table) USING eff - 1, cur_id;
  END IF;
  ins_cols := p_cols || ARRAY['company_id', p_key_col, 'valid_from'];
  SELECT string_agg(format('%I', c), ', ') INTO collist FROM unnest(ins_cols) c;
  EXECUTE format('INSERT INTO %I (%s) SELECT %s FROM jsonb_populate_record(NULL::%I, $1) r',
                 p_table, collist, (SELECT string_agg(format('r.%I', c), ', ') FROM unnest(ins_cols) c), p_table)
    USING p_snapshot || jsonb_build_object('valid_from', eff);
END $$;

-- --------------------------------------------------------- triggers: persons
CREATE OR REPLACE FUNCTION app.trg_person_roll_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.roll_version('person_versions', 'person_id', NEW.id, app.effective_date(),
    jsonb_build_object(
      'company_id', NEW.company_id, 'person_id', NEW.id, 'full_name', NEW.full_name, 'first_name', NEW.first_name,
      'middle_name', NEW.middle_name, 'last_name', NEW.last_name, 'preferred_name', NEW.preferred_name,
      'title', NEW.title, 'gender', NEW.gender, 'nationality', NEW.nationality, 'second_nationality', NEW.second_nationality,
      'language', NEW.language, 'marital_status', NEW.marital_status, 'marital_status_date', NEW.marital_status_date,
      'place_of_birth', NEW.place_of_birth, 'national_id_type', NEW.national_id_type, 'cnic', NEW.cnic,
      'cnic_bidx', NEW.cnic_bidx, 'date_of_birth', NEW.date_of_birth, 'date_of_birth_enc', NEW.date_of_birth_enc,
      'passport_number', NEW.passport_number, 'passport_expiry', NEW.passport_expiry, 'ntn', NEW.ntn),
    ARRAY['full_name','first_name','middle_name','last_name','preferred_name','title','gender','nationality',
          'second_nationality','language','marital_status','marital_status_date','place_of_birth','national_id_type',
          'cnic','cnic_bidx','date_of_birth','date_of_birth_enc','passport_number','passport_expiry','ntn']);
  RETURN NULL;
END $$;

-- canonical direction: persons -> employees compatibility projection
CREATE OR REPLACE FUNCTION app.trg_person_propagate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.identity_sync', true) = 'on' THEN RETURN NULL; END IF;
  IF (NEW.first_name, NEW.last_name, NEW.gender, NEW.marital_status, NEW.cnic, NEW.cnic_bidx, NEW.date_of_birth, NEW.date_of_birth_enc)
     IS NOT DISTINCT FROM (OLD.first_name, OLD.last_name, OLD.gender, OLD.marital_status, OLD.cnic, OLD.cnic_bidx, OLD.date_of_birth, OLD.date_of_birth_enc) THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('app.identity_sync', 'on', true);
  UPDATE employees e SET
      first_name = COALESCE(NEW.first_name, e.first_name),
      last_name = COALESCE(NEW.last_name, e.last_name),
      gender = NEW.gender,
      marital_status = NEW.marital_status,
      cnic = NEW.cnic, cnic_bidx = NEW.cnic_bidx,
      date_of_birth = COALESCE(NEW.date_of_birth, e.date_of_birth),
      date_of_birth_enc = COALESCE(NEW.date_of_birth_enc, e.date_of_birth_enc),
      updated_at = now()
    WHERE e.person_id = NEW.id
      AND (e.first_name, e.last_name, e.gender, e.marital_status, e.cnic, e.cnic_bidx, e.date_of_birth, e.date_of_birth_enc)
          IS DISTINCT FROM (COALESCE(NEW.first_name, e.first_name), COALESCE(NEW.last_name, e.last_name), NEW.gender, NEW.marital_status,
                            NEW.cnic, NEW.cnic_bidx, COALESCE(NEW.date_of_birth, e.date_of_birth), COALESCE(NEW.date_of_birth_enc, e.date_of_birth_enc));
  PERFORM set_config('app.identity_sync', 'off', true);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.identity_sync', 'off', true);
  RAISE;
END $$;

DROP TRIGGER IF EXISTS trg_person_roll_version ON persons;
CREATE TRIGGER trg_person_roll_version AFTER INSERT OR UPDATE ON persons
  FOR EACH ROW EXECUTE FUNCTION app.trg_person_roll_version();
DROP TRIGGER IF EXISTS trg_person_propagate ON persons;
CREATE TRIGGER trg_person_propagate AFTER UPDATE ON persons
  FOR EACH ROW EXECUTE FUNCTION app.trg_person_propagate();

-- ------------------------------------------------------- triggers: employees
-- 10: make sure the employee has a person (link by CNIC or create)
CREATE OR REPLACE FUNCTION app.trg_employee_person() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid uuid;
BEGIN
  IF NEW.person_id IS NOT NULL THEN RETURN NEW; END IF;
  IF NEW.cnic_bidx IS NOT NULL OR NEW.cnic IS NOT NULL THEN
    SELECT id INTO pid FROM persons
     WHERE company_id = NEW.company_id
       AND ((NEW.cnic_bidx IS NOT NULL AND cnic_bidx = NEW.cnic_bidx) OR (NEW.cnic IS NOT NULL AND cnic = NEW.cnic))
     LIMIT 1;
  END IF;
  IF pid IS NULL THEN
    INSERT INTO persons (company_id, full_name, first_name, last_name, cnic, cnic_bidx, date_of_birth, date_of_birth_enc, gender, marital_status)
    VALUES (NEW.company_id, NEW.first_name || ' ' || NEW.last_name, NEW.first_name, NEW.last_name, NEW.cnic, NEW.cnic_bidx,
            NEW.date_of_birth, NEW.date_of_birth_enc, NEW.gender, NEW.marital_status)
    ON CONFLICT DO NOTHING
    RETURNING id INTO pid;
    IF pid IS NULL THEN
      SELECT id INTO pid FROM persons
       WHERE company_id = NEW.company_id
         AND ((NEW.cnic_bidx IS NOT NULL AND cnic_bidx = NEW.cnic_bidx) OR (NEW.cnic IS NOT NULL AND cnic = NEW.cnic))
       LIMIT 1;
    END IF;
  END IF;
  NEW.person_id := pid;
  RETURN NEW;
END $$;

-- 20: employment period bookkeeping (EMP-04 / LIF-06 groundwork)
CREATE OR REPLACE FUNCTION app.trg_employee_employment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prev_id uuid;
  prev_end date;
  n integer;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.employment_id IS NULL
     OR (OLD.employment_status = 'terminated' AND NEW.employment_status <> 'terminated') THEN
    PERFORM pg_advisory_xact_lock(hashtext('employment:' || NEW.person_id::text));
    SELECT id, end_date INTO prev_id, prev_end FROM employments
     WHERE company_id = NEW.company_id AND person_id = NEW.person_id AND end_date IS NOT NULL
     ORDER BY period_number DESC LIMIT 1;
    SELECT COALESCE(max(period_number), 0) + 1 INTO n FROM employments
     WHERE company_id = NEW.company_id AND person_id = NEW.person_id;
    IF TG_OP = 'UPDATE' AND OLD.employment_id IS NOT NULL AND OLD.employment_status = 'terminated' THEN
      prev_id := OLD.employment_id;
    END IF;
    INSERT INTO employments (company_id, person_id, employee_id, period_number, start_date, end_date, status, employee_number, rehire_of_employment_id)
    VALUES (NEW.company_id, NEW.person_id, NEW.id, n,
            CASE WHEN TG_OP = 'UPDATE' AND OLD.employment_status = 'terminated' THEN CURRENT_DATE ELSE NEW.date_of_joining END,
            CASE WHEN NEW.employment_status = 'terminated' THEN GREATEST(COALESCE(NEW.termination_date, NEW.date_of_joining), NEW.date_of_joining) END,
            CASE WHEN NEW.employment_status = 'terminated' THEN 'ended' ELSE 'active' END,
            NEW.employee_number, prev_id)
    RETURNING id INTO NEW.employment_id;
    RETURN NEW;
  END IF;
  -- UPDATE on an existing open/closed period
  IF NEW.employment_status = 'terminated' AND (OLD.employment_status <> 'terminated' OR NEW.termination_date IS DISTINCT FROM OLD.termination_date) THEN
    UPDATE employments SET end_date = GREATEST(COALESCE(NEW.termination_date, CURRENT_DATE), start_date), status = 'ended', updated_at = now()
     WHERE id = NEW.employment_id;
  END IF;
  IF NEW.date_of_joining IS DISTINCT FROM OLD.date_of_joining THEN
    UPDATE employments SET start_date = LEAST(NEW.date_of_joining, COALESCE(end_date, NEW.date_of_joining)), updated_at = now()
     WHERE id = NEW.employment_id AND period_number = (SELECT min(period_number) FROM employments WHERE person_id = NEW.person_id AND company_id = NEW.company_id);
  END IF;
  IF NEW.employee_number IS DISTINCT FROM OLD.employee_number THEN
    UPDATE employments SET employee_number = NEW.employee_number, updated_at = now() WHERE id = NEW.employment_id;
  END IF;
  RETURN NEW;
END $$;

-- 30: status must be a system state or an active catalog item (EMP-06)
CREATE OR REPLACE FUNCTION app.trg_employee_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.employment_status IN ('active', 'on_leave', 'terminated') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.employment_status = OLD.employment_status THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM hr_reference_catalog_items
                  WHERE company_id = NEW.company_id AND catalog_type = 'employment_status'
                    AND code = NEW.employment_status AND is_active AND retired_at IS NULL) THEN
    RAISE EXCEPTION 'employment_status % is not an active employment_status catalog item', NEW.employment_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- write-through for legacy writers: employees -> persons (+ sibling employment rows)
CREATE OR REPLACE FUNCTION app.trg_employee_identity_writethrough() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.identity_sync', true) = 'on' OR NEW.person_id IS NULL THEN RETURN NULL; END IF;
  IF (NEW.first_name, NEW.last_name, NEW.gender, NEW.marital_status, NEW.cnic, NEW.cnic_bidx, NEW.date_of_birth, NEW.date_of_birth_enc)
     IS NOT DISTINCT FROM (OLD.first_name, OLD.last_name, OLD.gender, OLD.marital_status, OLD.cnic, OLD.cnic_bidx, OLD.date_of_birth, OLD.date_of_birth_enc) THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('app.identity_sync', 'on', true);
  UPDATE persons SET
      first_name = NEW.first_name, last_name = NEW.last_name, full_name = NEW.first_name || ' ' || NEW.last_name,
      gender = NEW.gender, marital_status = NEW.marital_status,
      cnic = NEW.cnic, cnic_bidx = NEW.cnic_bidx, date_of_birth = NEW.date_of_birth, date_of_birth_enc = NEW.date_of_birth_enc,
      updated_at = now()
    WHERE id = NEW.person_id;
  UPDATE employees e SET
      first_name = NEW.first_name, last_name = NEW.last_name, gender = NEW.gender, marital_status = NEW.marital_status,
      cnic = NEW.cnic, cnic_bidx = NEW.cnic_bidx, date_of_birth = NEW.date_of_birth, date_of_birth_enc = NEW.date_of_birth_enc,
      updated_at = now()
    WHERE e.person_id = NEW.person_id AND e.id <> NEW.id
      AND (e.first_name, e.last_name, e.gender, e.marital_status, e.cnic, e.cnic_bidx, e.date_of_birth, e.date_of_birth_enc)
          IS DISTINCT FROM (NEW.first_name, NEW.last_name, NEW.gender, NEW.marital_status, NEW.cnic, NEW.cnic_bidx, NEW.date_of_birth, NEW.date_of_birth_enc);
  PERFORM set_config('app.identity_sync', 'off', true);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.identity_sync', 'off', true);
  RAISE;
END $$;

-- version rolls for employee assignment + employment state
CREATE OR REPLACE FUNCTION app.trg_employee_roll_versions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  eff date;
  explicit boolean := COALESCE(NULLIF(current_setting('app.effective_date', true), ''), '') <> '';
  v_job uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    eff := NEW.date_of_joining;
  ELSIF explicit THEN
    eff := app.effective_date();
  ELSIF NEW.employment_status = 'terminated' AND OLD.employment_status <> 'terminated' AND NEW.termination_date IS NOT NULL THEN
    eff := NEW.termination_date;
  ELSE
    eff := CURRENT_DATE;
  END IF;
  IF NEW.position_id IS NOT NULL THEN SELECT job_id INTO v_job FROM positions WHERE id = NEW.position_id; END IF;

  PERFORM app.roll_version('employee_versions', 'employee_id', NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN eff ELSE eff END,
    jsonb_build_object(
      'company_id', NEW.company_id, 'employee_id', NEW.id, 'employment_id', NEW.employment_id,
      'employee_number', NEW.employee_number, 'org_unit_id', NEW.org_unit_id, 'position_id', NEW.position_id,
      'job_id', v_job, 'location_id', NEW.location_id, 'manager_id', NEW.manager_id,
      'employee_subgroup_id', NEW.employee_subgroup_id, 'payroll_area_id', NEW.payroll_area_id,
      'department', NEW.department, 'designation', NEW.designation, 'salary_band', NEW.salary_band,
      'salary_band_catalog_item_id', NEW.salary_band_catalog_item_id),
    ARRAY['employment_id','employee_number','org_unit_id','position_id','job_id','location_id','manager_id',
          'employee_subgroup_id','payroll_area_id','department','designation','salary_band','salary_band_catalog_item_id']);

  IF NEW.employment_id IS NOT NULL THEN
    PERFORM app.roll_version('employment_versions', 'employment_id', NEW.employment_id, eff,
      jsonb_build_object(
        'company_id', NEW.company_id, 'employment_id', NEW.employment_id, 'employee_id', NEW.id,
        'employment_status', NEW.employment_status, 'employment_status_catalog_item_id', NEW.employment_status_catalog_item_id,
        'status_reason', NEW.employment_status_reason, 'status_reason_catalog_item_id', NEW.status_reason_catalog_item_id,
        'employment_type', NEW.employment_type, 'employment_type_catalog_item_id', NEW.employment_type_catalog_item_id,
        'worker_type_catalog_item_id', NEW.worker_type_catalog_item_id,
        'date_of_joining', NEW.date_of_joining, 'termination_date', NEW.termination_date,
        'termination_reason', NEW.termination_reason, 'termination_reason_catalog_item_id', NEW.termination_reason_catalog_item_id),
      ARRAY['employee_id','employment_status','employment_status_catalog_item_id','status_reason','status_reason_catalog_item_id',
            'employment_type','employment_type_catalog_item_id','worker_type_catalog_item_id','date_of_joining','termination_date',
            'termination_reason','termination_reason_catalog_item_id']);
  END IF;
  RETURN NULL;
END $$;

-- ------------------------------------------------------------------ backfill
-- (before the employee triggers exist so the historical dating below is exact)
SELECT set_config('app.identity_sync', 'on', false);

-- 1. link existing employees to an existing person by CNIC
UPDATE employees e SET person_id = p.id
  FROM persons p
 WHERE e.person_id IS NULL AND p.company_id = e.company_id
   AND ((e.cnic_bidx IS NOT NULL AND p.cnic_bidx = e.cnic_bidx) OR (e.cnic IS NOT NULL AND p.cnic = e.cnic));

-- 2. create persons for the rest (one per CNIC group, or per employee without a CNIC)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM employees WHERE person_id IS NULL) THEN
    CREATE TEMP TABLE _bf_emp ON COMMIT DROP AS
      SELECT e.id AS emp_id, e.company_id,
             COALESCE('b:' || e.cnic_bidx, 'c:' || e.cnic, 'e:' || e.id::text) AS grp,
             row_number() OVER (PARTITION BY e.company_id, COALESCE('b:' || e.cnic_bidx, 'c:' || e.cnic, 'e:' || e.id::text)
                                ORDER BY e.date_of_joining DESC, e.created_at DESC) AS rn
        FROM employees e WHERE e.person_id IS NULL;
    CREATE TEMP TABLE _bf_person ON COMMIT DROP AS
      SELECT b.company_id, b.grp, b.emp_id AS latest_emp, gen_random_uuid() AS pid FROM _bf_emp b WHERE b.rn = 1;
    INSERT INTO persons (id, company_id, full_name, first_name, last_name, cnic, cnic_bidx, date_of_birth, date_of_birth_enc, gender, marital_status)
    SELECT bp.pid, bp.company_id, e.first_name || ' ' || e.last_name, e.first_name, e.last_name, e.cnic, e.cnic_bidx,
           e.date_of_birth, e.date_of_birth_enc, e.gender, e.marital_status
      FROM _bf_person bp JOIN employees e ON e.id = bp.latest_emp;
    UPDATE employees e SET person_id = bp.pid
      FROM _bf_emp b JOIN _bf_person bp ON bp.company_id = b.company_id AND bp.grp = b.grp
     WHERE e.id = b.emp_id;
  END IF;
END $$;

-- 3. fill the new person columns from the latest linked employee
UPDATE persons p SET
    first_name = COALESCE(p.first_name, s.first_name),
    last_name = COALESCE(p.last_name, s.last_name),
    marital_status = COALESCE(p.marital_status, s.marital_status)
  FROM (SELECT DISTINCT ON (person_id) person_id, first_name, last_name, marital_status
          FROM employees WHERE person_id IS NOT NULL
         ORDER BY person_id, date_of_joining DESC, created_at DESC) s
 WHERE s.person_id = p.id AND (p.first_name IS NULL OR p.last_name IS NULL OR p.marital_status IS NULL);

-- 4. employments (one per employee row, numbered per person)
INSERT INTO employments (id, company_id, person_id, employee_id, period_number, start_date, end_date, status, employee_number, rehire_of_employment_id)
SELECT s.eid, s.company_id, s.person_id, s.emp_id, s.rn, s.date_of_joining,
       CASE WHEN s.employment_status = 'terminated' THEN GREATEST(COALESCE(s.termination_date, s.date_of_joining), s.date_of_joining) END,
       CASE WHEN s.employment_status = 'terminated' THEN 'ended' ELSE 'active' END,
       s.employee_number,
       CASE WHEN s.prev_status = 'terminated' THEN s.prev_eid END
  FROM (
    SELECT e.id AS emp_id, gen_random_uuid() AS eid, e.company_id, e.person_id, e.date_of_joining, e.employment_status,
           e.termination_date, e.employee_number,
           (SELECT COALESCE(max(x.period_number), 0) FROM employments x WHERE x.person_id = e.person_id AND x.company_id = e.company_id)
             + row_number() OVER (PARTITION BY e.person_id ORDER BY e.date_of_joining, e.created_at, e.id) AS rn,
           NULL::uuid AS prev_eid, NULL::text AS prev_status
      FROM employees e WHERE e.employment_id IS NULL
  ) s;

-- rehire links: previous period of the same person, only when it had ended
UPDATE employments cur SET rehire_of_employment_id = prev.id
  FROM employments prev
 WHERE cur.rehire_of_employment_id IS NULL AND prev.company_id = cur.company_id AND prev.person_id = cur.person_id
   AND prev.period_number = cur.period_number - 1 AND prev.end_date IS NOT NULL;

UPDATE employees e SET employment_id = m.id
  FROM employments m WHERE m.employee_id = e.id AND e.employment_id IS NULL
   AND m.id = (SELECT id FROM employments WHERE employee_id = e.id ORDER BY period_number DESC LIMIT 1);

-- 5. versions
INSERT INTO person_versions (company_id, person_id, valid_from, full_name, first_name, middle_name, last_name, preferred_name, title, gender,
    nationality, second_nationality, language, marital_status, marital_status_date, place_of_birth, national_id_type, cnic, cnic_bidx,
    date_of_birth, date_of_birth_enc, passport_number, passport_expiry, ntn)
SELECT p.company_id, p.id,
       LEAST(p.created_at::date, COALESCE((SELECT min(e.date_of_joining) FROM employees e WHERE e.person_id = p.id), p.created_at::date)),
       p.full_name, p.first_name, p.middle_name, p.last_name, p.preferred_name, p.title, p.gender, p.nationality, p.second_nationality,
       p.language, p.marital_status, p.marital_status_date, p.place_of_birth, p.national_id_type, p.cnic, p.cnic_bidx,
       p.date_of_birth, p.date_of_birth_enc, p.passport_number, p.passport_expiry, p.ntn
  FROM persons p
 WHERE NOT EXISTS (SELECT 1 FROM person_versions v WHERE v.person_id = p.id);

INSERT INTO employee_versions (company_id, employee_id, employment_id, valid_from, employee_number, org_unit_id, position_id, job_id, location_id,
    manager_id, employee_subgroup_id, payroll_area_id, department, designation, salary_band, salary_band_catalog_item_id)
SELECT e.company_id, e.id, e.employment_id, e.date_of_joining, e.employee_number, e.org_unit_id, e.position_id,
       (SELECT job_id FROM positions WHERE id = e.position_id), e.location_id, e.manager_id, e.employee_subgroup_id,
       e.payroll_area_id, e.department, e.designation, e.salary_band, e.salary_band_catalog_item_id
  FROM employees e
 WHERE NOT EXISTS (SELECT 1 FROM employee_versions v WHERE v.employee_id = e.id);

-- active window before the termination date (terminated employees only)
INSERT INTO employment_versions (company_id, employment_id, employee_id, valid_from, valid_to, employment_status, employment_type,
    employment_type_catalog_item_id, worker_type_catalog_item_id, date_of_joining)
SELECT e.company_id, e.employment_id, e.id, e.date_of_joining, e.termination_date - 1, 'active', e.employment_type,
       e.employment_type_catalog_item_id, e.worker_type_catalog_item_id, e.date_of_joining
  FROM employees e
 WHERE e.employment_id IS NOT NULL AND e.employment_status = 'terminated' AND e.termination_date IS NOT NULL
   AND e.termination_date > e.date_of_joining
   AND NOT EXISTS (SELECT 1 FROM employment_versions v WHERE v.employment_id = e.employment_id);

INSERT INTO employment_versions (company_id, employment_id, employee_id, valid_from, employment_status, employment_status_catalog_item_id,
    status_reason, status_reason_catalog_item_id, employment_type, employment_type_catalog_item_id, worker_type_catalog_item_id,
    date_of_joining, termination_date, termination_reason, termination_reason_catalog_item_id)
SELECT e.company_id, e.employment_id, e.id,
       CASE WHEN e.employment_status = 'terminated' AND e.termination_date IS NOT NULL AND e.termination_date > e.date_of_joining
            THEN e.termination_date ELSE e.date_of_joining END,
       e.employment_status, e.employment_status_catalog_item_id, e.employment_status_reason, e.status_reason_catalog_item_id,
       e.employment_type, e.employment_type_catalog_item_id, e.worker_type_catalog_item_id,
       e.date_of_joining, e.termination_date, e.termination_reason, e.termination_reason_catalog_item_id
  FROM employees e
 WHERE e.employment_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM employment_versions v WHERE v.employment_id = e.employment_id AND v.valid_to IS NULL);

-- status catalog links for existing rows
UPDATE employees e SET employment_status_catalog_item_id = c.id
  FROM hr_reference_catalog_items c
 WHERE e.employment_status_catalog_item_id IS NULL AND c.company_id = e.company_id
   AND c.catalog_type = 'employment_status' AND c.code = e.employment_status;

SELECT set_config('app.identity_sync', 'off', false);

-- EMP-02: every employee has a person
ALTER TABLE employees ALTER COLUMN person_id SET NOT NULL;

-- -------------------------------------------------------- employee triggers
DROP TRIGGER IF EXISTS trg_employee_10_person ON employees;
CREATE TRIGGER trg_employee_10_person BEFORE INSERT ON employees
  FOR EACH ROW EXECUTE FUNCTION app.trg_employee_person();
DROP TRIGGER IF EXISTS trg_employee_20_employment ON employees;
CREATE TRIGGER trg_employee_20_employment BEFORE INSERT OR UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION app.trg_employee_employment();
DROP TRIGGER IF EXISTS trg_employee_30_status ON employees;
CREATE TRIGGER trg_employee_30_status BEFORE INSERT OR UPDATE OF employment_status ON employees
  FOR EACH ROW EXECUTE FUNCTION app.trg_employee_status();
DROP TRIGGER IF EXISTS trg_employee_40_writethrough ON employees;
CREATE TRIGGER trg_employee_40_writethrough AFTER UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION app.trg_employee_identity_writethrough();
DROP TRIGGER IF EXISTS trg_employee_50_versions ON employees;
CREATE TRIGGER trg_employee_50_versions AFTER INSERT OR UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION app.trg_employee_roll_versions();

-- ------------------------------------------------------- as-of + drift reads
CREATE OR REPLACE FUNCTION app.employee_as_of(p_date date, p_employee uuid DEFAULT NULL)
RETURNS TABLE (
  employee_id uuid, as_of date, person_id uuid, employment_id uuid, period_number integer, employee_number text,
  full_name text, first_name text, last_name text, preferred_name text, gender text, marital_status text, nationality text,
  org_unit_id uuid, position_id uuid, job_id uuid, location_id uuid, manager_id uuid, employee_subgroup_id uuid,
  payroll_area_id uuid, department text, designation text, salary_band text,
  employment_type text, worker_type_catalog_item_id uuid, employment_status text, status_reason text,
  date_of_joining date, termination_date date
) LANGUAGE sql STABLE AS $$
  SELECT ev.employee_id, p_date, e.person_id, ev.employment_id, em.period_number, ev.employee_number,
         pv.full_name, pv.first_name, pv.last_name, pv.preferred_name, pv.gender, pv.marital_status, pv.nationality,
         ev.org_unit_id, ev.position_id, ev.job_id, ev.location_id, ev.manager_id, ev.employee_subgroup_id,
         ev.payroll_area_id, ev.department, ev.designation, ev.salary_band,
         mv.employment_type, mv.worker_type_catalog_item_id, mv.employment_status, mv.status_reason,
         mv.date_of_joining, mv.termination_date
    FROM employee_versions ev
    JOIN employees e ON e.id = ev.employee_id
    LEFT JOIN employments em ON em.id = ev.employment_id
    LEFT JOIN employment_versions mv ON mv.employment_id = ev.employment_id
         AND mv.valid_from <= p_date AND (mv.valid_to IS NULL OR mv.valid_to >= p_date)
    LEFT JOIN person_versions pv ON pv.person_id = e.person_id
         AND pv.valid_from <= p_date AND (pv.valid_to IS NULL OR pv.valid_to >= p_date)
   WHERE ev.valid_from <= p_date AND (ev.valid_to IS NULL OR ev.valid_to >= p_date)
     AND (p_employee IS NULL OR ev.employee_id = p_employee)
$$;
GRANT EXECUTE ON FUNCTION app.employee_as_of(date, uuid) TO app_role;

-- Reports employees whose compatibility identity columns differ from persons.
CREATE OR REPLACE FUNCTION app.identity_drift(p_company uuid)
RETURNS TABLE (employee_id uuid, person_id uuid, field text) LANGUAGE sql STABLE AS $$
  SELECT e.id, e.person_id, f.field FROM employees e JOIN persons p ON p.id = e.person_id
  CROSS JOIN LATERAL (VALUES
    ('first_name', p.first_name IS NOT NULL AND e.first_name IS DISTINCT FROM p.first_name),
    ('last_name', p.last_name IS NOT NULL AND e.last_name IS DISTINCT FROM p.last_name),
    ('gender', e.gender IS DISTINCT FROM p.gender),
    ('marital_status', e.marital_status IS DISTINCT FROM p.marital_status),
    ('cnic_bidx', e.cnic_bidx IS DISTINCT FROM p.cnic_bidx),
    ('date_of_birth_enc', e.date_of_birth_enc IS DISTINCT FROM p.date_of_birth_enc)
  ) AS f(field, differs)
  WHERE e.company_id = p_company AND f.differs
$$;
GRANT EXECUTE ON FUNCTION app.identity_drift(uuid) TO app_role;
