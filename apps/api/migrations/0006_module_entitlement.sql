-- Phase 5 — Module Provisioning & Licensing
--
-- Plan doc Section 4's enforcement order starts with "is the module even
-- licensed" — a gate that comes BEFORE Phase 4's can()/resolveFieldAccess(),
-- not instead of it. Until now that first gate didn't exist at all:
-- company_config.enabled_modules (migration 0001) was explicitly seeded as
-- "a cached read view only... written directly by the Platform Admin panel
-- until [Phase 5] exists." This migration builds the real source of truth
-- it was always meant to read from.
--
-- Three tables, matching the plan doc's own naming (Section 7's Phase 5
-- row) exactly:
--   - module_catalog          — every module BoostFactor can license out.
--   - package_tier            — the four sellable tiers (previously just a
--                                CHECK-constrained string on `companies`;
--                                promoted to a real catalog table here so
--                                package_tier_modules has something to
--                                reference, and companies.package_tier now
--                                foreign-keys into it instead).
--   - package_tier_modules    — which modules a tier includes BY DEFAULT.
--                                Consulted only once, at company-creation
--                                time, to seed that company's own
--                                entitlement rows — it is a template, never
--                                read per-request.
--   - tenant_module_entitlement — the ACTUAL source of truth
--                                `EntitlementsService.isModuleEnabled()`
--                                (apps/api/src/entitlements) checks on
--                                every request. A Platform Admin can
--                                override it per tenant at any time
--                                (upgrade one company's Growth plan with an
--                                extra module without moving their whole
--                                tier, or the reverse) — the tier is a
--                                starting point, not a ceiling or a floor.
--
-- `module_catalog` includes a 'dummy' entry alongside the nine real
-- modules from the prototype (packages/shared-types MODULE_KEYS). Same
-- reasoning as Phase 4's `dummy_records` table: Employee Core (the first
-- real module) doesn't exist until Phase 7, so this phase needs something
-- concrete to gate in order to prove "disabled -> 404" against a running
-- API, and it reuses Phase 4's own dummy_records/rbac-demo endpoints as
-- that something rather than inventing a second scaffold. Scaffolding,
-- not a product feature — same as last time.

-- ---------------------------------------------------------------------
-- Catalog tables: what a tier includes, and what a module even is
-- ---------------------------------------------------------------------
-- Same shape as Phase 4's roles/permissions catalog: not tenant data,
-- readable by any real session, writable only by Platform Admin or our
-- own server code.

CREATE TABLE IF NOT EXISTS package_tier (
  key         text PRIMARY KEY,
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS module_catalog (
  key         text PRIMARY KEY,
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS package_tier_modules (
  package_tier text NOT NULL REFERENCES package_tier(key) ON DELETE CASCADE,
  module_key   text NOT NULL REFERENCES module_catalog(key) ON DELETE CASCADE,
  PRIMARY KEY (package_tier, module_key)
);

-- Promote companies.package_tier from a bare CHECK-constrained string to a
-- real foreign key into the catalog table above. The column, its name,
-- and every existing row's value are unchanged — this only replaces how
-- "is 'growth' a real tier" gets enforced.
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_package_tier_check;
INSERT INTO package_tier (key, name, description) VALUES
  ('starter', 'Starter', 'Core HR essentials for a small team just getting off spreadsheets.'),
  ('growth', 'Growth', 'Starter plus recruitment and performance management for a growing headcount.'),
  ('professional', 'Professional', 'Growth plus payroll and BI/analytics for a company running real payroll through BoostFactor.'),
  ('enterprise', 'Enterprise', 'Every module, including succession, learning, and exit/offboarding.')
ON CONFLICT (key) DO NOTHING;
ALTER TABLE companies
  ADD CONSTRAINT companies_package_tier_fkey FOREIGN KEY (package_tier) REFERENCES package_tier(key);

-- ---------------------------------------------------------------------
-- Tenant data: which modules a specific company actually has on
-- ---------------------------------------------------------------------
-- This IS tenant data, RLS'd like every other tenant table (Section 4's
-- "no exceptions" rule) — company_id-scoped exactly like
-- user_role_assignments in migration 0004.
CREATE TABLE IF NOT EXISTS tenant_module_entitlement (
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  module_key  text NOT NULL REFERENCES module_catalog(key) ON DELETE CASCADE,
  enabled     boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, module_key)
);
CREATE INDEX IF NOT EXISTS idx_tenant_module_entitlement_company
  ON tenant_module_entitlement (company_id);

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------

GRANT SELECT ON package_tier, module_catalog, package_tier_modules TO app_role;
GRANT INSERT, UPDATE, DELETE ON package_tier, module_catalog, package_tier_modules TO app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_module_entitlement TO app_role;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------

ALTER TABLE package_tier              ENABLE ROW LEVEL SECURITY;
ALTER TABLE package_tier              FORCE ROW LEVEL SECURITY;
ALTER TABLE module_catalog            ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_catalog            FORCE ROW LEVEL SECURITY;
ALTER TABLE package_tier_modules      ENABLE ROW LEVEL SECURITY;
ALTER TABLE package_tier_modules      FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_module_entitlement ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_module_entitlement FORCE ROW LEVEL SECURITY;

CREATE POLICY package_tier_select ON package_tier FOR SELECT
  USING (app.jwt() ? 'sub');
CREATE POLICY package_tier_write ON package_tier FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

CREATE POLICY module_catalog_select ON module_catalog FOR SELECT
  USING (app.jwt() ? 'sub');
CREATE POLICY module_catalog_write ON module_catalog FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

CREATE POLICY package_tier_modules_select ON package_tier_modules FOR SELECT
  USING (app.jwt() ? 'sub');
CREATE POLICY package_tier_modules_write ON package_tier_modules FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

-- tenant_module_entitlement: tenant data, same shape as
-- user_role_assignments — read is company-wide (any authenticated caller
-- in the tenant can see what's licensed; that's not sensitive HR data),
-- writes are Platform-Admin/service only. There is no "a tenant upgrades
-- itself" self-service flow — entitlement changes go through the Platform
-- Admin panel (Section 3: only Platform Admin manages "which modules each
-- tenant is entitled to").
CREATE POLICY tenant_module_entitlement_select ON tenant_module_entitlement FOR SELECT
  USING (
    app.is_platform_admin()
    OR app.is_service()
    OR company_id = app.current_company_id()
  );
CREATE POLICY tenant_module_entitlement_write ON tenant_module_entitlement FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

-- Same reasoning as migration 0004's identical line: FORCE ROW LEVEL
-- SECURITY applies to the migration/owner connection too, so seeding
-- catalog data needs the same is_service claims the app itself uses.
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- ---------------------------------------------------------------------
-- Seed: the module catalog and each tier's default module set
-- ---------------------------------------------------------------------

INSERT INTO module_catalog (key, name, description) VALUES
  ('employee', 'Employee Core', 'Org chart, employee master data, document vault, job history (Phase 7).'),
  ('leave', 'Leave & Attendance', 'Leave lifecycle, On-Behalf requests, biometric/GPS clock-in (Phase 9).'),
  ('recruitment', 'Recruitment & Onboarding', 'Requisition to hire, Kanban pipeline (Phase 10).'),
  ('performance', 'Performance & Goals', 'Review cycles, calibration (Phase 11).'),
  ('payroll', 'Compensation & Payroll', 'EOBI/PESSI/FBR tax calc, bank disbursement export (Phase 12).'),
  ('succession', 'Succession Planning', 'Succession planning (Phase 13).'),
  ('learning', 'Learning', 'Learning & development (Phase 13).'),
  ('exit', 'Exit & Offboarding', 'Exit and offboarding workflows (Phase 13).'),
  ('bi', 'BI & Analytics', 'Dashboards, standard and custom reports (Phase 14).'),
  -- Scaffolding — see this file's header comment. Not one of the nine
  -- real product modules; exists only so Phase 5's licensing gate has a
  -- real, running endpoint to prove itself against before Phase 7.
  ('dummy', 'RBAC Demo (internal)', 'Gates Phase 4''s rbac-demo/dummy-records endpoints. Not a real product module — proves the licensing gate against a running API before Employee Core exists.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO package_tier_modules (package_tier, module_key) VALUES
  ('starter', 'employee'),
  ('starter', 'leave'),
  ('starter', 'dummy'),

  ('growth', 'employee'),
  ('growth', 'leave'),
  ('growth', 'recruitment'),
  ('growth', 'performance'),
  ('growth', 'dummy'),

  ('professional', 'employee'),
  ('professional', 'leave'),
  ('professional', 'recruitment'),
  ('professional', 'performance'),
  ('professional', 'payroll'),
  ('professional', 'bi'),
  ('professional', 'dummy'),

  ('enterprise', 'employee'),
  ('enterprise', 'leave'),
  ('enterprise', 'recruitment'),
  ('enterprise', 'performance'),
  ('enterprise', 'payroll'),
  ('enterprise', 'succession'),
  ('enterprise', 'learning'),
  ('enterprise', 'exit'),
  ('enterprise', 'bi'),
  ('enterprise', 'dummy')
ON CONFLICT (package_tier, module_key) DO NOTHING;

-- Backfill: any company created before this migration existed gets its
-- tier's default module set as a starting point. A no-op on a fresh dev
-- database (no companies yet), but makes this migration safe to run
-- against a database that already has real tenants in it.
INSERT INTO tenant_module_entitlement (company_id, module_key, enabled)
SELECT c.id, ptm.module_key, true
FROM companies c
JOIN package_tier_modules ptm ON ptm.package_tier = c.package_tier
ON CONFLICT (company_id, module_key) DO NOTHING;
