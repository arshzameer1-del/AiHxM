-- Per-company login URLs (leadhcm.aihxm.com/login instead of one shared
-- /login for every tenant) need that page to show the tenant's OWN
-- branding (logo, colors, login background — TM-015) before anyone has a
-- session at all. That lookup ("company config for slug X") has to run
-- pre-auth, server-side-only — exactly the case `app.is_service()` exists
-- for (0002_auth_identity.sql's header comment, AuthService's
-- SERVICE_CLAIMS, signup.service.ts, seed.ts). Both `companies_select` and
-- `company_config_select` (0001_platform_admin_core.sql) simply never
-- needed to honor `is_service()` before, because nothing pre-auth ever
-- read them.
--
-- Only SELECT changes here, and only by adding the same trusted,
-- server-side-only `is_service()` escape hatch every other pre-auth read
-- in this codebase already relies on (never attacker-settable — see
-- tenant-context.ts). No write policy changes, and no new way for a real
-- tenant session or another tenant's Platform-Admin-less session to read
-- across companies.
DROP POLICY companies_select ON companies;
CREATE POLICY companies_select ON companies FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR id = app.current_company_id());

DROP POLICY company_config_select ON company_config;
CREATE POLICY company_config_select ON company_config FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
