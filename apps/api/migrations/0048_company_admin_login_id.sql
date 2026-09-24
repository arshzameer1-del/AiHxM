-- Company (Super) Admins have no Employee Core record, so they've never
-- had anything to type into the tenant login page's identifier field
-- (employees.employee_number) — the field only ever matched an
-- auto-sequenced employee number, and a Company Admin's own login is
-- keyed by email (the shared /login page), a dead end once a tenant's
-- real front door is its own /:companySlug/login (see LoginPage.tsx).
--
-- login_id closes that gap: a Platform Admin-chosen identifier (e.g.
-- "LHM_Admin1"), set once when the admin's login is created
-- (CompaniesService.createAdminLogin), that the SAME identifier field on
-- /:companySlug/login also accepts (AuthService's lookup, generalized to
-- match either employees.employee_number or company_admins.login_id for
-- that company slug — see auth.service.ts).
--
-- Nullable and NOT required retroactively: existing admins created before
-- this feature keep working exactly as before (no login_id, no tenant-
-- path login for them, unaffected). Unique per company, case-insensitive,
-- same posture as 0047's email indexes and for the same reason — a login
-- identifier should never silently collide because of letter casing.
-- Partial (WHERE login_id IS NOT NULL) so any number of admins can go on
-- not having one.
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE company_admins ADD COLUMN login_id text;

CREATE UNIQUE INDEX company_admins_company_id_login_id_ci_key
  ON company_admins (company_id, lower(trim(login_id)))
  WHERE login_id IS NOT NULL;
