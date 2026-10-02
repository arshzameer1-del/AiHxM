-- Cross-module integration follow-up (2026-10-01) — `position_assignment`
-- as a first-class `employee_job_history.event_type`.
--
-- `PositionsService.assignEmployee()` (the Position Workbench's "assign
-- employee to this seat" action) moves an employee's org_unit_id/
-- department to follow the seat (`OrgOccupancyService
-- .syncEmployeeOrgSideToSeatWithinTransaction()`, this same follow-up
-- round) when the seat is in a different org unit, but had no event type
-- of its own to record that move in `employee_job_history` — the same
-- history table `EmployeeLifecycleService.transfer()` already writes a
-- `'transfer'` row to for the equivalent lifecycle-surface move. Reusing
-- `'transfer'` here would blur two different actions in an employee's
-- history (an explicit HR "Transfer" lifecycle transaction vs. the
-- Workbench reseating someone against an org chart); a distinct value
-- keeps the two tellable apart, matching 0088's own "a NAMED transaction
-- ... records exactly that fact, not a guess" reasoning for why Phase 10
-- widened this same list in the first place.
--
-- Same drop+recreate CHECK pattern 0088 (this table) and 0103
-- (org_relationships) both used — purely additive, every existing value
-- stays valid.

ALTER TABLE employee_job_history DROP CONSTRAINT employee_job_history_event_type_check;
ALTER TABLE employee_job_history ADD CONSTRAINT employee_job_history_event_type_check
  CHECK (event_type IN (
    'hire', 'promotion', 'transfer', 'salary_change', 'termination', 'rehire', 'other',
    'demotion', 'secondment', 'acting', 'manager_change', 'location_change', 'reactivation',
    'position_assignment'
  ));
