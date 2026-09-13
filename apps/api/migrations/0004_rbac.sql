-- Phase 4 — RBAC + Field-Level Permission Engine
--
-- Plan doc Section 2's enforcement order: is the module even licensed
-- (Phase 5) -> can the role touch this object at all -> which fields can
-- they see -> does a sibling field's value hide this one. This migration
-- builds the schema for the middle two steps: `can()` (object/record-level)
-- and `resolveFieldAccess()` (field-level, including the conditional
-- "sibling field hides this one" case). The actual decision logic lives in
-- NestJS (apps/api/src/rbac/rbac.service.ts), not in SQL — consistent with
-- Decision #1's split: RLS below is the tenant-isolation backstop, this
-- schema is just the catalog/assignment data the API's own engine reads.
--
-- Important design point, easy to get backwards: Platform Admin does NOT
-- get an automatic bypass here. Section 3 is explicit that a Platform
-- Admin "never touches a tenant's HR data" — RBAC access to a tenant
-- object comes only from an actual role assignment in that tenant, same
-- as any other caller. A Platform Admin session has no `company_id`
-- claim, so it naturally can't match any `user_role_assignments` row
-- (comparing to NULL never succeeds in SQL) — this guardrail falls out of
-- the design rather than needing a special case, and rbac.service.ts
-- deliberately does not add one.
--
-- `dummy_records` exists only to prove the engine against a real object,
-- per this phase's own exit criterion wording ("a dummy record's test
-- field..."), since Employee Core (the first real object) doesn't exist
-- until Phase 7. It's clearly scaffolding, the same way Phase 2's mock
-- MRR figure was — not a product feature.

-- ---------------------------------------------------------------------
-- Catalog tables: roles, permissions, and what each role grants
-- ---------------------------------------------------------------------
-- Not tenant-scoped — these are architecture-level definitions we ship,
-- not tenant data (a future "tenant can define custom roles" capability
-- is a WRICEF Enhancements concern, not built here). Readable by anyone
-- with a real session (RLS still applies to app_role, it just isn't
-- gating on company_id for these three tables); only Platform Admin or
-- our own server code can write to them.

CREATE TABLE IF NOT EXISTS roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- Field-level grants per role. `condition` is opaque JSON the API
-- evaluates against the record (e.g. {"field":"status","equals":"unlocked"})
-- — a rule with a condition only applies when it matches; deliberately a
-- single equality check for this phase's proof-of-concept ("show
-- Termination Reason only when Status = Terminated" is the plan doc's own
-- example). A real multi-operator/AND-OR condition tree is WRICEF
-- Enhancements territory (Phase 6+), not needed to prove the engine works.
CREATE TABLE IF NOT EXISTS field_permission_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id     uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  object_key  text NOT NULL,
  field_key   text NOT NULL,
  access      text NOT NULL CHECK (access IN ('view', 'edit', 'hidden')),
  condition   jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_field_permission_rules_lookup
  ON field_permission_rules (role_id, object_key, field_key);

-- ---------------------------------------------------------------------
-- Assignment: which user has which role, in which company
-- ---------------------------------------------------------------------
-- This IS tenant data — company_id-scoped and RLS'd like every other
-- tenant table (Section 4's "no exceptions" rule). A user_account can
-- hold different roles in different companies (the same identity split
-- Phase 3 built: Employee, when it exists in Phase 7, links to
-- user_accounts too and gets role assignments the same way).
CREATE TABLE IF NOT EXISTS user_role_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_account_id, company_id, role_id)
);

-- ---------------------------------------------------------------------
-- Dummy test object — proves the engine, is not a product feature
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dummy_records (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  owner_user_account_id  uuid REFERENCES user_accounts(id),
  title                  text NOT NULL,
  status                 text NOT NULL DEFAULT 'locked' CHECK (status IN ('locked', 'unlocked')),
  test_field             text,
  secret_field           text,
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------

GRANT SELECT ON roles, permissions, role_permissions, field_permission_rules TO app_role;
GRANT INSERT, UPDATE, DELETE ON roles, permissions, role_permissions, field_permission_rules TO app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_role_assignments TO app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON dummy_records TO app_role;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------

ALTER TABLE roles                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles                   FORCE ROW LEVEL SECURITY;
ALTER TABLE permissions             ENABLE ROW LEVEL SECURITY;
ALTER TABLE permissions             FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions        FORCE ROW LEVEL SECURITY;
ALTER TABLE field_permission_rules  ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_permission_rules  FORCE ROW LEVEL SECURITY;
ALTER TABLE user_role_assignments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_role_assignments   FORCE ROW LEVEL SECURITY;
ALTER TABLE dummy_records           ENABLE ROW LEVEL SECURITY;
ALTER TABLE dummy_records           FORCE ROW LEVEL SECURITY;

-- Catalog tables: readable by any real session (a caller with `sub` set —
-- i.e. one that actually went through a guard, not an unauthenticated
-- context), writable only by Platform Admin or our own server code.
CREATE POLICY roles_select ON roles FOR SELECT
  USING (app.jwt() ? 'sub');
CREATE POLICY roles_write ON roles FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

CREATE POLICY permissions_select ON permissions FOR SELECT
  USING (app.jwt() ? 'sub');
CREATE POLICY permissions_write ON permissions FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

CREATE POLICY role_permissions_select ON role_permissions FOR SELECT
  USING (app.jwt() ? 'sub');
CREATE POLICY role_permissions_write ON role_permissions FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

CREATE POLICY field_permission_rules_select ON field_permission_rules FOR SELECT
  USING (app.jwt() ? 'sub');
CREATE POLICY field_permission_rules_write ON field_permission_rules FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

-- user_role_assignments: tenant data, scoped exactly like company_admins.
-- Read is company-wide (not just "your own row") — knowing who holds
-- which role in your own company is not in the same sensitivity class as
-- the HR data those roles gate, and a future "who has this role" screen
-- needs it. Writes are Platform-Admin/service only for now — a Company
-- Super Admin self-service "assign roles in my own company" screen is a
-- reasonable future enhancement, deliberately deferred rather than built
-- speculatively (plan doc Section 10's own guidance).
CREATE POLICY user_role_assignments_select ON user_role_assignments FOR SELECT
  USING (
    app.is_platform_admin()
    OR app.is_service()
    OR company_id = app.current_company_id()
  );
CREATE POLICY user_role_assignments_write ON user_role_assignments FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

-- dummy_records: tenant data, same shape as companies/company_config.
-- Note this is the RLS (tenant-isolation) layer only — a caller inside
-- the right tenant still has to clear rbac.service.ts's `can()` and
-- `resolveFieldAccess()` checks in the API layer to see the record at all
-- or any of its gated fields. Writes stay Platform-Admin/service only —
-- there is no real "create a dummy record" product feature, this is
-- fixture data for proving and testing the engine.
CREATE POLICY dummy_records_select ON dummy_records FOR SELECT
  USING (
    app.is_platform_admin()
    OR app.is_service()
    OR company_id = app.current_company_id()
  );
CREATE POLICY dummy_records_write ON dummy_records FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

-- The seed INSERTs below run through this same migration's connection —
-- the migration/owner role (DATABASE_URL), not app_role. FORCE ROW LEVEL
-- SECURITY (set above, deliberately, so these tables are never silently
-- exempt just because the owner role touches them) means even that
-- connection is subject to the policies just created, and with no claims
-- set they'd fail `is_platform_admin() OR is_service()`. Rather than
-- carve out an RLS exception for "the migration runner," this sets the
-- exact same `request.jwt.claims` session variable the app itself sets
-- per-request (tenant-context.ts) — the seed data goes in through the
-- identical `is_service` path AuthService and seed.ts use, not a
-- side-channel around RLS.
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- ---------------------------------------------------------------------
-- Seed catalog: three demo roles that between them exercise every part
-- of the engine (object-level self vs. all scope, field-level view vs.
-- hidden, and one conditional rule) — this is what the Phase 4 test
-- suite exercises. Not a "real" product catalog; Phase 7+ modules define
-- their own permissions/roles the same way, in their own migrations.
-- ---------------------------------------------------------------------

INSERT INTO permissions (key, description) VALUES
  ('dummy_record.view.self', 'View your own dummy_record (rbac.service.ts proof-of-concept object)'),
  ('dummy_record.view.all',  'View any dummy_record in your company');

INSERT INTO roles (key, name, description) VALUES
  ('rbac_demo_full_access', 'RBAC Demo — Full Access',
   'Proof-of-concept role: sees every dummy_record in the company, including test_field always and secret_field when the record is unlocked.'),
  ('rbac_demo_view_only', 'RBAC Demo — View Only',
   'Proof-of-concept role: sees every dummy_record in the company but none of its gated fields — demonstrates that object-level access does not imply field-level access.'),
  ('rbac_demo_self_service', 'RBAC Demo — Self Service',
   'Proof-of-concept role: sees only dummy_records it owns, and only test_field on them.');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'rbac_demo_full_access' AND p.key = 'dummy_record.view.all';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'rbac_demo_view_only' AND p.key = 'dummy_record.view.all';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'rbac_demo_self_service' AND p.key = 'dummy_record.view.self';

-- `field_key` is the API-facing field name (camelCase, matching the JSON
-- key that either appears or is omitted in a response — see
-- rbac.service.ts's filterRecordFields), not the database column name.
-- The engine never looks at column names; it only ever compares against
-- the keys of the already-mapped record object a service hands it.
--
-- full_access: testField always visible, secretField visible only when
-- the record's own status column is 'unlocked' (the sibling-field-hides-
-- this-one case).
INSERT INTO field_permission_rules (role_id, object_key, field_key, access, condition)
SELECT id, 'dummy_record', 'testField', 'view', NULL FROM roles WHERE key = 'rbac_demo_full_access';
INSERT INTO field_permission_rules (role_id, object_key, field_key, access, condition)
SELECT id, 'dummy_record', 'secretField', 'view', '{"field": "status", "equals": "unlocked"}'::jsonb
FROM roles WHERE key = 'rbac_demo_full_access';

-- view_only: deliberately no field_permission_rules rows at all — both
-- gated fields fall through to the engine's default deny ('hidden').

-- self_service: testField visible on records it owns (object-level
-- `view.self` already restricts which records it ever reaches).
INSERT INTO field_permission_rules (role_id, object_key, field_key, access, condition)
SELECT id, 'dummy_record', 'testField', 'view', NULL FROM roles WHERE key = 'rbac_demo_self_service';
