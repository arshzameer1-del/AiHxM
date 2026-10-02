-- ---------------------------------------------------------------------
-- Cross-module integration follow-up (2026-10-01) — `secondment` as a
-- first-class org_relationships type.
--
-- `EmployeeLifecycleService.second()` records the host-side manager of a
-- secondment as a typed reporting line, but the relationship vocabulary
-- (0071_employee_org_assignments_and_relationships.sql) had no
-- `secondment` value, so it reused `temporary` — indistinguishable from
-- an ordinary interim manager in reports, exports and the Relationship
-- Explorer. `employee_org_assignments` already has a `secondment`
-- assignment type; this gives the reporting line the same word.
--
-- Same drop+recreate pattern 0094 used for `payroll_runs_status_check`,
-- applied to BOTH the stable table and its effective-dated history table
-- (each carries its own inline CHECK). Purely additive: every existing
-- value stays valid, and existing `temporary` rows written by second()
-- before this migration are deliberately left as they are (rewriting
-- history rows would falsify what was recorded at the time).
-- ---------------------------------------------------------------------

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE org_relationships
  DROP CONSTRAINT org_relationships_relationship_type_check;

ALTER TABLE org_relationships
  ADD CONSTRAINT org_relationships_relationship_type_check
  CHECK (relationship_type IN ('direct', 'dotted_line', 'matrix', 'temporary', 'acting', 'secondment'));

ALTER TABLE org_relationship_versions
  DROP CONSTRAINT org_relationship_versions_relationship_type_check;

ALTER TABLE org_relationship_versions
  ADD CONSTRAINT org_relationship_versions_relationship_type_check
  CHECK (relationship_type IN ('direct', 'dotted_line', 'matrix', 'temporary', 'acting', 'secondment'));
