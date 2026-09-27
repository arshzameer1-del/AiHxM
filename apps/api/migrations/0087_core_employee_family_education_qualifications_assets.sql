-- Core Employee Enterprise, Phase 9 — Family/Dependents, Education,
-- Qualifications/Skills, and Assets cards (spec Section 6 cards 11/12/13/16,
-- Section 39 logical model: `employee_family_members`,
-- `employee_education`, `employee_qualifications`, `employee_assets`).
--
-- All four are LIST entities — an employee normally has several family
-- members, several education entries, several qualifications, and
-- several assets at once — so, unlike most of Phase 6/7/8's sub-entities,
-- NONE of these four get a "one open row per {employee, type}" partial
-- unique index. The only invariant worth enforcing at the database is
-- Assets' own lifecycle: `status` distinguishes an asset currently held
-- (`assigned`) from one handed back (`returned`), tracked on the SAME
-- row (not a separate history table) since an asset assignment's own
-- start/end dates ARE the fact being recorded, the same "flat,
-- non-effective-dated fact" shape 0084/0085/0086 already established for
-- every other Phase 6/7/8 sub-entity.
CREATE TABLE IF NOT EXISTS employee_family_members (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  relationship   text NOT NULL CHECK (relationship IN ('spouse', 'child', 'parent', 'sibling', 'other')),
  full_name      text NOT NULL,
  date_of_birth  date,
  cnic           text,
  is_dependent   boolean NOT NULL DEFAULT true,
  is_beneficiary boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_family_members_company ON employee_family_members (company_id);
CREATE INDEX IF NOT EXISTS idx_employee_family_members_employee ON employee_family_members (employee_id);

CREATE TABLE IF NOT EXISTS employee_education (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  degree_title   text NOT NULL,
  institution    text,
  field_of_study text,
  start_date     date,
  end_date       date,
  grade          text,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_employee_education_company ON employee_education (company_id);
CREATE INDEX IF NOT EXISTS idx_employee_education_employee ON employee_education (employee_id);

CREATE TABLE IF NOT EXISTS employee_qualifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id         uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  qualification_type  text NOT NULL CHECK (qualification_type IN ('certificate', 'license', 'skill')),
  title               text NOT NULL,
  issuing_authority   text,
  issue_date          date,
  expiry_date         date,
  proficiency_level   text,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (expiry_date IS NULL OR issue_date IS NULL OR expiry_date >= issue_date)
);
CREATE INDEX IF NOT EXISTS idx_employee_qualifications_company ON employee_qualifications (company_id);
CREATE INDEX IF NOT EXISTS idx_employee_qualifications_employee ON employee_qualifications (employee_id);

CREATE TABLE IF NOT EXISTS employee_assets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  asset_type     text NOT NULL,
  asset_tag      text,
  description    text,
  assigned_date  date NOT NULL DEFAULT CURRENT_DATE,
  returned_date  date,
  status         text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'returned')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (returned_date IS NULL OR returned_date >= assigned_date)
);
CREATE INDEX IF NOT EXISTS idx_employee_assets_company ON employee_assets (company_id);
CREATE INDEX IF NOT EXISTS idx_employee_assets_employee ON employee_assets (employee_id);

GRANT SELECT, INSERT, UPDATE ON
  employee_family_members, employee_education, employee_qualifications, employee_assets
TO app_role;

ALTER TABLE employee_family_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_family_members  FORCE ROW LEVEL SECURITY;
ALTER TABLE employee_education       ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_education       FORCE ROW LEVEL SECURITY;
ALTER TABLE employee_qualifications  ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_qualifications  FORCE ROW LEVEL SECURITY;
ALTER TABLE employee_assets          ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_assets          FORCE ROW LEVEL SECURITY;

CREATE POLICY employee_family_members_select ON employee_family_members FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_family_members_insert ON employee_family_members FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_family_members_update ON employee_family_members FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY employee_education_select ON employee_education FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_education_insert ON employee_education FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_education_update ON employee_education FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY employee_qualifications_select ON employee_qualifications FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_qualifications_insert ON employee_qualifications FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_qualifications_update ON employee_qualifications FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY employee_assets_select ON employee_assets FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_assets_insert ON employee_assets FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_assets_update ON employee_assets FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
