-- Reports & Analytics v2: saved and shared reports, the report builder, dashboards, schedules and export history.
--
-- Adds (all additive; nothing existing is changed):
--   * four permissions: reports.build (create reports with the builder), reports.share (share saved reports and
--     dashboards), reports.schedule (schedule delivery), reports.dashboard (create dashboards);
--   * saved_reports and report_shares: a catalog report with chosen filters, or a builder definition, kept by its owner
--     and optionally shared with named users or roles. A shared report is always RUN with the viewer's own access, never
--     the owner's, so sharing never widens what anyone can see;
--   * dashboards, dashboard_widgets (and report_shares rows for dashboards): widgets point at catalog or saved reports;
--   * report_schedules, report_deliveries: recurring delivery of a report to internal users. A delivery keeps the generated
--     file for 14 days so it can be downloaded in the app when email is not configured;
--   * report_export_history: who exported which report, in which format, how many rows. Never the rows themselves.
--
-- Role grants: hr_admin gets all four. line_manager gets reports.build, reports.schedule and reports.dashboard; every run is
-- still limited to their team by the report's own scope, and a manager cannot share.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS report_export_history, report_deliveries, report_schedules, dashboard_widgets, report_shares,
--     dashboards, saved_reports CASCADE;
--   DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE key IN
--     ('reports.build', 'reports.share', 'reports.schedule', 'reports.dashboard'));
--   DELETE FROM permissions WHERE key IN ('reports.build', 'reports.share', 'reports.schedule', 'reports.dashboard');

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('reports.build',     'Create reports with the Report Builder (still limited by your data permissions).'),
  ('reports.share',     'Share saved reports and dashboards with other people or roles.'),
  ('reports.schedule',  'Schedule a report to be delivered on a regular basis.'),
  ('reports.dashboard', 'Create dashboards from reports you can run.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key IN ('reports.build', 'reports.share', 'reports.schedule', 'reports.dashboard')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'line_manager' AND p.key IN ('reports.build', 'reports.schedule', 'reports.dashboard')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS saved_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  owner_user_account_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR char_length(description) <= 500),
  kind text NOT NULL CHECK (kind IN ('catalog', 'custom')),
  report_id text CHECK (report_id IS NULL OR report_id ~ '^[A-Z][0-9]{2}$'),
  definition jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(definition) = 'object'),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filters) = 'object'),
  compare boolean NOT NULL DEFAULT false,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CHECK ((kind = 'catalog' AND report_id IS NOT NULL) OR (kind = 'custom' AND report_id IS NULL AND definition ? 'dataset'))
);
CREATE INDEX IF NOT EXISTS idx_saved_reports_owner ON saved_reports (company_id, owner_user_account_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS dashboards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  owner_user_account_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR char_length(description) <= 500),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_dashboards_owner ON dashboards (company_id, owner_user_account_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  dashboard_id uuid NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  widget_type text NOT NULL CHECK (widget_type IN ('kpi', 'chart', 'table')),
  report_id text CHECK (report_id IS NULL OR report_id ~ '^[A-Z][0-9]{2}$'),
  saved_report_id uuid REFERENCES saved_reports(id) ON DELETE CASCADE,
  title text CHECK (title IS NULL OR char_length(title) <= 120),
  config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((report_id IS NOT NULL) <> (saved_report_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_dashboard_widgets_dashboard ON dashboard_widgets (dashboard_id, position);

CREATE TABLE IF NOT EXISTS report_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  saved_report_id uuid REFERENCES saved_reports(id) ON DELETE CASCADE,
  dashboard_id uuid REFERENCES dashboards(id) ON DELETE CASCADE,
  grantee_type text NOT NULL CHECK (grantee_type IN ('user', 'role')),
  grantee_user_account_id uuid REFERENCES user_accounts(id) ON DELETE CASCADE,
  grantee_role_key text,
  created_by uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((saved_report_id IS NOT NULL) <> (dashboard_id IS NOT NULL)),
  CHECK ((grantee_type = 'user' AND grantee_user_account_id IS NOT NULL AND grantee_role_key IS NULL)
      OR (grantee_type = 'role' AND grantee_role_key IS NOT NULL AND grantee_user_account_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_report_shares_report_user ON report_shares (saved_report_id, grantee_user_account_id) WHERE saved_report_id IS NOT NULL AND grantee_type = 'user';
CREATE UNIQUE INDEX IF NOT EXISTS uq_report_shares_report_role ON report_shares (saved_report_id, grantee_role_key) WHERE saved_report_id IS NOT NULL AND grantee_type = 'role';
CREATE UNIQUE INDEX IF NOT EXISTS uq_report_shares_dash_user ON report_shares (dashboard_id, grantee_user_account_id) WHERE dashboard_id IS NOT NULL AND grantee_type = 'user';
CREATE UNIQUE INDEX IF NOT EXISTS uq_report_shares_dash_role ON report_shares (dashboard_id, grantee_role_key) WHERE dashboard_id IS NOT NULL AND grantee_type = 'role';
CREATE INDEX IF NOT EXISTS idx_report_shares_user ON report_shares (company_id, grantee_user_account_id);

CREATE TABLE IF NOT EXISTS report_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  owner_user_account_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  saved_report_id uuid REFERENCES saved_reports(id) ON DELETE CASCADE,
  report_id text CHECK (report_id IS NULL OR report_id ~ '^[A-Z][0-9]{2}$'),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filters) = 'object'),
  frequency text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  day_of_week integer CHECK (day_of_week BETWEEN 0 AND 6),
  day_of_month integer CHECK (day_of_month BETWEEN 1 AND 28),
  hour_local integer NOT NULL DEFAULT 7 CHECK (hour_local BETWEEN 0 AND 23),
  format text NOT NULL DEFAULT 'xlsx' CHECK (format IN ('csv', 'xlsx', 'pdf')),
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(recipients) = 'array'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'failed')),
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_status text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((saved_report_id IS NOT NULL) <> (report_id IS NOT NULL)),
  CHECK ((frequency = 'weekly') = (day_of_week IS NOT NULL)),
  CHECK ((frequency = 'monthly') = (day_of_month IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_report_schedules_due ON report_schedules (next_run_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_report_schedules_owner ON report_schedules (company_id, owner_user_account_id);

CREATE TABLE IF NOT EXISTS report_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  schedule_id uuid NOT NULL REFERENCES report_schedules(id) ON DELETE CASCADE,
  run_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('sent', 'stored', 'failed', 'skipped')),
  row_count integer,
  recipient_count integer NOT NULL DEFAULT 0,
  skipped_recipients integer NOT NULL DEFAULT 0,
  error_category text,
  duration_ms integer,
  file_name text,
  file_mime text,
  file_bytes bytea,
  file_expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_report_deliveries_schedule ON report_deliveries (schedule_id, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_deliveries_expiry ON report_deliveries (file_expires_at) WHERE file_bytes IS NOT NULL;

CREATE TABLE IF NOT EXISTS report_export_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_account_id uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  report_id text NOT NULL CHECK (report_id ~ '^[A-Z][0-9]{2}$'),
  saved_report_id uuid REFERENCES saved_reports(id) ON DELETE SET NULL,
  title text,
  format text NOT NULL CHECK (format IN ('csv', 'xlsx', 'pdf')),
  row_count integer,
  partial boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_report_export_history_user ON report_export_history (company_id, user_account_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['saved_reports', 'dashboards', 'dashboard_widgets', 'report_shares', 'report_schedules', 'report_deliveries', 'report_export_history'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR ALL
      USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
      WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())$p$, t || '_all', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_role', t);
  END LOOP;
END $$;
