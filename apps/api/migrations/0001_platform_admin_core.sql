-- Phase 2 — Platform Provisioning Panel
--
-- Core platform tables (plan doc Section 4) plus their Row Level Security
-- policies (plan doc Section 2 — RLS as a second, database-level line of
-- defense, not a replacement for the API's own checks).
--
-- Portability note (plan doc Section 9): this migration only uses plain
-- Postgres features plus one session variable, `request.jwt.claims`. That
-- variable name is exactly what Supabase's PostgREST layer sets from a
-- request's JWT before running a query, so these same policies apply
-- unchanged whether this runs against local Postgres, self-hosted
-- Supabase, or Supabase Cloud. Nothing here depends on Supabase-specific
-- extensions or schemas.

-- ---------------------------------------------------------------------
-- Claims helpers
-- ---------------------------------------------------------------------
-- A tiny `app` schema (deliberately not `auth`, which Supabase owns) with
-- three helpers so policies below read as intent, not string-munging.
-- The NestJS API sets `request.jwt.claims` to a JSON object shaped like
-- {"is_platform_admin": true|false, "company_id": "<uuid>"|null, "sub": "<id>"}
-- once per transaction (see src/database/tenant-context.ts). Phase 3 swaps
-- the *source* of these claims for a real Supabase Auth JWT; the shape and
-- these helpers do not need to change.

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.jwt() RETURNS jsonb
  LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

CREATE OR REPLACE FUNCTION app.is_platform_admin() RETURNS boolean
  LANGUAGE sql STABLE
AS $$
  SELECT COALESCE((app.jwt() ->> 'is_platform_admin')::boolean, false)
$$;

CREATE OR REPLACE FUNCTION app.current_company_id() RETURNS uuid
  LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(app.jwt() ->> 'company_id', '')::uuid
$$;

-- ---------------------------------------------------------------------
-- Application role
-- ---------------------------------------------------------------------
-- The API connects as this role for every request-scoped query, never as
-- the migration/superuser role. RLS applies to it like any other login
-- role — nothing here is bypassed by table ownership.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_role') THEN
    CREATE ROLE app_role LOGIN PASSWORD 'app_role_dev_password';
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS companies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'trial'
                  CHECK (status IN ('trial', 'active', 'suspended', 'churned')),
  -- Real per-tenant module licensing is Phase 5 (module_catalog /
  -- package_tier / tenant_module_entitlement). package_tier here is a
  -- placeholder label only, not the source of truth for entitlements.
  package_tier  text NOT NULL DEFAULT 'starter'
                  CHECK (package_tier IN ('starter', 'growth', 'professional', 'enterprise')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS company_config (
  company_id              uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  branding                jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Cached read view only (plan doc Section 4) — becomes derived from
  -- tenant_module_entitlement once Phase 5 exists. Written directly by
  -- the Platform Admin panel until then.
  enabled_modules         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Employee Number design, plan doc Section 5 — tenant-configurable
  -- format, set once here, consumed by Employee Core in Phase 7.
  employee_number_format  jsonb NOT NULL DEFAULT jsonb_build_object(
                              'prefix', 'EMP',
                              'padding', 4,
                              'startingSequence', 1,
                              'preserveImportedNumbers', true
                            ),
  -- Placeholder for the WRICEF "Enhancements" custom-field engine,
  -- Phase 6. Stored here now so Company Config has one settings home;
  -- the real engine replaces this with proper tables.
  custom_fields           jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS company_admins (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  full_name   text NOT NULL,
  email       text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, email)
);

-- Internal ops team (plan doc Section 3). Phase 2 does not yet give each
-- platform admin their own login (see src/auth — one shared dev-only
-- bearer credential for now); this table exists so the schema and RLS
-- shape are correct, and Phase 3 wires real Supabase Auth identities into
-- it via a `user_id` column added then.
CREATE TABLE IF NOT EXISTS platform_admins (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   text NOT NULL,
  email       text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Append-only by design: no UPDATE or DELETE policy is defined below, so
-- app_role can INSERT and SELECT but can never alter or remove a row.
CREATE TABLE IF NOT EXISTS audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- null for platform-level actions that don't belong to one tenant yet
  -- (e.g. the company.created event itself).
  company_id  uuid REFERENCES companies(id) ON DELETE SET NULL,
  actor       text NOT NULL,
  action      text NOT NULL,
  target      text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_company_admins_company_id ON company_admins (company_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_company_id ON audit_log (company_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log (created_at DESC);

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------

GRANT USAGE ON SCHEMA app TO app_role;
GRANT USAGE ON SCHEMA public TO app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON companies, company_config, company_admins, platform_admins TO app_role;
GRANT SELECT, INSERT ON audit_log TO app_role;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
-- Enforcement order per plan doc Section 4 starts with "is the module
-- even licensed" and "can the role touch this object" — RLS here is the
-- object-level backstop underneath whatever the NestJS API's own checks
-- already decided. FORCE ROW LEVEL SECURITY is set even though app_role
-- isn't the table owner, so this stays true even if ownership ever
-- changes.

ALTER TABLE companies       ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies       FORCE ROW LEVEL SECURITY;
ALTER TABLE company_config  ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_config  FORCE ROW LEVEL SECURITY;
ALTER TABLE company_admins  ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_admins  FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admins FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log       FORCE ROW LEVEL SECURITY;

-- companies: platform admins see/manage every row; a future tenant-scoped
-- caller (Phase 3 company-admin logins) sees only their own company.
CREATE POLICY companies_select ON companies FOR SELECT
  USING (app.is_platform_admin() OR id = app.current_company_id());
CREATE POLICY companies_write ON companies FOR INSERT
  WITH CHECK (app.is_platform_admin());
CREATE POLICY companies_update ON companies FOR UPDATE
  USING (app.is_platform_admin()) WITH CHECK (app.is_platform_admin());
CREATE POLICY companies_delete ON companies FOR DELETE
  USING (app.is_platform_admin());

-- company_config: same shape as companies.
CREATE POLICY company_config_select ON company_config FOR SELECT
  USING (app.is_platform_admin() OR company_id = app.current_company_id());
CREATE POLICY company_config_write ON company_config FOR INSERT
  WITH CHECK (app.is_platform_admin());
CREATE POLICY company_config_update ON company_config FOR UPDATE
  USING (app.is_platform_admin()) WITH CHECK (app.is_platform_admin());

-- company_admins: same shape again. Phase 2 bootstraps a company's first
-- Super Admin(s) from the Platform Admin panel; self-service management
-- of *other* users by that Super Admin is Section 3's Company Super Admin
-- tier, wired once Phase 3 gives them a real login.
CREATE POLICY company_admins_select ON company_admins FOR SELECT
  USING (app.is_platform_admin() OR company_id = app.current_company_id());
CREATE POLICY company_admins_write ON company_admins FOR INSERT
  WITH CHECK (app.is_platform_admin());
CREATE POLICY company_admins_update ON company_admins FOR UPDATE
  USING (app.is_platform_admin()) WITH CHECK (app.is_platform_admin());

-- platform_admins: platform admins only. An ordinary tenant-scoped caller
-- gets zero rows, never an error — matches the "disabled module 404s, it
-- doesn't 403" instinct from Section 4: don't reveal this table exists.
CREATE POLICY platform_admins_select ON platform_admins FOR SELECT
  USING (app.is_platform_admin());
CREATE POLICY platform_admins_write ON platform_admins FOR INSERT
  WITH CHECK (app.is_platform_admin());

-- audit_log: platform admins read everything; a tenant-scoped caller
-- reads only its own company's entries. Writes must declare the same
-- company_id as the caller's own claim (or be a platform admin), so no
-- caller can forge an audit entry into another tenant's log. No UPDATE or
-- DELETE policy exists, so both are denied outright — the log is
-- append-only at the database level, not just by convention.
CREATE POLICY audit_log_select ON audit_log FOR SELECT
  USING (app.is_platform_admin() OR company_id = app.current_company_id());
CREATE POLICY audit_log_insert ON audit_log FOR INSERT
  WITH CHECK (
    app.is_platform_admin()
    OR company_id = app.current_company_id()
  );
