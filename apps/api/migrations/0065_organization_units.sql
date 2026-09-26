-- Organization Management, Phase 1 — Foundation: canonical Org Unit
-- hierarchy, replacing free-text `employees.department`.
--
-- Source: claude/organization-management-4000-gap-analysis-and-roadmap.md
-- ("Phase 1 — Foundation" row). That doc's own gap analysis confirmed
-- there is NO canonical organization master anywhere in this schema today
-- — `employees.department`/`designation` (0010_employee_core.sql) are bare
-- free-text columns, and Employee Groups (0012) match them as loose
-- string-equality conditions. This migration is the first real entity.
--
-- UNLIMITED DEPTH, NEVER HARD-CODED LEVELS: the instructions this
-- initiative is built from explicitly forbid a fixed
-- "Department -> Subdepartment -> Sub-subdepartment" column model. This is
-- one recursive, self-referencing table (`parent_id`) — depth is however
-- many `parent_id` hops a tenant actually creates, not a schema decision.
--
-- THE ONE REAL DESIGN DECISION THIS MIGRATION MAKES (not fully specified
-- by the phase brief, called out here rather than silently invented):
-- effective-dating an entity whose OWN identity must stay stable across
-- edits, when that identity is what other rows point to by FK
-- (`org_units.parent_id` self-references, and `employees.org_unit_id`
-- below). The existing Effective-Dating Engine's `applyVersionedRow`
-- closes an open row and INSERTs a brand new row (a new `id`) on every
-- supersession — exactly right for shift_assignments/leave_policy_versions/
-- tax_slabs, none of which are ever the FK TARGET of another table. An org
-- unit's `id` is a hierarchy edge target (its children's `parent_id`) and
-- an employee assignment target — if renaming or reparenting a unit
-- rotated its `id`, every child and every assigned employee would need to
-- be re-pointed at the new id on every single edit, and any row still
-- pointing at a now-closed historical id would silently look like it
-- belongs to a dead unit. So this migration replicates the EXACT split
-- 0033_effective_dating_leave_tax.sql already established for
-- `leave_policies` / `leave_policy_versions` (a stable identity row +one
-- open, `EffectiveDatingEngine`-versioned row per generation),
-- rather than inventing a new versioning scheme:
--
--   `org_units`         — the STABLE identity. Its `id` never changes for
--                          the life of the unit; `parent_id`/`unit_type`/
--                          `code`/`name`/`status` here are a denormalized
--                          CACHE of the current (effective_to IS NULL)
--                          version below, kept in sync by
--                          OrgUnitsService on every create/update/move —
--                          the same "fast current-state read, versioned
--                          table is the source of truth" shape
--                          `leave_policies.is_default`/`name` already are
--                          relative to `leave_policy_versions`. Every
--                          hierarchy query (recursive CTE) reads THIS
--                          table, never the versions table, exactly like
--                          every `shift_assignments`-resolution query
--                          reads current rows, not history, on the hot
--                          path.
--   `org_unit_versions` — the effective-dated history, scoped by
--                          `org_unit_id` (EffectiveDatingEngine's `scope`),
--                          with the same `effective_from`/`effective_to`
--                          + "one open row per scope" partial unique index
--                          0033 established. `parent_id` here references
--                          `org_units(id)` (the STABLE table) too, so a
--                          historical version's recorded parent is always
--                          a valid, permanent reference even after that
--                          parent itself has since been renamed.
--
-- CYCLE PREVENTION: `parent_id = id` is rejected at the database level
-- (CHECK, belt) as well as the application layer (OrgUnitsService, braces
-- — the real check, since a same-day *reparent into one's own descendant*
-- cannot be expressed as a single-row CHECK constraint and needs the
-- recursive descendant set). A full graph-cycle/orphan detection engine
-- (Rules-Engine-backed) is explicitly Phase 5 territory per the roadmap
-- doc; this phase only guards the two cases that would otherwise corrupt
-- every recursive hierarchy query: self-parenting and parenting a unit
-- under its own subtree.
--
-- `employees.org_unit_id` is a NEW, additive, nullable FK — Section 9's
-- "additive migrations, backward-compatible fields, controlled cutovers"
-- discipline. `employees.department` is NOT dropped or renamed: it stays
-- exactly as-is for any existing reader (Employee Groups' legacy
-- free-text condition matching, reports, CSV export/import), and
-- EmployeesService now keeps it synced from the linked org unit's current
-- name whenever `org_unit_id` is set — see employees.service.ts's
-- `syncDepartmentFromOrgUnit()`.

-- ---------------------------------------------------------------------
-- org_units — stable identity + current-state cache
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_units (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  parent_id   uuid REFERENCES org_units(id) ON DELETE SET NULL,
  unit_type   text NOT NULL CHECK (unit_type IN ('department', 'division', 'business_unit', 'function')),
  code        text,
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Belt: the application layer (OrgUnitsService) is the real guard,
  -- since a reparent into one's own DESCENDANT can't be expressed as a
  -- single-row CHECK — this only catches the trivial "parent = self" case
  -- directly at the database, the same "defense in depth, not instead of"
  -- posture RLS already has relative to RbacService.can().
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX IF NOT EXISTS idx_org_units_company ON org_units (company_id);
CREATE INDEX IF NOT EXISTS idx_org_units_parent ON org_units (parent_id);
-- A code is optional (many tenants will just use name-based hierarchy),
-- but when a tenant DOES set one, it should uniquely identify a unit
-- within the tenant, the same "human-facing business key" role
-- employee_number plays for employees (0010's own header comment).
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_units_company_code
  ON org_units (company_id, code) WHERE code IS NOT NULL;

-- ---------------------------------------------------------------------
-- org_unit_versions — effective-dated history, EffectiveDatingEngine-
-- managed, scope = { org_unit_id }. Exactly 0033's leave_policy_versions
-- shape, replicated for a second entity.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_unit_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_unit_id  uuid NOT NULL REFERENCES org_units(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  parent_id    uuid REFERENCES org_units(id) ON DELETE SET NULL,
  unit_type    text NOT NULL CHECK (unit_type IN ('department', 'division', 'business_unit', 'function')),
  code         text,
  name         text NOT NULL,
  status       text NOT NULL CHECK (status IN ('active', 'archived')),
  effective_from date NOT NULL,
  effective_to   date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (parent_id IS NULL OR parent_id <> org_unit_id)
);
CREATE INDEX IF NOT EXISTS idx_org_unit_versions_unit
  ON org_unit_versions (org_unit_id, effective_from);
-- The same "at most one open generation per scope" invariant every
-- EffectiveDatingEngine-managed table enforces at the database level, not
-- only in application code (0033/0034's own discipline).
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_unit_versions_one_open
  ON org_unit_versions (org_unit_id) WHERE effective_to IS NULL;

-- ---------------------------------------------------------------------
-- employees.org_unit_id — additive, nullable, backward-compatible.
-- `department` stays exactly as it is today (see this migration's header
-- comment) — nothing that already reads it breaks.
-- ---------------------------------------------------------------------
ALTER TABLE employees ADD COLUMN IF NOT EXISTS org_unit_id uuid REFERENCES org_units(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_employees_org_unit ON employees (org_unit_id);

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON org_units, org_unit_versions TO app_role;

-- ---------------------------------------------------------------------
-- Row Level Security — same tenant-isolation-backstop shape every real
-- tenant self-service object since Phase 7 uses (employees_select/insert/
-- update). OrgUnitsService's own org_unit.manage.all/org_unit.view.all
-- checks (seeded in 0066) are the real gate; RLS is defense-in-depth
-- behind them, not a replacement for them (Section 2's division of
-- labor).
-- ---------------------------------------------------------------------
ALTER TABLE org_units         ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_units         FORCE ROW LEVEL SECURITY;
ALTER TABLE org_unit_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_unit_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY org_units_select ON org_units FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY org_units_insert ON org_units FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY org_units_update ON org_units FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY org_unit_versions_select ON org_unit_versions FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY org_unit_versions_insert ON org_unit_versions FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY org_unit_versions_update ON org_unit_versions FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
