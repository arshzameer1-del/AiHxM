-- Smart checks: rule-based scans for risks and oddities in HR and payroll data (shared bank accounts, leavers who can still sign in,
-- salary outliers ...). The scan itself is read-only and keeps nothing; this table only remembers which findings a person has looked at
-- and judged to be fine, with their reason, so the same finding does not come back every day.
CREATE TABLE IF NOT EXISTS smart_check_dismissals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rule_key      text NOT NULL,
  subject_key   text NOT NULL,
  reason        text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  dismissed_by  uuid REFERENCES user_accounts(id),
  dismissed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, rule_key, subject_key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON smart_check_dismissals TO app_role;
ALTER TABLE smart_check_dismissals ENABLE ROW LEVEL SECURITY;
ALTER TABLE smart_check_dismissals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS smart_check_dismissals_all ON smart_check_dismissals;
CREATE POLICY smart_check_dismissals_all ON smart_check_dismissals FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);
INSERT INTO permissions (key, description) VALUES
  ('smart_checks.manage', 'Run the smart checks and mark findings as reviewed')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.key = 'hr_admin' AND p.key = 'smart_checks.manage'
ON CONFLICT DO NOTHING;
