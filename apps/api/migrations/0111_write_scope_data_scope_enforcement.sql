-- Cross-module integration audit (2026-10-01), remaining half of gap
-- #3/#7 — "Data Scope (org-unit/location-based restricted access) sirf
-- READ endpoints mein kaam karta hai, koi bhi WRITE/APPROVE/FINALIZE/
-- TERMINATE/PUBLISH action mein nahi". Payroll Areas (0101/0102) already
-- closed this for payroll run actions; this migration closes it for the
-- two objects the audit named explicitly that were still `.all`-only on
-- every write path: Position (create/update/freeze/unfreeze/abolish/
-- reactivate/assign/unassign) and Employee (update — which is also how
-- termination happens — and every EmployeeLifecycleService transaction:
-- transfer/promote/demote/second/act/changeManager/changeLocation/
-- terminate/reactivate, all funneled through its own shared execute()).
--
-- Same `.all`/`.scoped` alternative convention 0079/0102 established:
-- `.scoped` resolves against the caller's own `data_scope_assignments`
-- (0078), org-unit and location dimensions expanded to subtree, exactly
-- the "either dimension, caller's side only" rule PositionsService's own
-- `resolveViewAccess()` and `payroll-area-access.ts` already apply for
-- their read/run-scope checks. A `regional_hr` caller with only
-- `.scoped` permissions can manage positions and employees inside their
-- assigned org unit(s)' subtree (or, for Position, a tagged cost center)
-- — never company-wide, and never a position/employee outside that
-- scope even if a patch tries to move it there (the service asserts
-- scope on the record's CURRENT org unit/cost center/location, and again
-- on the NEW one when a write would change it).
--
-- Enforced in PositionsService.resolveManageAccess()/EmployeesService.
-- resolveManageAccess()/EmployeeLifecycleService.resolveManageAccess() —
-- see each one's own doc comment for exactly which methods call it.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('position.manage.scoped', 'Create, edit, freeze/abolish and assign/unassign only positions within the caller''s assigned org-unit or cost-center data scope'),
  ('employee.manage.scoped', 'Update, and run lifecycle transactions (transfer/promote/demote/second/act/change-manager/change-location/terminate/reactivate) on, only employees within the caller''s assigned org-unit or location data scope')
ON CONFLICT (key) DO NOTHING;

-- `regional_hr` (0079) already holds the read-side `.scoped` permissions
-- for this exact persona — it now also gets to act on what it can see.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'regional_hr' AND p.key IN ('position.manage.scoped', 'employee.manage.scoped')
ON CONFLICT DO NOTHING;

-- `regional_finance` (0079) already holds `position.view.scoped` (cost-
-- center dimension) alongside `cost_center.view.scoped` — same symmetry
-- on the write side: it can update/freeze/assign positions tagged with
-- its own cost center(s), never company-wide. It gets no
-- `employee.manage.scoped` — Regional Finance's own description (0079)
-- is explicitly about positions/cost centers, never employee records.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'regional_finance' AND p.key = 'position.manage.scoped'
ON CONFLICT DO NOTHING;
