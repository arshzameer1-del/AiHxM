-- Learning paths (an ordered set of courses assigned together), course exams (a pass mark gates completion) and the certificate that follows.
-- Everything is opt-in: a course with no exam completes exactly as before.
CREATE TABLE IF NOT EXISTS learning_paths (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title       text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES user_accounts(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, title)
);
CREATE TABLE IF NOT EXISTS learning_path_courses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  path_id    uuid NOT NULL REFERENCES learning_paths(id) ON DELETE CASCADE,
  course_id  uuid NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  position   integer NOT NULL CHECK (position >= 1),
  UNIQUE (path_id, course_id),
  UNIQUE (path_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE IF NOT EXISTS learning_path_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  path_id     uuid NOT NULL REFERENCES learning_paths(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  due_date    date,
  assigned_by uuid REFERENCES user_accounts(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (path_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_learning_path_assignments_employee ON learning_path_assignments (employee_id);

CREATE TABLE IF NOT EXISTS course_exams (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  course_id     uuid NOT NULL UNIQUE REFERENCES courses(id) ON DELETE CASCADE,
  title         text NOT NULL,
  pass_mark_pct integer NOT NULL CHECK (pass_mark_pct BETWEEN 1 AND 100),
  max_attempts  integer CHECK (max_attempts IS NULL OR max_attempts BETWEEN 1 AND 20),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS exam_questions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  exam_id       uuid NOT NULL REFERENCES course_exams(id) ON DELETE CASCADE,
  position      integer NOT NULL CHECK (position >= 1),
  prompt        text NOT NULL,
  options       jsonb NOT NULL,
  correct_index integer NOT NULL CHECK (correct_index >= 0),
  UNIQUE (exam_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE IF NOT EXISTS exam_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  exam_id       uuid NOT NULL REFERENCES course_exams(id) ON DELETE CASCADE,
  enrollment_id uuid NOT NULL REFERENCES course_enrollments(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  answers       jsonb NOT NULL,
  correct_count integer NOT NULL,
  question_count integer NOT NULL,
  score_pct     numeric(5,2) NOT NULL,
  passed        boolean NOT NULL,
  taken_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exam_attempts_enrollment ON exam_attempts (enrollment_id, taken_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON learning_paths, learning_path_courses, learning_path_assignments, course_exams, exam_questions, exam_attempts TO app_role;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['learning_paths', 'learning_path_courses', 'learning_path_assignments', 'course_exams', 'exam_questions', 'exam_attempts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())', t || '_all', t);
  END LOOP;
END $$;
