-- The Platform Admin console has always shown a hardcoded "AI HXM" mark
-- (Layout.tsx's sidebar, LoginPage.tsx's default login) with no way for
-- the actual platform owner to replace it with their own real logo file —
-- everything TM-015 built was per-TENANT branding, nothing for the
-- platform's own identity. Same shape as TM-015 (a storage path + mime
-- type, streamed through FileStorageService), just a singleton row
-- instead of one row per company, since there's exactly one platform.
--
-- The `id boolean PRIMARY KEY DEFAULT true CHECK (id)` trick is this
-- codebase's simplest way to enforce "at most one row, ever" without a
-- separate uniqueness constraint or a hand-rolled upsert-only convention —
-- CHECK (id) means the only value id can ever hold is `true`, and the
-- PRIMARY KEY makes a second row a straight uniqueness violation.
CREATE TABLE IF NOT EXISTS platform_branding (
  id               boolean PRIMARY KEY DEFAULT true CHECK (id),
  logo_storage_path text,
  logo_mime_type    text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON platform_branding TO app_role;

ALTER TABLE platform_branding ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_branding FORCE ROW LEVEL SECURITY;

-- SELECT has to clear for `is_service()` (never just Platform Admin) —
-- this is what makes the AIHXM mark showable on a completely public,
-- pre-auth page: the default /login page for anyone who hasn't signed in
-- yet, AND (per the "powered by AIHXM" credit) every tenant's own
-- leadhcm.aihxm.com/login. A real logo image is not sensitive data; this
-- is the same posture public-branding.service.ts already takes for
-- tenant branding, applied to the platform's own.
CREATE POLICY platform_branding_select ON platform_branding FOR SELECT
  USING (app.is_platform_admin() OR app.is_service());
CREATE POLICY platform_branding_write ON platform_branding FOR INSERT
  WITH CHECK (app.is_platform_admin());
CREATE POLICY platform_branding_update ON platform_branding FOR UPDATE
  USING (app.is_platform_admin()) WITH CHECK (app.is_platform_admin());
