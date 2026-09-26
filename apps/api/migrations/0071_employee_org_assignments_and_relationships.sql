-- Organization Management, Phase 3 — Employee Organizational Assignment +
-- Reporting Relationships.
--
-- Source: the product owner's Master Engineering Instruction doc
-- (claude/organization-management-master-engineering-instruction.md),
-- Section 11 (Employee Organizational Assignment) + Section 12 (Reporting
-- Relationships) + Section 27/Phase 3-4 roadmap entries. Phase 1
-- (0065_organization_units.sql) built the Org Unit hierarchy; Phase 2
-- (0068_job_position_architecture.sql) built Job + Position. This phase
-- adds the two entities that make an employee's place in that structure a
-- CANONICAL, TYPED, effective-dated fact instead of an implicit one:
--
--   employee_org_assignments — the canonical assignment of an employee to
--                               an org unit / position (/ location, once
--                               Location exists), typed by
--                               `assignment_type` (primary / secondary /
--                               concurrent / temporary / acting /
--                               secondment). Replaces the implicit
--                               assumption that `employees.org_unit_id`/
--                               `employees.position_id` are the only
--                               assignment a person can ever have — an
--                               employee can now ALSO hold, say, a
--                               `secondment` assignment to a different org
--                               unit at the same time as their `primary`
--                               one.
--   org_relationships         — a TYPED reporting relationship
--                               (`relationship_type`: direct / dotted_line
--                               / matrix / temporary / acting) between two
--                               employees, replacing the untyped
--                               `employees.manager_id` self-reference
--                               (0010_employee_core.sql) as the canonical
--                               source of truth for "who reports to whom,
--                               and how."
--
-- STABLE-IDENTITY + VERSION-HISTORY SPLIT, replicated a third time: exactly
-- 0065's/0068's own design decision (see 0065's header comment for the
-- full reasoning). Neither `employee_org_assignments.id` nor
-- `org_relationships.id` is actually an FK TARGET of any other table
-- today (unlike org_units.id/jobs.id/positions.id) — but the split is kept
-- anyway, for a different but equally real reason: EACH ROW here is its
-- own long-lived "slot" (an employee's specific primary assignment, or a
-- specific reporting edge) that can be AMENDED in place over time (its
-- org unit/position changed, its manager reassigned) while remaining the
-- SAME slot with a full effective-dated audit trail — exactly the same
-- "this fact changes over time but stays the same fact" shape a Position's
-- retitle/reparent already has relative to `position_versions`. Using
-- EffectiveDatingEngine.applyVersionedRow's own row-rotation behavior
-- directly on a single table (no identity/version split) would make the
-- table's `id` unstable across every routine amendment, which the two
-- "one open row per slot" partial unique indexes below (guarding
-- exactly-one-open-`primary`-assignment-per-employee and exactly-one-open-
-- `direct`-relationship-per-employee) would then have to be redefined
-- around a moving target. Splitting stable identity from version history
-- avoids that regardless of whether anything references the id by FK yet.
--
--   `employee_org_assignments` /
--   `org_relationships`            — stable identity + current-state
--                                     cache, kept in sync by
--                                     EmployeeOrgAssignmentsService's/
--                                     OrgRelationshipsService's own
--                                     `applyVersionAndSync()` helpers.
--                                     Every listing/filter query reads
--                                     THESE tables.
--   `employee_org_assignment_versions` /
--   `org_relationship_versions`    — the EffectiveDatingEngine-managed
--                                     history, scope = {
--                                     employee_org_assignment_id } / {
--                                     org_relationship_id }, same shape
--                                     0033/0065/0068 already established.
--
-- ONE-OPEN-ROW DISCIPLINE, applied at the SLOT level (not the version
-- level, which already has its own "one open version per slot" index —
-- see below): the master instruction is explicit that "each employee
-- should have exactly one open primary assignment at a time" and "at most
-- one open direct relationship at a time," while allowing MULTIPLE
-- concurrently-open secondary/concurrent/temporary/acting/secondment
-- assignments and dotted_line/matrix/temporary/acting relationships. This
-- is why assignment_type/relationship_type is NOT part of either
-- versioned table's `scope` (which would make "one open row per {employee,
-- type}" the invariant, wrongly allowing two simultaneous `secondary`
-- assignments to different units but wrongly forbidding, say, a
-- `secondary` AND a `concurrent` assignment coexisting under a single
-- shared per-type slot). Instead, each assignment/relationship is its own
-- independently-created SLOT (its own `employee_org_assignments`/
-- `org_relationships` row + id), and the "at most one *primary*/*direct*
-- slot open at a time" rule is enforced by a partial unique index on the
-- STABLE table, scoped only by `employee_id` and filtered to
-- `assignment_type = 'primary' AND status = 'active'` (respectively
-- `relationship_type = 'direct' AND status = 'active'`) — completely
-- independent of the version table's own "one open version per slot"
-- index, which continues to guard normal effective-dating for every slot
-- regardless of type.
--
-- LOCATION: per the master instruction's Section 14 (Location Management)
-- and Section 27's Phase 5 roadmap entry, Location is not yet a canonical
-- entity — no `locations` table exists. Per this phase's own brief
-- ("leave the column nullable with no FK yet, or omit it entirely and let
-- Phase 4 add it additively; your call, document whichever you pick"):
-- THIS MIGRATION ADDS `location_id uuid` (nullable, NO FK constraint) to
-- both the stable and version tables now, rather than omitting it and
-- making the eventual Location phase run its own ALTER TABLE. Once a
-- `locations` table exists, a follow-up migration adds
-- `REFERENCES locations(id)` to this already-present column — a pure
-- constraint addition, not a shape change, so no data migration or app
-- code changes are needed to backfill the column itself when that day
-- comes.
--
-- MANAGER_ID SYNC (Section 12/Backward Compatibility): `employees.manager_id`
-- (0010_employee_core.sql, untyped, non-effective-dated) MUST keep working
-- for every existing caller — this migration does not touch its column
-- definition at all. OrgRelationshipsService is the ONLY new writer of
-- `employees.manager_id`, and it writes via plain SQL reaching across the
-- table boundary — EXACTLY PositionsService's own precedent for
-- `employees.position_id` (see positions.service.ts's class doc comment:
-- "the same reach across a table boundary via plain SQL rather than
-- injecting the other domain's service"). No new cross-module DI is
-- introduced in either direction: OrgRelationshipsService gets no
-- EmployeesService dependency, and EmployeesModule gets no
-- OrgRelationshipsService dependency. This is a ONE-DIRECTIONAL,
-- POINT-IN-TIME sync (write-only, not a live view) — see
-- org-relationships.service.ts's own header comment for the full
-- reasoning, including the one documented, deliberate gap this leaves:
-- EmployeesService.create()/update() ALSO write `manager_id` directly from
-- their own `managerId` input field (unchanged, pre-existing behavior that
-- must keep working per this phase's backward-compatibility mandate) —
-- THAT path does not create/update a corresponding `org_relationships`
-- row. A manager set only through EmployeesService's own legacy field
-- never gets a typed `org_relationships` record; only a manager set
-- through OrgRelationshipsService gets the sync AND the typed record.
--
-- CYCLE PREVENTION (Section 12/Phase brief's item #3): exactly 0065's own
-- shape for `org_units`, replicated for `org_relationships` — `employee_id
-- <> manager_employee_id` is a DB CHECK (belt) on both the stable and
-- version tables, and OrgRelationshipsService's own recursive-CTE
-- ascending-manager-chain walk (braces — the real guard, since a same-day
-- *reassignment that would close a longer A -> B -> C -> A loop* cannot be
-- expressed as a single-row CHECK) runs before every `direct`-relationship
-- create/update. See org-relationships.service.ts's own doc comment.

-- ---------------------------------------------------------------------
-- employee_org_assignments — stable identity + current-state cache
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_org_assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  assignment_type  text NOT NULL CHECK (assignment_type IN (
                     'primary', 'secondary', 'concurrent', 'temporary', 'acting', 'secondment'
                   )),
  org_unit_id      uuid NOT NULL REFERENCES org_units(id) ON DELETE RESTRICT,
  position_id      uuid REFERENCES positions(id) ON DELETE SET NULL,
  -- Phase 5 (Location) placeholder — see this migration's header comment.
  -- No FK yet: no `locations` table exists.
  location_id      uuid,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_org_assignments_company ON employee_org_assignments (company_id);
CREATE INDEX IF NOT EXISTS idx_employee_org_assignments_employee ON employee_org_assignments (employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_org_assignments_org_unit ON employee_org_assignments (org_unit_id);
CREATE INDEX IF NOT EXISTS idx_employee_org_assignments_position ON employee_org_assignments (position_id);
-- At most one OPEN `primary` assignment per employee — the master
-- instruction's explicit invariant. Non-primary types are deliberately NOT
-- covered by this index (or any equivalent one) — an employee may hold any
-- number of concurrently-open secondary/concurrent/temporary/acting/
-- secondment assignments, each its own independent slot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_org_assignments_one_open_primary
  ON employee_org_assignments (employee_id) WHERE assignment_type = 'primary' AND status = 'active';

-- ---------------------------------------------------------------------
-- employee_org_assignment_versions — effective-dated history, scope =
-- { employee_org_assignment_id }
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_org_assignment_versions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_org_assignment_id  uuid NOT NULL REFERENCES employee_org_assignments(id) ON DELETE CASCADE,
  company_id                  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- Denormalized alongside the scope column — every other *_versions table
  -- in this schema carries its scope's own identity plus enough context to
  -- be queried standalone; here that means `employee_id` is readable
  -- directly off a version row without a join back to the stable table.
  employee_id                 uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  assignment_type             text NOT NULL CHECK (assignment_type IN (
                                'primary', 'secondary', 'concurrent', 'temporary', 'acting', 'secondment'
                              )),
  org_unit_id                 uuid NOT NULL REFERENCES org_units(id) ON DELETE RESTRICT,
  position_id                 uuid REFERENCES positions(id) ON DELETE SET NULL,
  location_id                 uuid,
  status                      text NOT NULL CHECK (status IN ('active', 'ended')),
  effective_from              date NOT NULL,
  effective_to                date,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS idx_employee_org_assignment_versions_assignment
  ON employee_org_assignment_versions (employee_org_assignment_id, effective_from);
CREATE INDEX IF NOT EXISTS idx_employee_org_assignment_versions_employee
  ON employee_org_assignment_versions (employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_org_assignment_versions_one_open
  ON employee_org_assignment_versions (employee_org_assignment_id) WHERE effective_to IS NULL;

-- ---------------------------------------------------------------------
-- org_relationships — stable identity + current-state cache
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_relationships (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- The report.
  employee_id           uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  -- The manager (or dotted-line/matrix/temporary/acting counterpart).
  manager_employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  relationship_type     text NOT NULL CHECK (relationship_type IN (
                          'direct', 'dotted_line', 'matrix', 'temporary', 'acting'
                        )),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- Belt: an employee cannot be their own manager. The real cycle guard
  -- (a longer A -> B -> C -> A loop) is application-level — see this
  -- migration's header comment and org-relationships.service.ts.
  CHECK (employee_id <> manager_employee_id)
);
CREATE INDEX IF NOT EXISTS idx_org_relationships_company ON org_relationships (company_id);
CREATE INDEX IF NOT EXISTS idx_org_relationships_employee ON org_relationships (employee_id);
CREATE INDEX IF NOT EXISTS idx_org_relationships_manager ON org_relationships (manager_employee_id);
-- At most one OPEN `direct` relationship per employee (the "solid-line
-- manager" the master instruction calls for) — dotted_line/matrix/
-- temporary/acting are deliberately NOT covered, matching the assignment
-- table's own primary-vs-everything-else split above.
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_relationships_one_open_direct
  ON org_relationships (employee_id) WHERE relationship_type = 'direct' AND status = 'active';

-- ---------------------------------------------------------------------
-- org_relationship_versions — effective-dated history, scope =
-- { org_relationship_id }
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_relationship_versions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_relationship_id   uuid NOT NULL REFERENCES org_relationships(id) ON DELETE CASCADE,
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id           uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  manager_employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  relationship_type     text NOT NULL CHECK (relationship_type IN (
                          'direct', 'dotted_line', 'matrix', 'temporary', 'acting'
                        )),
  status                text NOT NULL CHECK (status IN ('active', 'ended')),
  effective_from        date NOT NULL,
  effective_to          date,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (employee_id <> manager_employee_id)
);
CREATE INDEX IF NOT EXISTS idx_org_relationship_versions_relationship
  ON org_relationship_versions (org_relationship_id, effective_from);
CREATE INDEX IF NOT EXISTS idx_org_relationship_versions_employee ON org_relationship_versions (employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_relationship_versions_one_open
  ON org_relationship_versions (org_relationship_id) WHERE effective_to IS NULL;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON
  employee_org_assignments, employee_org_assignment_versions,
  org_relationships, org_relationship_versions
TO app_role;

-- ---------------------------------------------------------------------
-- Row Level Security — same tenant-isolation-backstop shape 0065/0068
-- established. EmployeeOrgAssignmentsService's/OrgRelationshipsService's
-- own permission checks (seeded in
-- 0072_employee_org_assignments_relationships_seed.sql) are the real
-- gate; RLS is defense-in-depth underneath them.
-- ---------------------------------------------------------------------
ALTER TABLE employee_org_assignments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_org_assignments          FORCE ROW LEVEL SECURITY;
ALTER TABLE employee_org_assignment_versions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_org_assignment_versions  FORCE ROW LEVEL SECURITY;
ALTER TABLE org_relationships                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_relationships                 FORCE ROW LEVEL SECURITY;
ALTER TABLE org_relationship_versions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_relationship_versions         FORCE ROW LEVEL SECURITY;

CREATE POLICY employee_org_assignments_select ON employee_org_assignments FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_org_assignments_insert ON employee_org_assignments FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_org_assignments_update ON employee_org_assignments FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY employee_org_assignment_versions_select ON employee_org_assignment_versions FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_org_assignment_versions_insert ON employee_org_assignment_versions FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_org_assignment_versions_update ON employee_org_assignment_versions FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY org_relationships_select ON org_relationships FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY org_relationships_insert ON org_relationships FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY org_relationships_update ON org_relationships FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY org_relationship_versions_select ON org_relationship_versions FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY org_relationship_versions_insert ON org_relationship_versions FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY org_relationship_versions_update ON org_relationship_versions FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
