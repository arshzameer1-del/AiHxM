-- 0173_account_security_notifications.sql
-- BACKLOG51: self-service account security and in-app notifications.
--   * user_accounts.mfa_pending_secret_encrypted - a new authenticator being set up while the current one keeps working,
--   * user_accounts.password_changed_at,
--   * user_notifications - the in-app inbox (bell): what HR decided, what is waiting for HR,
--   * user_notification_preferences - per person and per category: email on/off, in-app on/off (absent row = the default).

ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS mfa_pending_secret_encrypted text;
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;

CREATE TABLE IF NOT EXISTS user_notifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_account_id  uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  category         text NOT NULL,
  title            text NOT NULL,
  body             text,
  link             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  read_at          timestamptz
);
CREATE INDEX IF NOT EXISTS idx_user_notifications_user ON user_notifications (user_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_notifications_unread ON user_notifications (user_account_id) WHERE read_at IS NULL;

ALTER TABLE user_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_notifications_select ON user_notifications;
DROP POLICY IF EXISTS user_notifications_insert ON user_notifications;
DROP POLICY IF EXISTS user_notifications_update ON user_notifications;
-- a person sees and marks only their own; anything may be addressed to a colleague in the same company
CREATE POLICY user_notifications_select ON user_notifications FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR user_account_id::text = app.jwt()->>'sub');
CREATE POLICY user_notifications_insert ON user_notifications FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY user_notifications_update ON user_notifications FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR user_account_id::text = app.jwt()->>'sub')
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR user_account_id::text = app.jwt()->>'sub');
GRANT SELECT, INSERT, UPDATE ON user_notifications TO app_role;

CREATE TABLE IF NOT EXISTS user_notification_preferences (
  user_account_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  category        text NOT NULL,
  email           boolean NOT NULL DEFAULT true,
  in_app          boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_account_id, category)
);

ALTER TABLE user_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_notification_preferences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_notification_preferences_all ON user_notification_preferences;
CREATE POLICY user_notification_preferences_all ON user_notification_preferences FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR user_account_id::text = app.jwt()->>'sub')
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR user_account_id::text = app.jwt()->>'sub');
GRANT SELECT, INSERT, UPDATE ON user_notification_preferences TO app_role;
