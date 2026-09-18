-- Phase 16-ish (Pilot/Launch) — Self-service company signup.
--
-- Every company onboarded before this migration was created BY a real
-- Platform Admin session (`companies_write`/`company_config_write`/
-- `company_admins_write` in 0001_platform_admin_core.sql all check
-- `app.is_platform_admin()` alone — these three tables predate
-- `app.is_service()`, which 0002_auth_identity.sql introduced specifically
-- for "trusted server-side code with no real user session yet," and every
-- table added from Phase 5 onward (`tenant_module_entitlement`,
-- `user_accounts`, `user_role_assignments`, ...) already accepts it. A
-- public "create your own company" endpoint is exactly that case for
-- these three tables too — there is no Platform Admin in the loop for a
-- self-signed-up tenant — so this migration closes that gap the same way
-- every later table already handles it, rather than inventing a new
-- pattern. UPDATE/DELETE on all three stay Platform-Admin-only,
-- unchanged: self-service signup only ever INSERTs a brand-new row for
-- the company it is itself creating, never modifies an existing one.
-- SELECT policies need the same fix as the write side, and for a
-- non-obvious reason beyond "the signup service reads these tables
-- too" (it does — a slug/email pre-check against `companies` before
-- ever inserting): Postgres re-checks a table's SELECT policy against
-- any row an INSERT ... RETURNING clause hands back, even though the
-- INSERT's own WITH CHECK already passed. `signup.service.ts` does
-- `INSERT INTO companies (...) ... RETURNING id` — without this,
-- that RETURNING itself throws the exact same RLS error the INSERT
-- was supposed to have already cleared, because is_service() alone
-- satisfies companies_write but companies_select never looked at it.
DROP POLICY IF EXISTS companies_select ON companies;
CREATE POLICY companies_select ON companies FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR id = app.current_company_id());

DROP POLICY IF EXISTS companies_write ON companies;
CREATE POLICY companies_write ON companies FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service());

DROP POLICY IF EXISTS company_config_select ON company_config;
CREATE POLICY company_config_select ON company_config FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

DROP POLICY IF EXISTS company_config_write ON company_config;
CREATE POLICY company_config_write ON company_config FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service());

DROP POLICY IF EXISTS company_admins_select ON company_admins;
CREATE POLICY company_admins_select ON company_admins FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

DROP POLICY IF EXISTS company_admins_write ON company_admins;
CREATE POLICY company_admins_write ON company_admins FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service());

-- audit_log_insert (0001) has the same "predates is_service()" shape:
-- `company_id = current_company_id()` alone, with no is_service()
-- branch — fine for every existing caller, which always already has a
-- real company_id in its own claims (a tenant session recording its own
-- action) or is a real Platform Admin. Signup's own audit entry is
-- neither: it's trusted server code recording an action for a company
-- it just created inside the SAME transaction that created it, so
-- is_service() is the right bypass here too, same as everywhere else
-- in this migration.
DROP POLICY IF EXISTS audit_log_insert ON audit_log;
CREATE POLICY audit_log_insert ON audit_log FOR INSERT
  WITH CHECK (
    app.is_platform_admin()
    OR app.is_service()
    OR company_id = app.current_company_id()
  );
