-- Pulse surveys: HR asks a short set of questions, employees answer once, and nobody can see who said what.
--
-- Anonymity is built into the shape of the data, not only the screens:
--   * survey_participation records WHO has answered (so nobody answers twice) and the DATE, never the answers;
--   * survey_answers records the answers with no employee and no time at all, so the two tables cannot be joined;
--   * results are only shown once at least min_responses people have answered (never fewer than 5), and written
--     answers are shown in a shuffled order.
-- A survey is a draft until HR opens it, nothing is sent until then, and nothing is ever answered on anyone's behalf.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

CREATE TABLE IF NOT EXISTS surveys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title           text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description     text CHECK (description IS NULL OR length(description) <= 2000),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
  audience_type   text NOT NULL DEFAULT 'all' CHECK (audience_type IN ('all', 'org_unit', 'location')),
  audience_ids    uuid[] NOT NULL DEFAULT '{}',
  closes_on       date,
  min_responses   int NOT NULL DEFAULT 5 CHECK (min_responses >= 5),
  opened_at       timestamptz,
  closed_at       timestamptz,
  created_by      uuid REFERENCES user_accounts(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT surveys_audience_ids CHECK ((audience_type = 'all') = (cardinality(audience_ids) = 0))
);
CREATE INDEX IF NOT EXISTS idx_surveys_company ON surveys (company_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS survey_questions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id   uuid NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  position    int NOT NULL CHECK (position >= 1),
  kind        text NOT NULL CHECK (kind IN ('rating', 'nps', 'yes_no', 'text')),
  prompt      text NOT NULL CHECK (length(btrim(prompt)) BETWEEN 1 AND 500),
  required    boolean NOT NULL DEFAULT true,
  UNIQUE (survey_id, position)
);

-- who has answered (never what)
CREATE TABLE IF NOT EXISTS survey_participation (
  survey_id     uuid NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  submitted_on  date NOT NULL,
  PRIMARY KEY (survey_id, employee_id)
);

-- what was answered (never by whom, never when)
CREATE TABLE IF NOT EXISTS survey_answers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id    uuid NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  question_id  uuid NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  value_int    smallint,
  value_text   text CHECK (value_text IS NULL OR length(value_text) <= 2000),
  CONSTRAINT survey_answers_one_value CHECK ((value_int IS NOT NULL) <> (value_text IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_survey_answers_question ON survey_answers (question_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['surveys', 'survey_questions', 'survey_participation', 'survey_answers'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_role', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())', t || '_all', t);
  END LOOP;
END $$;

INSERT INTO permissions (key, description) VALUES
  ('survey.manage', 'Write, open and close pulse surveys and read their anonymous results.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key = 'survey.manage'
ON CONFLICT DO NOTHING;
