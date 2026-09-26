-- Organization Management, Phase 4 — Locations & Cost/Profit Centers.
--
-- Source: claude/organization-management-4000-gap-analysis-and-roadmap.md
-- ("Phase 4 — Locations & Cost/Profit Centers" row) and the Master
-- Engineering Instruction doc's Section 14 (Location Management) +
-- Section 27's Phase 5 roadmap entry (this initiative's own roadmap doc
-- numbers this Phase 4; the master instruction's Section 27 numbers the
-- same work Phase 5 — both describe the identical scope, and this
-- migration follows this repo's own roadmap doc's numbering, consistent
-- with every earlier phase). Phase 1 built the Org Unit hierarchy; Phase 2
-- built Job + Position; Phase 3 built Employee Org Assignment + typed
-- Reporting Relationships (leaving a `location_id` placeholder column on
-- `employee_org_assignments`/`employee_org_assignment_versions` with NO FK,
-- since no `locations` table existed yet — see 0071's own header comment).
-- This phase adds that table, plus the two financial dimensions the
-- roadmap groups alongside it:
--
--   locations       — a canonical, unlimited-depth, self-referencing
--                      hierarchy (country -> region -> city -> site ->
--                      building), exactly `org_units`' own shape. Replaces
--                      the free-text `employees.location` (0012's Employee
--                      Groups condition value) as the canonical source of
--                      truth, the same relationship `org_units` already has
--                      to `employees.department`.
--   cost_centers /
--   profit_centers  — canonical, reusable FINANCIAL dimensions, each
--                      optionally linked to an org unit — exactly `jobs`'
--                      own shape (a flat, reusable catalog, no hierarchy).
--                      `positions.cost_center_id`/`profit_center_id` let a
--                      seat carry a financial-dimension assignment
--                      alongside its structural one (org unit) and its
--                      work-definition one (job).
--
-- STABLE-IDENTITY + VERSION-HISTORY SPLIT, replicated a fourth/fifth/sixth
-- time: exactly 0065's/0068's own design decision, for the same reason —
-- `locations.id` is a hierarchy edge target (children's `parent_id`) and
-- will be an FK target of `employees.location_id`/
-- `employee_org_assignments.location_id` below; `cost_centers.id`/
-- `profit_centers.id` become FK targets of `positions.cost_center_id`/
-- `profit_center_id`. None of the three can rotate `id` on a routine edit
-- (a rename, a reparent) without every referencing row silently pointing
-- at a now-dead id. So, exactly as with `org_units`/`jobs`:
--
--   `locations` / `cost_centers` /
--   `profit_centers`                — stable identity + current-state
--                                      cache, kept in sync by
--                                      LocationsService's/CostCentersService's/
--                                      ProfitCentersService's own
--                                      `applyVersionAndSync()` helpers.
--                                      Every reference and listing query
--                                      reads THESE tables.
--   `location_versions` /
--   `cost_center_versions` /
--   `profit_center_versions`         — the EffectiveDatingEngine-managed
--                                      history, same shape 0033/0065/0068/
--                                      0071 already established.
--
-- LOCATION_TYPE: a validated-but-OPEN CHECK set (country/region/city/site/
-- building), the same "validated but open, not a rigid hardcoded level
-- system" posture `org_units.unit_type`/`jobs.job_family` already
-- established — never a fixed number of hierarchy levels (Section 39's
-- explicit prohibition, already honored by `org_units`' own unlimited-depth
-- `parent_id` self-reference, replicated here for the same reason: a
-- single-site SMB might use `location_type = 'site'` for every row with no
-- parent at all, while a multi-country enterprise nests all five levels —
-- the schema doesn't decide that, the tenant's own data does).
--
-- CYCLE PREVENTION for `locations`: exactly `org_units`' own shape — a DB
-- CHECK rejects `parent_id = id` (belt), and `LocationsService.move()`'s
-- own recursive-descendant check (application layer, braces) rejects
-- moving a location under its own subtree.
--
-- FK BACKFILL — the constraint Phase 3's own migration explicitly deferred:
-- `employee_org_assignments.location_id`/`employee_org_assignment_versions.
-- location_id` were added as bare `uuid` columns with NO FK in
-- 0071_employee_org_assignments_and_relationships.sql, documented there as
-- "once a locations table exists, a follow-up migration adds REFERENCES
-- locations(id) to this already-present column — a pure constraint
-- addition, not a shape change." That follow-up happens here, now that
-- `locations` exists. No data migration is needed: existing rows'
-- `location_id` values are either NULL (the only possibility so far, since
-- nothing has ever written a non-null one) or valid, so the constraint
-- addition cannot fail.
--
-- EMPLOYEES.LOCATION_ID: additive, nullable, backward-compatible — exactly
-- `org_unit_id`'s own relationship to `department` in Phase 1.
-- `employees.location` (free text, added in 0012_employee_groups_leave_
-- policy.sql) is NOT dropped or renamed; EmployeesService now keeps it
-- synced from the linked location's current name whenever `location_id` is
-- set, via the same `resolveDepartment()`-shaped `resolveLocation()`
-- helper (see employees.service.ts). Employee Groups' `location` condition
-- is updated the same way `department`'s was in Phase 1 (see
-- employee-groups.service.ts's own updated header comment) — it now
-- matches the legacy free text OR the employee's `locationId` directly.
--
-- POSITIONS.COST_CENTER_ID / PROFIT_CENTER_ID: additive, nullable —
-- exactly `job_id`'s own relationship to `positions` in Phase 2. A position
-- can exist with neither, either, or both set; nothing about occupancy or
-- the existing lifecycle state machine (vacant/filled/frozen/abolished)
-- changes.
--
-- OUT OF SCOPE THIS PHASE (explicit, matching the roadmap doc's own Phase 4
-- description and this initiative's "add the canonical entity and its
-- direct links first, migrate every downstream consumer later" discipline
-- — Section 30's Add -> Migrate -> Synchronize -> Validate -> Deprecate ->
-- Remove order, applied here as Add+Migrate only): Payroll/Attendance/
-- Leave's own tax-slab/shift/leave-policy logic is NOT changed to resolve
-- location/cost-center from these new canonical tables instead of
-- Employee Groups' existing free-text conditions — Employee Groups itself
-- (the one existing consumer of `location`) is updated, matching exactly
-- how Phase 1 scoped `org_unit_id`'s rollout to Employee Groups alone
-- rather than touching every module that reads `department` on day one.
-- Deeper Payroll/Attendance integration is a documented future item, not
-- silently assumed done here.

-- ---------------------------------------------------------------------
-- locations — stable identity + current-state cache
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS locations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  parent_id      uuid REFERENCES locations(id) ON DELETE SET NULL,
  location_type  text NOT NULL CHECK (location_type IN ('country', 'region', 'city', 'site', 'building')),
  code           text,
  name           text NOT NULL,
  address        text,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- Belt: LocationsService.move() is the real cycle guard (a reparent into
  -- one's own descendant can't be a single-row CHECK) — this only catches
  -- the trivial "parent = self" case directly at the database, exactly
  -- org_units' own CHECK.
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX IF NOT EXISTS idx_locations_company ON locations (company_id);
CREATE INDEX IF NOT EXISTS idx_locations_parent ON locations (parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_company_code
  ON locations (company_id, code) WHERE code IS NOT NULL;

CREATE TABLE IF NOT EXISTS location_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id    uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  parent_id      uuid REFERENCES locations(id) ON DELETE SET NULL,
  location_type  text NOT NULL CHECK (location_type IN ('country', 'region', 'city', 'site', 'building')),
  code           text,
  name           text NOT NULL,
  address        text,
  status         text NOT NULL CHECK (status IN ('active', 'archived')),
  effective_from date NOT NULL,
  effective_to   date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (parent_id IS NULL OR parent_id <> location_id)
);
CREATE INDEX IF NOT EXISTS idx_location_versions_location ON location_versions (location_id, effective_from);
CREATE UNIQUE INDEX IF NOT EXISTS idx_location_versions_one_open
  ON location_versions (location_id) WHERE effective_to IS NULL;

-- ---------------------------------------------------------------------
-- cost_centers — stable identity + current-state cache (flat catalog,
-- exactly `jobs`' own shape)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cost_centers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code        text,
  name        text NOT NULL,
  org_unit_id uuid REFERENCES org_units(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cost_centers_company ON cost_centers (company_id);
CREATE INDEX IF NOT EXISTS idx_cost_centers_org_unit ON cost_centers (org_unit_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cost_centers_company_code
  ON cost_centers (company_id, code) WHERE code IS NOT NULL;

CREATE TABLE IF NOT EXISTS cost_center_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cost_center_id uuid NOT NULL REFERENCES cost_centers(id) ON DELETE CASCADE,
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code           text,
  name           text NOT NULL,
  org_unit_id    uuid REFERENCES org_units(id) ON DELETE SET NULL,
  status         text NOT NULL CHECK (status IN ('active', 'archived')),
  effective_from date NOT NULL,
  effective_to   date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS idx_cost_center_versions_cost_center ON cost_center_versions (cost_center_id, effective_from);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cost_center_versions_one_open
  ON cost_center_versions (cost_center_id) WHERE effective_to IS NULL;

-- ---------------------------------------------------------------------
-- profit_centers — stable identity + current-state cache (flat catalog,
-- structurally identical to cost_centers — a distinct table, not a
-- `type` discriminator column on one shared table, since Payroll/Finance
-- reporting treat the two as separate reference lists a tenant configures
-- independently, exactly how `cost_centers`/`profit_centers` are two
-- distinct entities in the Data Model Blueprint sheet, not one).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profit_centers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code        text,
  name        text NOT NULL,
  org_unit_id uuid REFERENCES org_units(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_profit_centers_company ON profit_centers (company_id);
CREATE INDEX IF NOT EXISTS idx_profit_centers_org_unit ON profit_centers (org_unit_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_profit_centers_company_code
  ON profit_centers (company_id, code) WHERE code IS NOT NULL;

CREATE TABLE IF NOT EXISTS profit_center_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profit_center_id uuid NOT NULL REFERENCES profit_centers(id) ON DELETE CASCADE,
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code             text,
  name             text NOT NULL,
  org_unit_id      uuid REFERENCES org_units(id) ON DELETE SET NULL,
  status           text NOT NULL CHECK (status IN ('active', 'archived')),
  effective_from   date NOT NULL,
  effective_to     date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS idx_profit_center_versions_profit_center ON profit_center_versions (profit_center_id, effective_from);
CREATE UNIQUE INDEX IF NOT EXISTS idx_profit_center_versions_one_open
  ON profit_center_versions (profit_center_id) WHERE effective_to IS NULL;

-- ---------------------------------------------------------------------
-- positions.cost_center_id / profit_center_id — additive, nullable.
-- ---------------------------------------------------------------------
ALTER TABLE positions ADD COLUMN IF NOT EXISTS cost_center_id uuid REFERENCES cost_centers(id) ON DELETE SET NULL;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS profit_center_id uuid REFERENCES profit_centers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_positions_cost_center ON positions (cost_center_id);
CREATE INDEX IF NOT EXISTS idx_positions_profit_center ON positions (profit_center_id);

ALTER TABLE position_versions ADD COLUMN IF NOT EXISTS cost_center_id uuid REFERENCES cost_centers(id) ON DELETE SET NULL;
ALTER TABLE position_versions ADD COLUMN IF NOT EXISTS profit_center_id uuid REFERENCES profit_centers(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- employees.location_id — additive, nullable, backward-compatible.
-- `employees.location` (free text) is untouched — see this migration's
-- header comment.
-- ---------------------------------------------------------------------
ALTER TABLE employees ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES locations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_employees_location ON employees (location_id);

-- ---------------------------------------------------------------------
-- FK backfill: employee_org_assignments/employee_org_assignment_versions.
-- location_id, left as a bare uuid with no FK in
-- 0071_employee_org_assignments_and_relationships.sql pending this table's
-- existence — see this migration's own header comment. A pure constraint
-- addition; no data migration needed (every existing value is NULL).
-- ---------------------------------------------------------------------
ALTER TABLE employee_org_assignments
  ADD CONSTRAINT employee_org_assignments_location_id_fkey
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL;
ALTER TABLE employee_org_assignment_versions
  ADD CONSTRAINT employee_org_assignment_versions_location_id_fkey
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON
  locations, location_versions, cost_centers, cost_center_versions,
  profit_centers, profit_center_versions
TO app_role;

-- ---------------------------------------------------------------------
-- Row Level Security — same tenant-isolation-backstop shape every prior
-- phase established. LocationsService's/CostCentersService's/
-- ProfitCentersService's own permission checks (seeded in
-- 0074_locations_financial_centers_seed.sql) are the real gate; RLS is
-- defense-in-depth underneath them.
-- ---------------------------------------------------------------------
ALTER TABLE locations                ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations                FORCE ROW LEVEL SECURITY;
ALTER TABLE location_versions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_versions        FORCE ROW LEVEL SECURITY;
ALTER TABLE cost_centers             ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_centers             FORCE ROW LEVEL SECURITY;
ALTER TABLE cost_center_versions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_center_versions     FORCE ROW LEVEL SECURITY;
ALTER TABLE profit_centers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE profit_centers           FORCE ROW LEVEL SECURITY;
ALTER TABLE profit_center_versions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE profit_center_versions   FORCE ROW LEVEL SECURITY;

CREATE POLICY locations_select ON locations FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY locations_insert ON locations FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY locations_update ON locations FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY location_versions_select ON location_versions FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY location_versions_insert ON location_versions FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY location_versions_update ON location_versions FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY cost_centers_select ON cost_centers FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY cost_centers_insert ON cost_centers FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY cost_centers_update ON cost_centers FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY cost_center_versions_select ON cost_center_versions FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY cost_center_versions_insert ON cost_center_versions FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY cost_center_versions_update ON cost_center_versions FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY profit_centers_select ON profit_centers FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY profit_centers_insert ON profit_centers FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY profit_centers_update ON profit_centers FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY profit_center_versions_select ON profit_center_versions FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY profit_center_versions_insert ON profit_center_versions FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY profit_center_versions_update ON profit_center_versions FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
