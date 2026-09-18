-- Continuing the Effective-Dating Engine retrofit
-- (apps/api/src/effective-dating/effective-dating.engine.ts): this
-- migration closes the one remaining structural gap between
-- employee_compensation / shift_assignments and the two consumers
-- already retrofitted onto the shared engine (leave_policy_versions,
-- tax_slabs, migration 0033). Both of those already enforce "at most
-- one open row per scope" with a real DB-level partial unique index;
-- employee_compensation and shift_assignments have only ever relied on
-- application code to hold that invariant (0022_payroll.sql's and
-- 0026_shift_management.sql's own comments already flagged this as an
-- informal, not enforced, invariant). This brings both up to the same
-- standard the newer two consumers set, rather than leaving these two
-- as permanent exceptions.
--
-- No backfill/data change here, so no RLS bypass is needed the way
-- 0033's cross-table backfill required one — CREATE UNIQUE INDEX is
-- schema DDL, not a DML query subject to row-level security. If either
-- table already had more than one open row for some scope, this would
-- fail loudly rather than silently — which is the point: better to
-- find that now than to keep building on top of an unenforced
-- invariant.

CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_compensation_one_open
  ON employee_compensation (employee_id) WHERE effective_to IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_shift_assignments_one_open
  ON shift_assignments (employee_id) WHERE effective_to IS NULL;
