-- Announcements (company notice board) and SMS as a notification channel.
--
-- An announcement is written by HR, goes to everyone, one organisation unit or one location, and shows on every
-- employee's notice board. HR can ask for a read receipt ("I have read this") and can also send it by email, SMS or
-- WhatsApp. SMS and WhatsApp are only sent when a provider is configured (see messaging.service.ts); otherwise the
-- message is just logged in notification_log.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE notification_log DROP CONSTRAINT IF EXISTS notification_log_channel_check;
ALTER TABLE notification_log ADD CONSTRAINT notification_log_channel_check CHECK (channel IN ('email', 'sms', 'whatsapp', 'push', 'in_app'));

CREATE TABLE IF NOT EXISTS announcements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title                 text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  body                  text NOT NULL CHECK (length(btrim(body)) > 0 AND length(body) <= 10000),
  priority              text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'important', 'urgent')),
  audience_type         text NOT NULL DEFAULT 'all' CHECK (audience_type IN ('all', 'org_unit', 'location')),
  audience_ids          uuid[] NOT NULL DEFAULT '{}',
  pinned                boolean NOT NULL DEFAULT false,
  require_ack           boolean NOT NULL DEFAULT false,
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  expires_on            date,
  send_email            boolean NOT NULL DEFAULT false,
  send_sms              boolean NOT NULL DEFAULT false,
  send_whatsapp         boolean NOT NULL DEFAULT false,
  delivery_summary      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by            uuid REFERENCES user_accounts(id),
  published_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT announcements_audience_ids CHECK ((audience_type = 'all') = (cardinality(audience_ids) = 0))
);
CREATE INDEX IF NOT EXISTS idx_announcements_company ON announcements (company_id, status, published_at DESC);

CREATE TABLE IF NOT EXISTS announcement_receipts (
  announcement_id  uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  read_at          timestamptz,
  acknowledged_at  timestamptz,
  PRIMARY KEY (announcement_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_announcement_receipts_employee ON announcement_receipts (employee_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['announcements', 'announcement_receipts'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_role', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())', t || '_all', t);
  END LOOP;
END $$;

INSERT INTO permissions (key, description) VALUES
  ('announcement.manage', 'Write, publish and withdraw company announcements and see who has read them.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key = 'announcement.manage'
ON CONFLICT DO NOTHING;
