-- Organization Management — "Head of Department" (kumail's own request,
-- after seeing the nested Position/Holder tree view: "you missed the head
-- of department"). Enterprise HR systems (SAP's Org and Staffing view
-- among them) let one Position within an org unit be flagged as that
-- unit's own "Chief"/Head — the position whose occupant is treated as the
-- department's manager for org-chart display and, eventually, as the
-- default approver for that unit's own workflow routing. This migration
-- adds exactly that: one nullable, optional reference from an org unit to
-- one of its own Positions.
--
-- Deliberately NOT a new relationship row in some generic "org
-- relationships" table — a unit has AT MOST one head at a time, which is
-- exactly what a plain nullable foreign-key column expresses on its own;
-- a relationship-table model would be the right shape for something that
-- can have many rows per unit (like the existing `org_relationships`
-- table for employee-to-employee reporting lines), not a single
-- one-or-none pointer. This is AIHXM's own `ST-060` structural reference
-- code (see `ORG_STRUCTURE_RELATIONSHIP_CODES` in shared-types) — Org Unit
-- to Position (Head).
--
-- Added to BOTH `org_units` (the current-state cache every hierarchy query
-- reads) and `org_unit_versions` (the EffectiveDatingEngine-managed
-- history) — exactly the same two-table shape 0073's own `cost_center_id`/
-- `profit_center_id` addition to Position used, so who was head of a unit
-- on any past date is reconstructable the same way every other structural
-- fact about a unit already is.
--
-- No CHECK enforcing "the head position must belong to this org unit" at
-- the database level — that reference crosses two tables (org_units and
-- positions), which a single-table CHECK constraint cannot express;
-- `OrgUnitsService.setHeadPosition()` is the real guard, application-side,
-- the same "the DB catches the trivial case, the service catches the
-- real one" split 0065's own `parent_id <> id` CHECK already documents for
-- reparenting.
--
-- `ON DELETE SET NULL`: positions are never hard-deleted in this schema
-- (only abolished, a status), so this branch is realistically unreachable
-- in practice — kept anyway as the safe default rather than assuming that
-- invariant holds forever.

ALTER TABLE org_units
  ADD COLUMN IF NOT EXISTS head_position_id uuid REFERENCES positions(id) ON DELETE SET NULL;

ALTER TABLE org_unit_versions
  ADD COLUMN IF NOT EXISTS head_position_id uuid REFERENCES positions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_org_units_head_position
  ON org_units (head_position_id) WHERE head_position_id IS NOT NULL;
