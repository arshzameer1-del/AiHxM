-- Gap Register CAT-01, CAT-02, CAT-03, CAT-04 (Step 3): the catalog backbone.
--
-- ADDITIVE ONLY. No existing column or value is changed.
--
--  CAT-01  hr_reference_catalog_items gains effective_from/to, applicability
--          (jsonb scope rules), labels (jsonb locale -> text, for Urdu etc.),
--          retired_at. app.catalog_item_usage(id) counts references. Items
--          that are referenced cannot be hard-deleted (foreign keys below,
--          NO ACTION so a whole-company cascade delete still works) and the
--          app role has no DELETE grant on the table anyway.
--  CAT-02/03/04  Every free-text classification column keeps its text (now a
--          read-only compatibility value) and gains a sibling
--          <name>_catalog_item_id uuid FK. A BEFORE INSERT/UPDATE trigger
--          fills the id from the text when -- and only when -- the match is
--          unambiguous (exact code, else a case-insensitive label that is
--          unique). Nothing is invented: no match leaves the id NULL.
--          Existing rows are backfilled the same way.
--  New catalog types: gender, worker_type, salary_band (tenant-defined, not
--          seeded), asset_type. Seeded for all existing companies; new
--          companies get them lazily (HrReferenceCatalogService).
--
-- ROLLBACK: DROP TRIGGER trg_catalog_* on each table; DROP FUNCTION
--   app.fill_catalog_item_id(), app.fill_job_history_reason_item(),
--   app.resolve_catalog_item(), app.catalog_item_usage(); ALTER TABLE ... DROP
--   COLUMN *_catalog_item_id (list below); ALTER TABLE hr_reference_catalog_items
--   DROP COLUMN effective_from, effective_to, applicability, labels, retired_at;
--   DELETE the four new catalog types' rows if unused.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- ---------------------------------------------------------------- CAT-01
ALTER TABLE hr_reference_catalog_items
  ADD COLUMN IF NOT EXISTS effective_from date,
  ADD COLUMN IF NOT EXISTS effective_to   date,
  ADD COLUMN IF NOT EXISTS applicability  jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS labels         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS retired_at     timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hr_ref_catalog_effective_range_chk') THEN
    ALTER TABLE hr_reference_catalog_items
      ADD CONSTRAINT hr_ref_catalog_effective_range_chk
      CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from);
  END IF;
END $$;

-- ------------------------------------------------- catalog id columns (FKs)
DO $$
DECLARE
  spec text[];
  specs text[][] := ARRAY[
    ['employees','employment_type_catalog_item_id'],
    ['employees','gender_catalog_item_id'],
    ['employees','marital_status_catalog_item_id'],
    ['employees','salary_band_catalog_item_id'],
    ['employees','termination_reason_catalog_item_id'],
    ['employees','worker_type_catalog_item_id'],
    ['employee_job_history','reason_catalog_item_id'],
    ['employee_job_history','salary_band_catalog_item_id'],
    ['employee_addresses','address_type_catalog_item_id'],
    ['employee_contacts','contact_type_catalog_item_id'],
    ['employee_family_members','relationship_catalog_item_id'],
    ['employee_education','education_level_catalog_item_id'],
    ['employee_qualifications','qualification_type_catalog_item_id'],
    ['employee_documents','document_type_catalog_item_id'],
    ['employee_assets','asset_type_catalog_item_id'],
    ['persons','nationality_catalog_item_id']
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(specs, 1) LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I uuid REFERENCES hr_reference_catalog_items(id)',
      specs[i][1], specs[i][2]);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I (%I) WHERE %I IS NOT NULL',
      'idx_' || specs[i][1] || '_' || specs[i][2], specs[i][1], specs[i][2], specs[i][2]);
  END LOOP;
END $$;

-- ------------------------------------------------------ resolver + usage
-- Unambiguous resolution only: exact code wins; otherwise a label that matches
-- exactly one item case-insensitively. Inactive/retired items still resolve
-- so historical rows keep their link.
CREATE OR REPLACE FUNCTION app.resolve_catalog_item(p_company uuid, p_type text, p_value text)
RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE
  hit uuid;
  n int;
BEGIN
  IF p_value IS NULL OR btrim(p_value) = '' THEN RETURN NULL; END IF;
  SELECT id INTO hit FROM hr_reference_catalog_items
   WHERE company_id = p_company AND catalog_type = p_type AND code = p_value;
  IF hit IS NOT NULL THEN RETURN hit; END IF;
  SELECT count(*), min(id::text)::uuid INTO n, hit FROM hr_reference_catalog_items
   WHERE company_id = p_company AND catalog_type = p_type AND lower(label) = lower(btrim(p_value));
  IF n = 1 THEN RETURN hit; END IF;
  RETURN NULL;
END $$;

-- How many rows reference a catalog item, across every table that has a
-- foreign key to it. Used to decide whether an item may be retired/removed.
CREATE OR REPLACE FUNCTION app.catalog_item_usage(p_item uuid)
RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE
  r record;
  total bigint := 0;
  n bigint;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND c.confrelid = 'hr_reference_catalog_items'::regclass
  LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', r.tbl, r.col) INTO n USING p_item;
    total := total + n;
  END LOOP;
  RETURN total;
END $$;

-- ------------------------------------------------------------- triggers
-- args: text column, id column, catalog type
CREATE OR REPLACE FUNCTION app.fill_catalog_item_id() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tcol text := TG_ARGV[0];
  icol text := TG_ARGV[1];
  ctype text := TG_ARGV[2];
  nj jsonb := to_jsonb(NEW);
  oj jsonb;
  rid uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    oj := to_jsonb(OLD);
    -- caller changed the id explicitly: respect it
    IF (nj->>icol) IS DISTINCT FROM (oj->>icol) THEN RETURN NEW; END IF;
    -- text unchanged and already linked: nothing to do
    IF (nj->>tcol) IS NOT DISTINCT FROM (oj->>tcol) AND (nj->>icol) IS NOT NULL THEN RETURN NEW; END IF;
  ELSIF (nj->>icol) IS NOT NULL THEN
    RETURN NEW; -- insert with explicit id
  END IF;
  rid := app.resolve_catalog_item((nj->>'company_id')::uuid, ctype, nj->>tcol);
  NEW := jsonb_populate_record(NEW, jsonb_build_object(icol, rid));
  RETURN NEW;
END $$;

-- job history: the reason catalog depends on the event type
CREATE OR REPLACE FUNCTION app.fill_job_history_reason_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ctype text;
  rid uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.reason_catalog_item_id IS DISTINCT FROM OLD.reason_catalog_item_id THEN RETURN NEW; END IF;
    IF NEW.reason_code IS NOT DISTINCT FROM OLD.reason_code AND NEW.event_type IS NOT DISTINCT FROM OLD.event_type
       AND NEW.reason_catalog_item_id IS NOT NULL THEN RETURN NEW; END IF;
  ELSIF NEW.reason_catalog_item_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  ctype := CASE NEW.event_type
    WHEN 'acting' THEN 'lifecycle_reason:acting_assignment'
    WHEN 'salary_change' THEN 'lifecycle_reason:compensation_change'
    WHEN 'reactivation' THEN 'lifecycle_reason:return_from_leave'
    WHEN 'position_assignment' THEN 'lifecycle_reason:position_change'
    WHEN 'other' THEN NULL
    ELSE 'lifecycle_reason:' || NEW.event_type
  END;
  IF ctype IS NOT NULL THEN
    rid := app.resolve_catalog_item(NEW.company_id, ctype, NEW.reason_code);
  END IF;
  NEW.reason_catalog_item_id := rid;
  RETURN NEW;
END $$;

DO $$
DECLARE
  spec text[];
  specs text[][] := ARRAY[
    ['employees','employment_type','employment_type_catalog_item_id','employment_type'],
    ['employees','gender','gender_catalog_item_id','gender'],
    ['employees','marital_status','marital_status_catalog_item_id','marital_status'],
    ['employees','salary_band','salary_band_catalog_item_id','salary_band'],
    ['employees','termination_reason','termination_reason_catalog_item_id','lifecycle_reason:termination'],
    ['employee_job_history','salary_band','salary_band_catalog_item_id','salary_band'],
    ['employee_addresses','address_type','address_type_catalog_item_id','address_type'],
    ['employee_contacts','contact_type','contact_type_catalog_item_id','contact_type'],
    ['employee_family_members','relationship','relationship_catalog_item_id','family_relationship_type'],
    ['employee_education','degree_title','education_level_catalog_item_id','education_level'],
    ['employee_qualifications','qualification_type','qualification_type_catalog_item_id','qualification_type'],
    ['employee_documents','document_type','document_type_catalog_item_id','document_type'],
    ['employee_assets','asset_type','asset_type_catalog_item_id','asset_type'],
    ['persons','nationality','nationality_catalog_item_id','nationality']
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(specs, 1) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_catalog_' || specs[i][3], specs[i][1]);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.fill_catalog_item_id(%L, %L, %L)',
      'trg_catalog_' || specs[i][3], specs[i][1], specs[i][2], specs[i][3], specs[i][4]);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS trg_catalog_job_history_reason ON employee_job_history;
CREATE TRIGGER trg_catalog_job_history_reason BEFORE INSERT OR UPDATE ON employee_job_history
  FOR EACH ROW EXECUTE FUNCTION app.fill_job_history_reason_item();

-- ----------------------------------------------- new catalog types: seed
INSERT INTO hr_reference_catalog_items (company_id, catalog_type, code, label, sort_order)
SELECT c.id, s.catalog_type, s.code, s.label, s.sort_order
  FROM companies c
 CROSS JOIN (VALUES
   ('gender','male','Male',0), ('gender','female','Female',1), ('gender','other','Other',2),
   ('worker_type','employee','Employee',0), ('worker_type','contractor','Contractor',1), ('worker_type','consultant','Consultant',2),
   ('asset_type','laptop','Laptop',0), ('asset_type','mobile_phone','Mobile phone',1), ('asset_type','sim_card','SIM card',2),
   ('asset_type','vehicle','Vehicle',3), ('asset_type','access_card','Access card',4), ('asset_type','other','Other',5)
 ) AS s(catalog_type, code, label, sort_order)
ON CONFLICT (company_id, catalog_type, code) DO NOTHING;

-- salary_band is tenant-defined (no seed). Create an item for each distinct
-- band a company already uses? NO -- that would invent master data. Bands
-- stay unlinked until HR defines them; the trigger links them afterwards.

-- ------------------------------------------------------------- backfill
UPDATE employees SET employment_type_catalog_item_id = app.resolve_catalog_item(company_id, 'employment_type', employment_type)
 WHERE employment_type_catalog_item_id IS NULL AND employment_type IS NOT NULL;
UPDATE employees SET gender_catalog_item_id = app.resolve_catalog_item(company_id, 'gender', gender)
 WHERE gender_catalog_item_id IS NULL AND gender IS NOT NULL;
UPDATE employees SET marital_status_catalog_item_id = app.resolve_catalog_item(company_id, 'marital_status', marital_status)
 WHERE marital_status_catalog_item_id IS NULL AND marital_status IS NOT NULL;
UPDATE employees SET termination_reason_catalog_item_id = app.resolve_catalog_item(company_id, 'lifecycle_reason:termination', termination_reason)
 WHERE termination_reason_catalog_item_id IS NULL AND termination_reason IS NOT NULL;
UPDATE employee_addresses SET address_type_catalog_item_id = app.resolve_catalog_item(company_id, 'address_type', address_type)
 WHERE address_type_catalog_item_id IS NULL AND address_type IS NOT NULL;
UPDATE employee_contacts SET contact_type_catalog_item_id = app.resolve_catalog_item(company_id, 'contact_type', contact_type)
 WHERE contact_type_catalog_item_id IS NULL AND contact_type IS NOT NULL;
UPDATE employee_family_members SET relationship_catalog_item_id = app.resolve_catalog_item(company_id, 'family_relationship_type', relationship)
 WHERE relationship_catalog_item_id IS NULL AND relationship IS NOT NULL;
UPDATE employee_qualifications SET qualification_type_catalog_item_id = app.resolve_catalog_item(company_id, 'qualification_type', qualification_type)
 WHERE qualification_type_catalog_item_id IS NULL AND qualification_type IS NOT NULL;
UPDATE employee_documents SET document_type_catalog_item_id = app.resolve_catalog_item(company_id, 'document_type', document_type)
 WHERE document_type_catalog_item_id IS NULL AND document_type IS NOT NULL;
UPDATE employee_assets SET asset_type_catalog_item_id = app.resolve_catalog_item(company_id, 'asset_type', asset_type)
 WHERE asset_type_catalog_item_id IS NULL AND asset_type IS NOT NULL;
UPDATE persons SET nationality_catalog_item_id = app.resolve_catalog_item(company_id, 'nationality', nationality)
 WHERE nationality_catalog_item_id IS NULL AND nationality IS NOT NULL;
-- job history: reuse the trigger (needs event_type mapping) by touching the column
UPDATE employee_job_history SET reason_code = reason_code
 WHERE reason_catalog_item_id IS NULL AND reason_code IS NOT NULL;
