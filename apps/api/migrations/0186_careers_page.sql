-- Public careers page: an approved requisition can be published for anyone to read and apply to, with a CV upload.
-- The company decides whether the page exists at all (recruitment_settings.careers_enabled, off by default).
-- Candidates are also e-mailed: a receipt when they apply, an invitation when an interview is booked, and
-- (when the company switches it on) a courteous no-thanks. Every e-mail is written to notification_log.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE job_requisitions
  ADD COLUMN IF NOT EXISTS publish_to_careers   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS public_description   text,
  ADD COLUMN IF NOT EXISTS public_location      text,
  ADD COLUMN IF NOT EXISTS employment_type      text CHECK (employment_type IS NULL OR employment_type IN ('full_time', 'part_time', 'contract', 'internship')),
  ADD COLUMN IF NOT EXISTS closes_on            date,
  ADD COLUMN IF NOT EXISTS careers_published_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_job_requisitions_careers ON job_requisitions (company_id) WHERE publish_to_careers;

ALTER TABLE recruitment_settings
  ADD COLUMN IF NOT EXISTS careers_enabled         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS careers_intro           text,
  ADD COLUMN IF NOT EXISTS send_application_receipt boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS send_interview_emails    boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS send_rejection_emails    boolean NOT NULL DEFAULT false;

ALTER TABLE applications ADD COLUMN IF NOT EXISTS cover_note text;
