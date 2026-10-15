-- 0152 - Step 11A: recruitment depth (gap register TAL-01..TAL-04, TAL-xx recruitment items; ORG-01 already in 0138).
--
--  Candidates   : national id (encrypted + blind index), source, current employer, expected salary, notice period,
--                 consent and retention dates, link to persons, anonymisation marker, documents (resume etc.).
--  Settings     : recruitment_settings - retention months, whether consent is mandatory, offer validity days, offer
--                 letter template key. NOTHING is shipped: every figure is tenant-defined (NULL = not enforced).
--  Applications : source, rejection reason, append-only application_stage_history.
--  Interviews   : interviews, interview_interviewers, interview_feedback (scorecard) and pre_employment_checks.
--  Offers       : expiry, decline / rescind reasons, currency, components (compensation_components), approval workflow
--                 states (pending_approval / approval_rejected / expired), versioned offer_letters.
--  Events       : recruitment_events (career fair, campus drive, walk-in drive ...) and attendees.
--
-- ROLLBACK (additive): DROP TABLE IF EXISTS recruitment_event_attendees, recruitment_events, offer_letters,
--   offer_components, pre_employment_checks, interview_feedback, interview_interviewers, interviews,
--   application_stage_history, candidate_documents, recruitment_settings;
--   ALTER TABLE offers DROP COLUMN expires_at, DROP COLUMN decline_reason, DROP COLUMN rescind_reason,
--     DROP COLUMN currency_code, DROP COLUMN approved_at, DROP COLUMN notes (restore the original status check);
--   ALTER TABLE applications DROP COLUMN source, DROP COLUMN source_detail, DROP COLUMN rejection_reason,
--     DROP COLUMN rejected_at;
--   ALTER TABLE candidates DROP the columns added below; DROP FUNCTION app.stage_history_guard().

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- ---------------------------------------------------------------- settings
CREATE TABLE IF NOT EXISTS recruitment_settings (
  company_id                 uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  candidate_retention_months integer CHECK (candidate_retention_months IS NULL OR candidate_retention_months BETWEEN 1 AND 240),
  consent_required           boolean NOT NULL DEFAULT false,
  offer_validity_days        integer CHECK (offer_validity_days IS NULL OR offer_validity_days BETWEEN 1 AND 365),
  offer_letter_template_key  text,
  updated_by                 uuid REFERENCES user_accounts(id),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- candidates
ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS national_id_type    text NOT NULL DEFAULT 'cnic',
  ADD COLUMN IF NOT EXISTS national_id         text,
  ADD COLUMN IF NOT EXISTS national_id_bidx    text,
  ADD COLUMN IF NOT EXISTS source              text,
  ADD COLUMN IF NOT EXISTS source_detail       text,
  ADD COLUMN IF NOT EXISTS current_employer    text,
  ADD COLUMN IF NOT EXISTS current_designation text,
  ADD COLUMN IF NOT EXISTS expected_salary     numeric(14,2) CHECK (expected_salary IS NULL OR expected_salary >= 0),
  ADD COLUMN IF NOT EXISTS notice_period_days  integer CHECK (notice_period_days IS NULL OR notice_period_days >= 0),
  ADD COLUMN IF NOT EXISTS consent_given_at    timestamptz,
  ADD COLUMN IF NOT EXISTS consent_purpose     text,
  ADD COLUMN IF NOT EXISTS retention_until     date,
  ADD COLUMN IF NOT EXISTS person_id           uuid REFERENCES persons(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS anonymised_at       timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at          timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'candidates_source_check') THEN
    ALTER TABLE candidates ADD CONSTRAINT candidates_source_check CHECK (source IS NULL OR source IN
      ('referral', 'job_board', 'agency', 'walk_in', 'social_media', 'company_website', 'campus', 'internal', 'event', 'other'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_candidates_national_id_bidx ON candidates (company_id, national_id_bidx) WHERE national_id_bidx IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_candidates_email_lower ON candidates (company_id, lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_candidates_retention ON candidates (retention_until) WHERE retention_until IS NOT NULL AND anonymised_at IS NULL;

CREATE TABLE IF NOT EXISTS candidate_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  doc_type     text NOT NULL DEFAULT 'resume' CHECK (doc_type IN ('resume', 'cover_letter', 'identity', 'certificate', 'reference', 'other')),
  file_name    text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   bigint NOT NULL CHECK (size_bytes >= 0),
  storage_path text NOT NULL,
  uploaded_by  uuid REFERENCES user_accounts(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_candidate_documents_candidate ON candidate_documents (candidate_id);

-- ---------------------------------------------------------------- applications and stage history
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS source           text,
  ADD COLUMN IF NOT EXISTS source_detail    text,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS rejected_at      timestamptz;

CREATE TABLE IF NOT EXISTS application_stage_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_stage     text,
  to_stage       text NOT NULL,
  reason         text,
  changed_by     uuid REFERENCES user_accounts(id),
  changed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_application_stage_history_app ON application_stage_history (application_id, changed_at);

-- History rows are immutable. UPDATE is blocked by a trigger; there is deliberately no DELETE grant to app_role, while
-- FK cascades (removing an application / tenant) still work because they run as the table owner.
CREATE OR REPLACE FUNCTION app.stage_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'application_stage_history is append-only';
END $$;
DROP TRIGGER IF EXISTS trg_stage_history_no_update ON application_stage_history;
CREATE TRIGGER trg_stage_history_no_update BEFORE UPDATE ON application_stage_history
  FOR EACH ROW EXECUTE FUNCTION app.stage_history_guard();

-- Backfill one history row per existing application so the timeline is never empty.
INSERT INTO application_stage_history (company_id, application_id, from_stage, to_stage, reason, changed_at)
SELECT a.company_id, a.id, NULL, a.stage, 'backfill', a.created_at
  FROM applications a
 WHERE NOT EXISTS (SELECT 1 FROM application_stage_history h WHERE h.application_id = a.id);

-- ---------------------------------------------------------------- interviews
CREATE TABLE IF NOT EXISTS interviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  application_id  uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  round_no        integer NOT NULL DEFAULT 1 CHECK (round_no BETWEEN 1 AND 20),
  interview_type  text NOT NULL DEFAULT 'onsite' CHECK (interview_type IN ('phone', 'video', 'onsite', 'technical', 'hr', 'panel', 'other')),
  scheduled_start timestamptz NOT NULL,
  scheduled_end   timestamptz NOT NULL,
  location_text   text,
  meeting_link    text,
  status          text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
  cancel_reason   text,
  notes           text,
  organizer_user_account_id uuid REFERENCES user_accounts(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (scheduled_end > scheduled_start)
);
CREATE INDEX IF NOT EXISTS idx_interviews_application ON interviews (application_id, scheduled_start);
CREATE INDEX IF NOT EXISTS idx_interviews_window ON interviews (company_id, scheduled_start);

CREATE TABLE IF NOT EXISTS interview_interviewers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  UNIQUE (interview_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_interview_interviewers_employee ON interview_interviewers (employee_id);

CREATE TABLE IF NOT EXISTS interview_feedback (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  interview_id   uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  overall_rating integer NOT NULL CHECK (overall_rating BETWEEN 1 AND 5),
  recommendation text NOT NULL CHECK (recommendation IN ('strong_yes', 'yes', 'no', 'strong_no')),
  strengths      text,
  concerns       text,
  scorecard      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(scorecard) = 'array'),
  submitted_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (interview_id, employee_id)
);

-- ---------------------------------------------------------------- pre-employment checks
CREATE TABLE IF NOT EXISTS pre_employment_checks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  check_type     text NOT NULL CHECK (check_type IN ('reference', 'education', 'employment_history', 'identity', 'criminal_record', 'medical', 'other')),
  label          text,
  is_required    boolean NOT NULL DEFAULT true,
  status         text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'in_progress', 'passed', 'failed', 'waived')),
  result_note    text,
  performed_by   uuid REFERENCES user_accounts(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pre_employment_checks_app ON pre_employment_checks (application_id);

-- ---------------------------------------------------------------- offers
ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS expires_at     timestamptz,
  ADD COLUMN IF NOT EXISTS decline_reason text,
  ADD COLUMN IF NOT EXISTS rescind_reason text,
  ADD COLUMN IF NOT EXISTS currency_code  text NOT NULL DEFAULT 'PKR',
  ADD COLUMN IF NOT EXISTS approved_at    timestamptz,
  ADD COLUMN IF NOT EXISTS notes          text;

-- Widen the status check (name differs between installs, so look it up).
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'offers'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE offers DROP CONSTRAINT %I', c);
  END LOOP;
  ALTER TABLE offers ADD CONSTRAINT offers_status_check CHECK (status IN
    ('pending', 'pending_approval', 'approval_rejected', 'accepted', 'declined', 'rescinded', 'expired'));
END $$;

CREATE TABLE IF NOT EXISTS offer_components (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  offer_id     uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  component_id uuid NOT NULL REFERENCES compensation_components(id) ON DELETE RESTRICT,
  amount       numeric(14,2) NOT NULL CHECK (amount >= 0),
  UNIQUE (offer_id, component_id)
);

CREATE TABLE IF NOT EXISTS offer_letters (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  offer_id        uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  version_no      integer NOT NULL CHECK (version_no >= 1),
  template_key    text,
  template_source text NOT NULL DEFAULT 'built_in' CHECK (template_source IN ('built_in', 'custom')),
  content         text NOT NULL,
  content_hash    text NOT NULL,
  status          text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'superseded')),
  generated_by    uuid REFERENCES user_accounts(id),
  generated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (offer_id, version_no)
);

-- ---------------------------------------------------------------- recruitment events
CREATE TABLE IF NOT EXISTS recruitment_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title          text NOT NULL CHECK (length(btrim(title)) > 0),
  event_type     text NOT NULL DEFAULT 'other' CHECK (event_type IN ('career_fair', 'campus_drive', 'walk_in_drive', 'interview_day', 'info_session', 'job_posting', 'other')),
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz,
  location_id    uuid REFERENCES locations(id) ON DELETE SET NULL,
  location_text  text,
  requisition_id uuid REFERENCES job_requisitions(id) ON DELETE SET NULL,
  capacity       integer CHECK (capacity IS NULL OR capacity > 0),
  status         text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'completed', 'cancelled')),
  notes          text,
  created_by     uuid REFERENCES user_accounts(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);
CREATE INDEX IF NOT EXISTS idx_recruitment_events_start ON recruitment_events (company_id, starts_at);

CREATE TABLE IF NOT EXISTS recruitment_event_attendees (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  event_id     uuid NOT NULL REFERENCES recruitment_events(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  attended     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, candidate_id)
);

-- ---------------------------------------------------------------- RLS and grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['recruitment_settings', 'candidate_documents', 'application_stage_history', 'interviews',
    'interview_interviewers', 'interview_feedback', 'pre_employment_checks', 'offer_components', 'offer_letters',
    'recruitment_events', 'recruitment_event_attendees'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())',
      t || '_all', t);
    IF t = 'application_stage_history' THEN
      EXECUTE format('GRANT SELECT, INSERT ON %I TO app_role', t);
    ELSIF t = 'offer_letters' THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO app_role', t);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_role', t);
    END IF;
  END LOOP;
END $$;
