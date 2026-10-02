-- Payroll Enterprise Gap Analysis & Roadmap, Phase P2 (2026-09-27) — the
-- second and third of the three P2 items kumail chose to build
-- (0093_payroll_approval_workflow.sql delivered the first: the
-- submit -> approve -> finalize workflow). This migration:
--
--  1. Splits the single, broad `payroll.manage.all` permission into three
--     narrower ones matching each high-stakes step of the run lifecycle:
--     `payroll.calculate.all` (settings/tax slabs, create/calculate a run,
--     submit it for approval — the preparer's own work, nothing has moved
--     yet), `payroll.finalize.all` (locks payslips — the point of no
--     return for the numbers themselves — and, together with
--     `payroll.disburse.all`, gates reversing a finalized run), and
--     `payroll.disburse.all` (generates the bank disbursement file — the
--     point actual money moves). `payroll.approve.all` already exists
--     (0093) and is unchanged: the segregation-of-duties boundary it
--     enforces (preparer != approver) stays exactly as it was.
--
--     `payroll.manage.all` itself is left in place, unused by any new
--     code from this point on, rather than dropped — deleting a
--     permission a tenant's role_permissions row or audit log already
--     references is a bigger, separate decision than this migration
--     needs to make, and keeping the row costs nothing. `hr_admin` is
--     granted all three new permissions here, so nothing this tenant
--     could already do stops working.
--
--  2. Adds Correction/Reversal to the run lifecycle (master engineering
--     instruction Section 36): a `finalized` run can now be reversed —
--     full audit trail (reason, who, when — see PayrollService.reverseRun())
--     — rather than being permanently stuck if a mistake is only caught
--     after finalization. Reversal deliberately does NOT reuse 0093's
--     "revert status in place" pattern a rejection uses
--     (`pending_approval` -> `calculated`): `calculateRun()` fully
--     DELETEs and re-inserts a run's payslips on every call, so reverting
--     a finalized run's status in place and recalculating it would
--     destroy the original, already-paid payslip numbers this migration's
--     whole job is to PRESERVE. Instead: the original run gets a new
--     terminal `reversed` status (its payslips are never touched again),
--     and a brand new `draft` run is created for the same period so HR
--     can correct the underlying data and take the corrected run through
--     the full lifecycle again. `corrective_run_id` on the original links
--     forward to it, so the whole chain (original -> reversed ->
--     corrective) is reconstructable from the runs list alone.
--
--     `payroll_runs`' existing UNIQUE(company_id, period_start, period_end)
--     constraint (0022_payroll.sql) has to relax for this — a period can
--     now have more than one row over its lifetime (the reversed original
--     plus its corrective run) — so it becomes a partial unique index
--     that only counts non-reversed rows: still exactly one ACTIVE run
--     per period at a time, which is all the original constraint was
--     ever protecting against.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- --- 1. Permission split -------------------------------------------------

INSERT INTO permissions (key, description) VALUES
  ('payroll.calculate.all', 'Manage payroll settings and tax slabs, set up and calculate payroll runs, and submit a calculated run for approval'),
  ('payroll.finalize.all', 'Finalize an approved payroll run, locking its payslips, and reverse a finalized run if a mistake is found afterward'),
  ('payroll.disburse.all', 'Generate the bank disbursement file for a finalized payroll run');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key IN ('payroll.calculate.all', 'payroll.finalize.all', 'payroll.disburse.all');

-- --- 2. Correction / reversal ---------------------------------------------

ALTER TABLE payroll_runs
  DROP CONSTRAINT payroll_runs_status_check;

ALTER TABLE payroll_runs
  ADD CONSTRAINT payroll_runs_status_check
  CHECK (status IN ('draft', 'calculated', 'pending_approval', 'approved', 'finalized', 'reversed'));

ALTER TABLE payroll_runs
  ADD COLUMN reversed_at timestamp with time zone,
  ADD COLUMN reversed_by_user_account_id uuid REFERENCES user_accounts(id),
  ADD COLUMN reversal_reason text,
  ADD COLUMN corrective_run_id uuid REFERENCES payroll_runs(id);

ALTER TABLE payroll_runs
  DROP CONSTRAINT payroll_runs_company_id_period_start_period_end_key;

-- Only one ACTIVE (non-reversed) run per period, same guarantee the old
-- constraint gave — but a reversed run no longer blocks its own
-- corrective run, or any future run, from sharing that period.
CREATE UNIQUE INDEX payroll_runs_active_period_key
  ON payroll_runs (company_id, period_start, period_end)
  WHERE status <> 'reversed';
