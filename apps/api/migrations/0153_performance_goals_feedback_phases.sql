-- 0153 - Step 11B: performance depth (gap register TAL-05, TAL-06, TAL-07).
--
--  TAL-05  goals gain due date, target / current value, progress percentage, extended statuses (in progress, at risk,
--          overdue, cancelled) and an append-only goal_updates history. Weights per employee and cycle may never exceed
--          100 and must be exactly 100 (every open goal weighted) before the plan is finalised (goal_plans).
--  TAL-06  competencies (tenant catalogue), review_ratings at goal or competency level (self / manager / peer / upward /
--          skip-level / calibration), feedback (continuous and multi-rater 360 via feedback_requests), evidence links and
--          development_plans (+ items). Calibration data is never shown to the employee: the two field rules that let an
--          employee see calibrationRating / calibrationComment after release are removed (final rating stays visible),
--          and calibration-source ratings are filtered out of every employee-facing read.
--  TAL-07  review_cycle_phases: goal setting, self assessment, manager assessment, calibration and release windows with
--          deadlines; self / manager input outside an open window is refused for non-HR callers.
--  performance_settings holds the one tenant-defined figure this step needs (minimum raters before anonymous 360
--  results are shown). Nothing is shipped: NULL means "not enforced".
--
-- ROLLBACK (additive): DROP TABLE IF EXISTS performance_evidence, development_plan_items, development_plans, feedback,
--   feedback_requests, review_ratings, competencies, review_cycle_phases, goal_plans, goal_updates, performance_settings;
--   ALTER TABLE goals DROP COLUMN due_date, DROP COLUMN target_value, DROP COLUMN target_unit, DROP COLUMN current_value,
--   DROP COLUMN progress_pct, DROP COLUMN completed_at (and restore the original status check: active | completed);
--   re-insert the two employee_self_service field_permission_rules removed below; DROP FUNCTION app.goal_updates_guard();
--   DELETE FROM permissions WHERE key = 'performance_feedback.give'.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- ---------------------------------------------------------------- settings
CREATE TABLE IF NOT EXISTS performance_settings (
  company_id                uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  min_raters_for_anonymity  integer CHECK (min_raters_for_anonymity IS NULL OR min_raters_for_anonymity BETWEEN 2 AND 20),
  updated_by                uuid REFERENCES user_accounts(id),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- TAL-05 goals
ALTER TABLE goals
  ADD COLUMN IF NOT EXISTS due_date      date,
  ADD COLUMN IF NOT EXISTS target_value  numeric(14,2),
  ADD COLUMN IF NOT EXISTS target_unit   text,
  ADD COLUMN IF NOT EXISTS current_value numeric(14,2),
  ADD COLUMN IF NOT EXISTS progress_pct  numeric(5,2) NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS completed_at  timestamptz;

DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'goals'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE goals DROP CONSTRAINT %I', c);
  END LOOP;
  ALTER TABLE goals ADD CONSTRAINT goals_status_check CHECK (status IN
    ('active', 'in_progress', 'at_risk', 'overdue', 'completed', 'cancelled'));
END $$;
CREATE INDEX IF NOT EXISTS idx_goals_due ON goals (due_date) WHERE due_date IS NOT NULL AND status IN ('active', 'in_progress', 'at_risk');

-- Goals already marked completed keep their meaning: 100% progress.
UPDATE goals SET progress_pct = 100, completed_at = COALESCE(completed_at, updated_at) WHERE status = 'completed' AND progress_pct < 100;

CREATE TABLE IF NOT EXISTS goal_updates (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  goal_id                  uuid NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  update_type              text NOT NULL CHECK (update_type IN ('created', 'progress', 'status', 'due_date', 'weight', 'edit', 'note', 'system')),
  from_status              text,
  to_status                text,
  progress_pct             numeric(5,2),
  current_value            numeric(14,2),
  note                     text,
  changes                  jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(changes) = 'object'),
  author_user_account_id   uuid REFERENCES user_accounts(id),
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_goal_updates_goal ON goal_updates (goal_id, created_at);

CREATE OR REPLACE FUNCTION app.goal_updates_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'goal_updates is append-only';
END $$;
DROP TRIGGER IF EXISTS trg_goal_updates_no_update ON goal_updates;
CREATE TRIGGER trg_goal_updates_no_update BEFORE UPDATE ON goal_updates FOR EACH ROW EXECUTE FUNCTION app.goal_updates_guard();

-- One history row per existing goal so the timeline is never empty.
INSERT INTO goal_updates (company_id, goal_id, update_type, to_status, progress_pct, note, created_at)
SELECT g.company_id, g.id, 'created', g.status, g.progress_pct, 'backfill', g.created_at FROM goals g
 WHERE NOT EXISTS (SELECT 1 FROM goal_updates u WHERE u.goal_id = g.id);

CREATE TABLE IF NOT EXISTS goal_plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  review_cycle_id  uuid NOT NULL REFERENCES review_cycles(id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalised')),
  finalised_at     timestamptz,
  finalised_by     uuid REFERENCES user_accounts(id),
  reopened_reason  text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (review_cycle_id, employee_id)
);

-- ---------------------------------------------------------------- TAL-07 phases
CREATE TABLE IF NOT EXISTS review_cycle_phases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  review_cycle_id  uuid NOT NULL REFERENCES review_cycles(id) ON DELETE CASCADE,
  phase_key        text NOT NULL CHECK (phase_key IN ('goal_setting', 'self_assessment', 'manager_assessment', 'calibration', 'release')),
  starts_on        date NOT NULL,
  ends_on          date NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (review_cycle_id, phase_key),
  CHECK (ends_on >= starts_on)
);

-- ---------------------------------------------------------------- TAL-06 competencies, ratings, feedback, plans
CREATE TABLE IF NOT EXISTS competencies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code         text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name         text NOT NULL CHECK (length(btrim(name)) > 0),
  description  text,
  category     text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS review_ratings (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  review_id                uuid NOT NULL REFERENCES performance_reviews(id) ON DELETE CASCADE,
  source                   text NOT NULL CHECK (source IN ('self', 'manager', 'peer', 'upward', 'skip_level', 'calibration')),
  rater_user_account_id    uuid NOT NULL REFERENCES user_accounts(id),
  goal_id                  uuid REFERENCES goals(id) ON DELETE CASCADE,
  competency_id            uuid REFERENCES competencies(id) ON DELETE RESTRICT,
  rating                   integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment                  text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK ((goal_id IS NOT NULL) <> (competency_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_review_ratings_goal ON review_ratings (review_id, source, rater_user_account_id, goal_id) WHERE goal_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_review_ratings_competency ON review_ratings (review_id, source, rater_user_account_id, competency_id) WHERE competency_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_review_ratings_review ON review_ratings (review_id);

CREATE TABLE IF NOT EXISTS feedback_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  review_id           uuid NOT NULL REFERENCES performance_reviews(id) ON DELETE CASCADE,
  subject_employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  rater_employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  rater_type          text NOT NULL CHECK (rater_type IN ('peer', 'upward', 'skip_level', 'other')),
  status              text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'submitted', 'declined', 'cancelled')),
  is_anonymous        boolean NOT NULL DEFAULT true,
  due_date            date,
  requested_by        uuid REFERENCES user_accounts(id),
  requested_at        timestamptz NOT NULL DEFAULT now(),
  responded_at        timestamptz,
  CHECK (subject_employee_id <> rater_employee_id),
  UNIQUE (review_id, rater_employee_id)
);
CREATE INDEX IF NOT EXISTS idx_feedback_requests_rater ON feedback_requests (rater_employee_id, status);

CREATE TABLE IF NOT EXISTS feedback (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  subject_employee_id      uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  author_user_account_id   uuid NOT NULL REFERENCES user_accounts(id),
  author_employee_id       uuid REFERENCES employees(id) ON DELETE SET NULL,
  feedback_type            text NOT NULL CHECK (feedback_type IN ('continuous', 'recognition', 'peer', 'upward', 'skip_level')),
  review_id                uuid REFERENCES performance_reviews(id) ON DELETE CASCADE,
  request_id               uuid REFERENCES feedback_requests(id) ON DELETE SET NULL,
  goal_id                  uuid REFERENCES goals(id) ON DELETE SET NULL,
  competency_id            uuid REFERENCES competencies(id) ON DELETE SET NULL,
  body                     text NOT NULL CHECK (length(btrim(body)) > 0),
  rating                   integer CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  visibility               text NOT NULL DEFAULT 'subject' CHECK (visibility IN ('subject', 'manager_only', 'hr_only')),
  is_anonymous             boolean NOT NULL DEFAULT false,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_subject ON feedback (subject_employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_review ON feedback (review_id) WHERE review_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS performance_evidence (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  feedback_id       uuid REFERENCES feedback(id) ON DELETE CASCADE,
  review_rating_id  uuid REFERENCES review_ratings(id) ON DELETE CASCADE,
  goal_id           uuid REFERENCES goals(id) ON DELETE CASCADE,
  label             text NOT NULL CHECK (length(btrim(label)) > 0),
  url               text NOT NULL CHECK (url ~* '^https?://[^\s]+$'),
  created_by        uuid REFERENCES user_accounts(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (((feedback_id IS NOT NULL)::int + (review_rating_id IS NOT NULL)::int + (goal_id IS NOT NULL)::int) = 1)
);
CREATE INDEX IF NOT EXISTS idx_performance_evidence_feedback ON performance_evidence (feedback_id) WHERE feedback_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_performance_evidence_goal ON performance_evidence (goal_id) WHERE goal_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS development_plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  review_cycle_id  uuid REFERENCES review_cycles(id) ON DELETE SET NULL,
  review_id        uuid REFERENCES performance_reviews(id) ON DELETE SET NULL,
  title            text NOT NULL CHECK (length(btrim(title)) > 0),
  objective        text,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'completed', 'cancelled')),
  target_date      date,
  created_by       uuid REFERENCES user_accounts(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_development_plans_employee ON development_plans (employee_id);

CREATE TABLE IF NOT EXISTS development_plan_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  plan_id        uuid NOT NULL REFERENCES development_plans(id) ON DELETE CASCADE,
  competency_id  uuid REFERENCES competencies(id) ON DELETE SET NULL,
  course_id      uuid REFERENCES courses(id) ON DELETE SET NULL,
  item_type      text NOT NULL DEFAULT 'other' CHECK (item_type IN ('course', 'mentoring', 'coaching', 'project', 'stretch_assignment', 'reading', 'other')),
  action         text NOT NULL CHECK (length(btrim(action)) > 0),
  due_date       date,
  status         text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'done')),
  notes          text,
  completed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_development_plan_items_plan ON development_plan_items (plan_id);

-- ---------------------------------------------------------------- permission and field rules
INSERT INTO permissions (key, description) VALUES
  ('performance_feedback.give', 'Give feedback to colleagues and answer feedback requests addressed to you')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.key IN ('hr_admin', 'line_manager', 'employee_self_service') AND p.key = 'performance_feedback.give'
ON CONFLICT DO NOTHING;

-- TAL-06: calibration data stays hidden from employees, even after release (the final rating remains visible).
DELETE FROM field_permission_rules
 WHERE object_key = 'performance_review'
   AND field_key IN ('calibrationRating', 'calibrationComment')
   AND role_id IN (SELECT id FROM roles WHERE key = 'employee_self_service');

-- ---------------------------------------------------------------- RLS and grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['performance_settings', 'goal_updates', 'goal_plans', 'review_cycle_phases', 'competencies', 'review_ratings',
    'feedback_requests', 'feedback', 'performance_evidence', 'development_plans', 'development_plan_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())',
      t || '_all', t);
    IF t = 'goal_updates' THEN
      EXECUTE format('GRANT SELECT, INSERT ON %I TO app_role', t);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_role', t);
    END IF;
  END LOOP;
END $$;
