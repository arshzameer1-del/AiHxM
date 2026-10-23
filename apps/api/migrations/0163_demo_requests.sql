-- Demo requests from the public marketing website (aihxm.com "Book a demo" form).
-- Platform-level data (no company_id): a prospect is not a tenant yet. Only the server (service claims, used by the
-- public form endpoint) and Platform Admins can touch it. The raw IP address is never stored — only a salted hash, which is
-- enough to spot repeated abuse without keeping personal data we do not need.
CREATE TABLE IF NOT EXISTS demo_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name        text NOT NULL,
  work_email       text NOT NULL,
  company_name     text NOT NULL,
  phone            text,
  job_title        text,
  employee_count   text CHECK (employee_count IN ('1-50', '51-200', '201-500', '501-1000', '1000+')),
  interests        text[] NOT NULL DEFAULT '{}',
  message          text,
  source_page      text,
  consent_privacy  boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'qualified', 'closed')),
  internal_notes   text,
  duplicate_count  integer NOT NULL DEFAULT 0,
  ip_hash          text,
  notified_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  last_submitted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_demo_requests_created ON demo_requests (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_demo_requests_email ON demo_requests (lower(work_email), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_demo_requests_ip ON demo_requests (ip_hash, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON demo_requests TO app_role;

ALTER TABLE demo_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS demo_requests_all ON demo_requests;
CREATE POLICY demo_requests_all ON demo_requests FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());
