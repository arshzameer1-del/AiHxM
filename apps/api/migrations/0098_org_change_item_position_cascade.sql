-- ---------------------------------------------------------------------
-- Cross-module integration audit Item 7 (2026-10-01) — Reorganization
-- archive of an org unit that still has FILLED positions.
--
-- Before this, `OrgChangesService.applyItem()` would archive such a unit
-- and leave its positions `filled`, their occupants' `employees.position_id`
-- and open `employee_org_assignments` rows all pointing into a unit that no
-- longer accepts assignments — silent dangling references.
--
-- Each item now carries an explicit `cascade_action`:
--   - 'require_vacant' (the DEFAULT — every pre-existing row and every
--     caller that omits it): an `archive` item whose unit still has filled
--     positions FAILS validation with a blocking error naming the count,
--     and is re-checked at execution time (data can change between
--     approval and the effective date) — the change is marked `failed`
--     rather than applied.
--   - 'auto_unassign': executing the item vacates every filled position in
--     that unit (never abolishes them — abolition is a separate, explicit
--     decision) and ends every open assignment slot pointing at the unit,
--     in the SAME transaction as the archive, each audit row tagged
--     `source: org_change:<id>` so the cascade traces back to the approved
--     change that caused it.
--
-- Additive and backward compatible: a NOT NULL column with a default, so
-- every existing row reads as the safe, blocking behavior.
-- ---------------------------------------------------------------------

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE org_change_items
  ADD COLUMN IF NOT EXISTS cascade_action text NOT NULL DEFAULT 'require_vacant'
    CHECK (cascade_action IN ('require_vacant', 'auto_unassign'));
