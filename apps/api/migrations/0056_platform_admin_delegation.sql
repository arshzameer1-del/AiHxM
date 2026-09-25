-- Phase 2 gap-fill item #7 — Platform Admin delegation: scoped/read-only
-- admin roles. Every Platform Admin today has identical, unrestricted
-- access (PlatformAdminGuard checks only `is_platform_admin`); this adds
-- an additive `access_level` column so an ops/support admin can be given
-- narrower access without a second, parallel role system:
--   'full'      — today's behavior, unchanged (the default for every
--                 existing row, so nothing already granted narrows).
--   'read_only' — can view everything a full admin can, but every mutating
--                 request (anything but GET) is rejected by PlatformAdminGuard.
--   'scoped'    — restricted to an explicit list of tenants
--                 (platform_admin_company_scope) for both the Tenant
--                 Directory list and any company-scoped detail/action route.
--
-- "Regional" (the roadmap's original wording) is renamed to "scoped" here
-- deliberately — this schema has no real geographic region concept for a
-- single-country product, so scoping by an explicit tenant list is the
-- honest, useful version of the same idea (e.g. an admin who only handles
-- a specific set of client accounts) rather than inventing unused region
-- data just to match the original label.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE platform_admins
  ADD COLUMN IF NOT EXISTS access_level text NOT NULL DEFAULT 'full'
    CHECK (access_level IN ('full', 'read_only', 'scoped'));

CREATE TABLE IF NOT EXISTS platform_admin_company_scope (
  platform_admin_id  uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  PRIMARY KEY (platform_admin_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_platform_admin_company_scope_admin
  ON platform_admin_company_scope (platform_admin_id);

GRANT SELECT, INSERT, DELETE ON platform_admin_company_scope TO app_role;

ALTER TABLE platform_admin_company_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admin_company_scope FORCE ROW LEVEL SECURITY;

-- Same shape as every other platform-admin-owned table: only a platform
-- admin or the service role ever touches this; there is no tenant-side
-- concept of "my delegation scope" to expose to anyone else.
CREATE POLICY platform_admin_company_scope_all ON platform_admin_company_scope FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());
