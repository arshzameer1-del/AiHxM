-- Organization Management, Phase 11 (Unified Integration & Synchronization
-- Requirements, Section 19 — "Data Scope Integration keyed on org
-- unit/location/cost center assignment"). The platform's existing Data
-- Scope engine (0004_rbac.sql) supports generic per-record `.self`/`.team`
-- scoping via RbacService.can()/resolveViewScope() — reused everywhere in
-- this initiative, satisfying Section 20's "no second permission
-- framework" instruction. What it does NOT support, and what this
-- migration adds, is scoping a caller's visible data to "their assigned
-- org units" / "their assigned locations" / "their assigned cost
-- centers" specifically — Section 19's own Regional HR ("sees only their
-- region's org units, positions, and assignments") and Regional Finance
-- ("sees only their own cost centers' positions") examples.
--
-- Deliberately one generic table rather than three near-identical ones
-- (`org_unit_scope_assignments`, `location_scope_assignments`, ...) —
-- `scope_type` plus a bare `scope_entity_id` keeps this exactly as
-- generic as the table's own name says, and it's one more table the
-- existing RBAC engine (apps/api/src/rbac/) reads, not a parallel
-- authorization system. No FK on `scope_entity_id` itself, since which
-- table it points into depends on `scope_type` (org_units / locations /
-- cost_centers) — a single column can't carry three different FK
-- targets, so the reference is validated in the API layer
-- (DataScopeAssignmentsService.assign(), apps/api/src/rbac/) the same way
-- this codebase already leaves other polymorphic references (e.g.
-- webhook event targets) to application-level validation.
--
-- Whether a role's `<object>.view.scoped` permission (0079's own seed)
-- means anything for a given assignment row is up to that object's own
-- service to interpret: OrgUnitsService/LocationsService expand an
-- `org_unit`/`location` row into that entity's full descendant subtree
-- (their own existing recursive-CTE `descendantRows()`), while
-- CostCentersService uses a `cost_center` row exactly as-is (Phase 4's
-- cost centers are a flat catalog, nothing to expand). This table only
-- ever stores the raw assignment; no hierarchy knowledge lives here.
--
-- Tenant data — RLS'd like every other tenant table (Section 4's "no
-- exceptions" rule). Read is company-wide, same as `user_role_assignments`
-- (a caller's own service code reads its OWN scope rows via the caller's
-- claims, not an admin-only lookup); writes are Platform-Admin/service
-- only for now, same deliberate deferral `user_role_assignments` already
-- documents (a Company Super Admin self-service version is a reasonable
-- future enhancement, not built speculatively here).

CREATE TABLE IF NOT EXISTS data_scope_assignments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id   uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  scope_type        text NOT NULL CHECK (scope_type IN ('org_unit', 'location', 'cost_center')),
  scope_entity_id   uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_account_id, company_id, scope_type, scope_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_data_scope_assignments_lookup
  ON data_scope_assignments (user_account_id, company_id, scope_type);

GRANT SELECT, INSERT, UPDATE, DELETE ON data_scope_assignments TO app_role;

ALTER TABLE data_scope_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_scope_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY data_scope_assignments_select ON data_scope_assignments FOR SELECT
  USING (
    app.is_platform_admin()
    OR app.is_service()
    OR company_id = app.current_company_id()
  );
CREATE POLICY data_scope_assignments_write ON data_scope_assignments FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());
