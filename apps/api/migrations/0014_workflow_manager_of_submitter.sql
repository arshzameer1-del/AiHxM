-- Phase 9 — adds the `manager_of_submitter` approver type Decision #6
-- explicitly deferred: "it needs an employee/manager reporting hierarchy,
-- which doesn't exist until Employee Core (Phase 7)." Phase 7 exists now,
-- and Phase 9's own leave-approval flow is the first real consumer.
--
-- Unlike 'role' (role_id set, user_account_id null) and 'specific_user'
-- (user_account_id set, role_id null), 'manager_of_submitter' carries
-- NEITHER at the template-configuration level — there is no fixed role
-- or person to name in advance, because who "the submitter's manager" is
-- depends on which employee submits, resolved fresh at the moment each
-- workflow instance's step actually activates (WorkflowService's own
-- activateFromStep, apps/api/src/workflow/workflow.service.ts). The
-- RESULT of that resolution is what gets written to
-- workflow_step_approvals.user_account_id for the instance — the template
-- row itself stays generic and reusable across every employee who ever
-- submits through it.

ALTER TABLE workflow_template_step_approvers
  DROP CONSTRAINT workflow_template_step_approvers_approver_type_check,
  DROP CONSTRAINT workflow_template_step_approvers_escalation_approver_type_check,
  DROP CONSTRAINT workflow_template_step_approvers_check,
  DROP CONSTRAINT workflow_template_step_approvers_check1;

ALTER TABLE workflow_template_step_approvers
  ADD CONSTRAINT workflow_template_step_approvers_approver_type_check
    CHECK (approver_type IN ('role', 'specific_user', 'manager_of_submitter')),
  ADD CONSTRAINT workflow_template_step_approvers_escalation_approver_type_check
    CHECK (escalation_approver_type IN ('role', 'specific_user')),
  ADD CONSTRAINT workflow_template_step_approvers_check
    CHECK (
      (approver_type = 'role' AND role_id IS NOT NULL AND user_account_id IS NULL)
      OR (approver_type = 'specific_user' AND user_account_id IS NOT NULL AND role_id IS NULL)
      OR (approver_type = 'manager_of_submitter' AND role_id IS NULL AND user_account_id IS NULL)
    ),
  ADD CONSTRAINT workflow_template_step_approvers_check1
    CHECK (
      escalation_approver_type IS NULL
      OR (escalation_approver_type = 'role' AND escalation_role_id IS NOT NULL AND escalation_user_account_id IS NULL)
      OR (escalation_approver_type = 'specific_user' AND escalation_user_account_id IS NOT NULL AND escalation_role_id IS NULL)
    );

-- workflow_step_approvals rows CAN and normally DO carry a resolved
-- user_account_id for a 'manager_of_submitter' line (set at activation
-- time, once resolution succeeds) — so, unlike the template table above,
-- this one only needs its approver_type CHECK widened, not the
-- role_id/user_account_id shape constrained further.
ALTER TABLE workflow_step_approvals
  DROP CONSTRAINT workflow_step_approvals_approver_type_check;

ALTER TABLE workflow_step_approvals
  ADD CONSTRAINT workflow_step_approvals_approver_type_check
    CHECK (approver_type IN ('role', 'specific_user', 'manager_of_submitter'));

-- `submitted_by_user_account_id` means exactly what it always has — the
-- API caller who actually submitted the instance, for audit/attribution
-- (unchanged by this migration). "Manager of submitter" needs a
-- different, separately-tracked actor: for an On-Behalf submission (HR
-- submits a leave request FOR an employee who can't use the app
-- themselves), the person whose manager should approve is the EMPLOYEE
-- the request is about, not the HR Admin who happened to click submit.
-- `subject_user_account_id` captures that distinction explicitly rather
-- than overloading `submitted_by_user_account_id` with two meanings.
-- Defaults to the same value as `submitted_by_user_account_id` (the
-- ordinary self-submission case, where caller and subject are the same
-- person) — callers only need to pass something different for an
-- On-Behalf submission.
ALTER TABLE workflow_instances
  ADD COLUMN IF NOT EXISTS subject_user_account_id uuid REFERENCES user_accounts(id);
UPDATE workflow_instances SET subject_user_account_id = submitted_by_user_account_id
  WHERE subject_user_account_id IS NULL;
ALTER TABLE workflow_instances
  ALTER COLUMN subject_user_account_id SET NOT NULL;
