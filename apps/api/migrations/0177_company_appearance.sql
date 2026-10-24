-- BACKLOG55 - company-wide appearance settings a tenant System Admin controls:
--   * the background of the "My Workspace" banner on the home page (standard, a named preset, one colour, or an uploaded picture)
--   * whether a profile photo an employee uploads needs HR approval first (default: no, it shows at once; HR's own change is always immediate)
-- One row per company. Everyone in the company may READ it (the banner has to be drawn for everybody); only a holder of
-- company_appearance.manage may change it. System Admin holds it; any custom role can be given it. Idempotent.
--
-- ROLLBACK:
--   DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE key = 'company_appearance.manage');
--   DELETE FROM permissions WHERE key = 'company_appearance.manage';
--   DROP TABLE IF EXISTS company_appearance;

CREATE TABLE IF NOT EXISTS company_appearance (
  company_id                 uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  banner_mode                text NOT NULL DEFAULT 'default' CHECK (banner_mode IN ('default', 'preset', 'color', 'image')),
  banner_preset              text,
  banner_color               text CHECK (banner_color IS NULL OR banner_color ~ '^#[0-9a-fA-F]{6}$'),
  banner_image_path          text,
  banner_image_mime          text,
  photo_needs_hr_approval    boolean NOT NULL DEFAULT false,
  updated_by_user_account_id uuid REFERENCES user_accounts(id),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON company_appearance TO app_role;
ALTER TABLE company_appearance ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_appearance FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_appearance_all ON company_appearance;
CREATE POLICY company_appearance_all ON company_appearance FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('company_appearance.manage', 'Change how the company looks for everyone: the home banner background and the profile photo rule.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'system_admin' AND p.key = 'company_appearance.manage'
ON CONFLICT DO NOTHING;
