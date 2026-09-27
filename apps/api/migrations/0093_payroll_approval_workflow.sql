-- Payroll Enterprise Gap Analysis & Roadmap, Phase P2 (2026-09-27) —
-- approval workflow for payroll runs, the first slice of P2 (kumail chose
-- to build this before correction/reversal, the roadmap's other P2 item).
--
-- Reuses the SAME workflow engine `LeaveRequestsService`/`RecruitmentService`
-- already route through — no engine changes, just a new consumer, exactly
-- the pattern 0017_recruitment.sql followed for job_requisitions.
--
-- Lifecycle change: `payroll_runs.status` grows two new states between
-- `calculated` and `finalized`: `pending_approval` (submitted, awaiting a
-- decision) and `approved` (decided, ready to finalize).
-- `finalizeRun()` now refuses anything that isn't `approved` — a run can
-- no longer be finalized straight off a calculation, full stop.
--
-- Deliberately NOT mirroring job_requisitions'/leave_requests' own
-- terminal "rejected" status: a rejected payroll run reverts to
-- `calculated` instead (PayrollService.decideApproval()), because unlike
-- a one-shot leave request or hiring requisition, a payroll run is
-- designed to be corrected and recalculated in place
-- (`calculateRun()` already fully replaces a run's payslips on every
-- call) — a terminal "rejected" run would need a brand new run for the
-- exact same pay period, which `createRun()`'s own unique
-- (company_id, period_start, period_end) constraint doesn't allow anyway.
--
-- Segregation of duties (Decision #14's own "no separate Finance Admin
-- role" note flagged this as a deferred gap — this migration is that
-- follow-up, kumail's explicit choice among three options): a NEW,
-- distinct `payroll_approver` role/`payroll.approve.all` permission,
-- deliberately NOT granted to `hr_admin` — the person who calculates and
-- submits a run (`payroll.manage.all`) is never, by permission alone, the
-- same person who can approve it. A tenant assigns `payroll_approver` to
-- whoever should sign off (Finance Manager, owner, etc.) the same way
-- `system_admin` is self-service-assignable today (0024_system_admin.sql).
-- The workflow template itself (System Admin > Configuration >
-- "Payroll run approval", once a tenant creates one — see
-- `workflowTemplateOptions.ts`'s KNOWN_WORKFLOWS) is where that approver
-- is actually configured as the routing target; this permission is what
-- gates the decision endpoint itself, same double-gate
-- `RecruitmentService.decideRequisition()` already uses
-- (`recruitment.manage.all` + workflow-internal routing) — the difference
-- here is the gating permission is NOT the same one the preparer holds.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE payroll_runs
  ADD COLUMN workflow_instance_id uuid REFERENCES workflow_instances(id);

ALTER TABLE payroll_runs
  DROP CONSTRAINT payroll_runs_status_check;

ALTER TABLE payroll_runs
  ADD CONSTRAINT payroll_runs_status_check
  CHECK (status IN ('draft', 'calculated', 'pending_approval', 'approved', 'finalized'));

INSERT INTO permissions (key, description) VALUES
  ('payroll.approve.all', 'Approve or reject a payroll run submitted for approval, before it can be finalized');

INSERT INTO roles (key, name, description) VALUES
  ('payroll_approver', 'Payroll Approver',
   'Segregation-of-duties role (Decision #14 follow-up): reviews and approves/rejects a payroll run someone else calculated and submitted, before it can be finalized and disbursed. Holds no rights to calculate, finalize, or manage payroll settings — that stays hr_admin''s job.');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'payroll_approver' AND p.key = 'payroll.approve.all';
