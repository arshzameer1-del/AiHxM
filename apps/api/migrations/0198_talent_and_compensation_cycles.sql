-- Talent: skills catalogue and gaps, nine-box placements, succession lists and talent pools; and compensation planning cycles.
--
-- Everything here is typed in or chosen by a person. Nothing is scored by a hidden formula, nobody is moved, promoted or paid
-- from these tables. The one place a figure reaches payroll is a compensation cycle that a person has approved and then
-- explicitly applied; it writes the same Basic Salary record HR would have written by hand.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

CREATE TABLE IF NOT EXISTS skills (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  category    text CHECK (category IS NULL OR length(btrim(category)) BETWEEN 1 AND 60),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_skills_name ON skills (company_id, lower(btrim(name)));

CREATE TABLE IF NOT EXISTS job_skill_requirements (
  job_id          uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  skill_id        uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  required_level  int NOT NULL CHECK (required_level BETWEEN 1 AND 5),
  PRIMARY KEY (job_id, skill_id)
);

CREATE TABLE IF NOT EXISTS employee_skills (
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  skill_id     uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  level        int NOT NULL CHECK (level BETWEEN 1 AND 5),
  source       text NOT NULL CHECK (source IN ('self', 'hr')),
  assessed_on  date NOT NULL,
  note         text CHECK (note IS NULL OR length(note) <= 300),
  PRIMARY KEY (employee_id, skill_id)
);

CREATE TABLE IF NOT EXISTS talent_assessments (
  employee_id       uuid PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  potential         text NOT NULL CHECK (potential IN ('low', 'medium', 'high')),
  performance_band  text CHECK (performance_band IS NULL OR performance_band IN ('low', 'medium', 'high')),
  note              text CHECK (note IS NULL OR length(note) <= 500),
  assessed_on       date NOT NULL,
  assessed_by       uuid REFERENCES user_accounts(id)
);

CREATE TABLE IF NOT EXISTS succession_candidates (
  position_id  uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  readiness    text NOT NULL CHECK (readiness IN ('ready_now', 'one_to_two_years', 'three_plus_years')),
  note         text CHECK (note IS NULL OR length(note) <= 300),
  added_by     uuid REFERENCES user_accounts(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (position_id, employee_id)
);

CREATE TABLE IF NOT EXISTS talent_pools (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description text CHECK (description IS NULL OR length(description) <= 300),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_talent_pools_name ON talent_pools (company_id, lower(btrim(name)));
CREATE TABLE IF NOT EXISTS talent_pool_members (
  pool_id      uuid NOT NULL REFERENCES talent_pools(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  PRIMARY KEY (pool_id, employee_id)
);

CREATE TABLE IF NOT EXISTS comp_cycles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name           text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  effective_from date NOT NULL,
  budget_amount  numeric(14,2) CHECK (budget_amount IS NULL OR budget_amount >= 0),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'applied', 'cancelled')),
  created_by     uuid REFERENCES user_accounts(id),
  submitted_by   uuid REFERENCES user_accounts(id),
  approved_by    uuid REFERENCES user_accounts(id),
  approved_at    timestamptz,
  applied_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS comp_cycle_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id       uuid NOT NULL REFERENCES comp_cycles(id) ON DELETE CASCADE,
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  current_basic  numeric(12,2) NOT NULL CHECK (current_basic >= 0),
  proposed_basic numeric(12,2) NOT NULL CHECK (proposed_basic >= 0),
  reason         text CHECK (reason IS NULL OR length(reason) <= 300),
  UNIQUE (cycle_id, employee_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['skills', 'job_skill_requirements', 'employee_skills', 'talent_assessments', 'succession_candidates', 'talent_pools', 'talent_pool_members', 'comp_cycles', 'comp_cycle_items'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_role', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())', t || '_all', t);
  END LOOP;
END $$;

INSERT INTO permissions (key, description) VALUES
  ('talent.manage', 'Keep the skills catalogue, rate skills, place people on the nine-box, and keep succession lists and talent pools.'),
  ('compensation_cycle.manage', 'Prepare a compensation planning cycle: load people, propose new basic salaries, submit for approval.'),
  ('compensation_cycle.approve', 'Approve a compensation planning cycle and apply it to payroll.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key IN ('talent.manage', 'compensation_cycle.manage', 'compensation_cycle.approve')
ON CONFLICT DO NOTHING;
