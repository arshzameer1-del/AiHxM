-- BACKLOG57. ADDITIVE.
--  * Approver type `manager_of_manager` (the submitter's manager's manager).
--  * What happens when a person-resolved approver cannot be found (no manager on file, no login): fallback_type
--    skip | role | specific_user | submitter_manager, instead of refusing the submission.
--  * Escalation target `manager_of_approver` (the manager of whoever holds the line), and an optional automatic action
--    (auto_approve | auto_reject) once a line has been escalated for N hours.
--
-- ROLLBACK: drop the columns added below and restore the earlier CHECK constraints (0137).

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE workflow_template_step_approvers
  ADD COLUMN IF NOT EXISTS fallback_type text,
  ADD COLUMN IF NOT EXISTS fallback_role_id uuid REFERENCES roles(id),
  ADD COLUMN IF NOT EXISTS fallback_user_account_id uuid REFERENCES user_accounts(id),
  ADD COLUMN IF NOT EXISTS escalation_action text,
  ADD COLUMN IF NOT EXISTS escalation_action_hours integer;

ALTER TABLE workflow_step_approvals
  ADD COLUMN IF NOT EXISTS escalation_action text,
  ADD COLUMN IF NOT EXISTS escalation_action_hours integer;

-- approver types
ALTER TABLE workflow_template_step_approvers DROP CONSTRAINT IF EXISTS workflow_template_step_approvers_approver_type_check;
ALTER TABLE workflow_template_step_approvers ADD CONSTRAINT workflow_template_step_approvers_approver_type_check
  CHECK (approver_type IN ('role', 'specific_user', 'manager_of_submitter', 'manager_of_manager', 'org_unit_head', 'dotted_line_manager', 'position', 'group'));
ALTER TABLE workflow_template_step_approvers DROP CONSTRAINT IF EXISTS workflow_template_step_approvers_check;
ALTER TABLE workflow_template_step_approvers ADD CONSTRAINT workflow_template_step_approvers_check CHECK (
     (approver_type = 'role' AND role_id IS NOT NULL AND user_account_id IS NULL)
  OR (approver_type = 'specific_user' AND user_account_id IS NOT NULL AND role_id IS NULL)
  OR (approver_type IN ('manager_of_submitter', 'manager_of_manager', 'dotted_line_manager', 'org_unit_head') AND role_id IS NULL AND user_account_id IS NULL)
  OR (approver_type = 'position' AND position_id IS NOT NULL AND role_id IS NULL AND user_account_id IS NULL)
  OR (approver_type = 'group' AND employee_group_id IS NOT NULL AND role_id IS NULL AND user_account_id IS NULL));
ALTER TABLE workflow_step_approvals DROP CONSTRAINT IF EXISTS workflow_step_approvals_approver_type_check;
ALTER TABLE workflow_step_approvals ADD CONSTRAINT workflow_step_approvals_approver_type_check
  CHECK (approver_type IN ('role', 'specific_user', 'manager_of_submitter', 'manager_of_manager', 'org_unit_head', 'dotted_line_manager', 'position', 'group'));

-- escalation target types
ALTER TABLE workflow_template_step_approvers DROP CONSTRAINT IF EXISTS workflow_template_step_approvers_escalation_approver_type_check;
ALTER TABLE workflow_template_step_approvers ADD CONSTRAINT workflow_template_step_approvers_escalation_approver_type_check
  CHECK (escalation_approver_type IS NULL OR escalation_approver_type IN ('role', 'specific_user', 'manager_of_approver'));
ALTER TABLE workflow_template_step_approvers DROP CONSTRAINT IF EXISTS workflow_template_step_approvers_check1;
ALTER TABLE workflow_template_step_approvers ADD CONSTRAINT workflow_template_step_approvers_check1 CHECK (
     escalation_approver_type IS NULL
  OR (escalation_approver_type = 'role' AND escalation_role_id IS NOT NULL AND escalation_user_account_id IS NULL)
  OR (escalation_approver_type = 'specific_user' AND escalation_user_account_id IS NOT NULL AND escalation_role_id IS NULL)
  OR (escalation_approver_type = 'manager_of_approver' AND escalation_role_id IS NULL AND escalation_user_account_id IS NULL));

-- escalation action
ALTER TABLE workflow_template_step_approvers DROP CONSTRAINT IF EXISTS workflow_tsa_escalation_action_check;
ALTER TABLE workflow_template_step_approvers ADD CONSTRAINT workflow_tsa_escalation_action_check CHECK (
     (escalation_action IS NULL AND escalation_action_hours IS NULL)
  OR (escalation_action IN ('auto_approve', 'auto_reject') AND escalation_action_hours IS NOT NULL AND escalation_action_hours >= 1));
ALTER TABLE workflow_step_approvals DROP CONSTRAINT IF EXISTS workflow_sa_escalation_action_check;
ALTER TABLE workflow_step_approvals ADD CONSTRAINT workflow_sa_escalation_action_check CHECK (
     (escalation_action IS NULL AND escalation_action_hours IS NULL)
  OR (escalation_action IN ('auto_approve', 'auto_reject') AND escalation_action_hours IS NOT NULL AND escalation_action_hours >= 1));

-- fallback when the person cannot be found
ALTER TABLE workflow_template_step_approvers DROP CONSTRAINT IF EXISTS workflow_tsa_fallback_check;
ALTER TABLE workflow_template_step_approvers ADD CONSTRAINT workflow_tsa_fallback_check CHECK (
     (fallback_type IS NULL AND fallback_role_id IS NULL AND fallback_user_account_id IS NULL)
  OR (fallback_type IN ('skip', 'submitter_manager') AND fallback_role_id IS NULL AND fallback_user_account_id IS NULL)
  OR (fallback_type = 'role' AND fallback_role_id IS NOT NULL AND fallback_user_account_id IS NULL)
  OR (fallback_type = 'specific_user' AND fallback_user_account_id IS NOT NULL AND fallback_role_id IS NULL));
