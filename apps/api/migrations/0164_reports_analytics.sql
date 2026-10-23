-- Reports & Analytics Intelligence Center, first release.
--
-- Adds (all additive):
--   * four permissions: reports.view (open the Reports & Analytics area), reports.view.sensitive (sensitive reports,
--     on top of the data permission each report names), reports.export (download a report as CSV) and
--     reports.export.sensitive (download a sensitive or restricted report, on top of reports.export);
--   * report_favorites and report_recent_views: per-user shortcuts;
--   * report_run_log: safe telemetry only (report id, timing, row count, status). It never stores filter values or rows.
--
-- The report catalog itself (the 220 stable ids) lives in code (apps/api/src/reports/catalog) so it is versioned with
-- the report definitions it describes. Exports and sensitive-report opens are written to the existing audit_log.
--
-- Role grants: hr_admin gets all four; line_manager gets reports.view only (team scope is decided per report from the
-- data permission, so a manager sees only reports built on employee.view.team / leave_request.view.team).
-- Employee Self Service gets nothing here (own-data reports come with the ESS reports slice).
--
-- ROLLBACK:
--   DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE key LIKE 'reports.%');
--   DELETE FROM permissions WHERE key LIKE 'reports.%';
--   DROP TABLE IF EXISTS report_run_log; DROP TABLE IF EXISTS report_recent_views; DROP TABLE IF EXISTS report_favorites;

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('reports.view',           'Open Reports & Analytics and run the reports your data permissions allow.'),
  ('reports.view.sensitive', 'Run reports classified as sensitive (in addition to the data permission each report names).'),
  ('reports.export',         'Download a report as CSV. Every export is written to the audit log.'),
  ('reports.export.sensitive', 'Download a sensitive or restricted report as CSV (needs reports.export as well).')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key IN ('reports.view', 'reports.view.sensitive', 'reports.export', 'reports.export.sensitive')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'line_manager' AND p.key = 'reports.view'
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS report_favorites (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_account_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  report_id text NOT NULL CHECK (report_id ~ '^[A-Z][0-9]{2}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_account_id, report_id)
);
CREATE INDEX IF NOT EXISTS idx_report_favorites_company ON report_favorites (company_id);

CREATE TABLE IF NOT EXISTS report_recent_views (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_account_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  report_id text NOT NULL CHECK (report_id ~ '^[A-Z][0-9]{2}$'),
  last_viewed_at timestamptz NOT NULL DEFAULT now(),
  view_count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (user_account_id, report_id)
);
CREATE INDEX IF NOT EXISTS idx_report_recent_views_company ON report_recent_views (company_id);
CREATE INDEX IF NOT EXISTS idx_report_recent_views_user_time ON report_recent_views (user_account_id, last_viewed_at DESC);

CREATE TABLE IF NOT EXISTS report_run_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_account_id uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  report_id text NOT NULL CHECK (report_id ~ '^[A-Z][0-9]{2}$'),
  report_version integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('run', 'export')),
  status text NOT NULL CHECK (status IN ('ok', 'denied', 'invalid', 'error')),
  duration_ms integer,
  row_count integer,
  error_category text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_report_run_log_company_time ON report_run_log (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_run_log_report ON report_run_log (company_id, report_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['report_favorites', 'report_recent_views', 'report_run_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR ALL
      USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
      WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())$p$, t || '_all', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_role', t);
  END LOOP;
END $$;
