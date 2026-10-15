-- Gap Register WFL-01..WFL-07, ACC-06 (Step 6). ADDITIVE.
--
--  WFL-02  workflow_template_versions: immutable snapshots; instances pin
--          template_version_id and read their steps from it, so editing a
--          template never changes an in-flight approval. Existing templates
--          get version 1 and existing instances are pinned to it.
--  WFL-03  decisions send_back / request_info / delegate; instance statuses
--          returned and on_hold; workflow_comments and workflow_attachments.
--  WFL-04  approver types org_unit_head, dotted_line_manager, position, group
--          (resolved through positions / org_relationships / employee groups).
--  WFL-05  per-step approval_mode (all | any | quorum), quorum_count,
--          parallel_group, reminder_hours, require_comment_on_reject;
--          templates get trigger_event and start_condition.
--  WFL-07  instances get title, priority and due_at, indexed for inbox queries.
--  ACC-06  delegations (delegator, delegate, scope, window, reason) and
--          delegated_from_user_account_id on approval lines.
--  WFL-01  workflow_instance_id on every approval-bearing record that did not
--          have one; the TLM tables also accept status 'returned' / 'cancelled'.
--
-- ROLLBACK: DROP TABLE workflow_attachments, workflow_comments, delegations,
--   workflow_template_versions; ALTER TABLE ... DROP the columns added below
--   (workflow_instances, workflow_step_instances, workflow_step_approvals,
--   workflow_templates, workflow_template_steps, workflow_template_step_approvers,
--   and workflow_instance_id on the WFL-01 tables); restore the earlier CHECK
--   constraints (instance statuses in_progress|approved|rejected|cancelled,
--   approver types role|specific_user|manager_of_submitter).

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- ------------------------------------------------------------ template config
ALTER TABLE workflow_templates
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS trigger_event text,
  ADD COLUMN IF NOT EXISTS start_condition jsonb,
  ADD COLUMN IF NOT EXISTS current_version_no integer NOT NULL DEFAULT 1 CHECK (current_version_no >= 1);

ALTER TABLE workflow_template_steps
  ADD COLUMN IF NOT EXISTS approval_mode text NOT NULL DEFAULT 'all' CHECK (approval_mode IN ('all', 'any', 'quorum')),
  ADD COLUMN IF NOT EXISTS quorum_count integer CHECK (quorum_count IS NULL OR quorum_count >= 1),
  ADD COLUMN IF NOT EXISTS parallel_group text,
  ADD COLUMN IF NOT EXISTS reminder_hours integer CHECK (reminder_hours IS NULL OR reminder_hours >= 1),
  ADD COLUMN IF NOT EXISTS require_comment_on_reject boolean NOT NULL DEFAULT false;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_steps_quorum_check') THEN
    ALTER TABLE workflow_template_steps ADD CONSTRAINT workflow_steps_quorum_check
      CHECK ((approval_mode = 'quorum') = (quorum_count IS NOT NULL));
  END IF;
END $$;

ALTER TABLE workflow_template_step_approvers
  ADD COLUMN IF NOT EXISTS position_id uuid REFERENCES positions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS employee_group_id uuid REFERENCES employee_groups(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS org_unit_id uuid REFERENCES org_units(id) ON DELETE RESTRICT;

ALTER TABLE workflow_template_step_approvers DROP CONSTRAINT IF EXISTS workflow_template_step_approvers_approver_type_check;
ALTER TABLE workflow_template_step_approvers ADD CONSTRAINT workflow_template_step_approvers_approver_type_check
  CHECK (approver_type IN ('role', 'specific_user', 'manager_of_submitter', 'org_unit_head', 'dotted_line_manager', 'position', 'group'));
ALTER TABLE workflow_template_step_approvers DROP CONSTRAINT IF EXISTS workflow_template_step_approvers_check;
ALTER TABLE workflow_template_step_approvers ADD CONSTRAINT workflow_template_step_approvers_check CHECK (
     (approver_type = 'role' AND role_id IS NOT NULL AND user_account_id IS NULL)
  OR (approver_type = 'specific_user' AND user_account_id IS NOT NULL AND role_id IS NULL)
  OR (approver_type IN ('manager_of_submitter', 'dotted_line_manager', 'org_unit_head') AND role_id IS NULL AND user_account_id IS NULL)
  OR (approver_type = 'position' AND position_id IS NOT NULL AND role_id IS NULL AND user_account_id IS NULL)
  OR (approver_type = 'group' AND employee_group_id IS NOT NULL AND role_id IS NULL AND user_account_id IS NULL));

-- ------------------------------------------------------------ versions (WFL-02)
CREATE TABLE IF NOT EXISTS workflow_template_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id  uuid NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_no   integer NOT NULL CHECK (version_no >= 1),
  definition   jsonb NOT NULL,
  content_hash text NOT NULL,
  created_by_user_account_id uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_template_versions_unique UNIQUE (template_id, version_no)
);
CREATE INDEX IF NOT EXISTS idx_workflow_template_versions_company ON workflow_template_versions (company_id);

CREATE OR REPLACE FUNCTION app.trg_workflow_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'workflow template versions are immutable; publish a new version instead' USING ERRCODE = 'restrict_violation';
END $$;
DROP TRIGGER IF EXISTS trg_workflow_version_immutable ON workflow_template_versions;
CREATE TRIGGER trg_workflow_version_immutable BEFORE UPDATE ON workflow_template_versions
  FOR EACH ROW EXECUTE FUNCTION app.trg_workflow_version_immutable();

-- version 1 for every existing template (re-runnable)
INSERT INTO workflow_template_versions (template_id, company_id, version_no, definition, content_hash)
SELECT d.id, d.company_id, 1, d.def, md5(d.def::text)
  FROM (
    SELECT t.id, t.company_id,
           jsonb_build_object(
             'triggerEvent', t.trigger_event,
             'startCondition', t.start_condition,
             'steps', COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                        'stepOrder', s.step_order, 'name', s.name, 'condition', s.condition, 'slaHours', s.sla_hours,
                        'approvalMode', s.approval_mode, 'quorumCount', s.quorum_count, 'parallelGroup', s.parallel_group,
                        'reminderHours', s.reminder_hours, 'requireCommentOnReject', s.require_comment_on_reject,
                        'approvers', COALESCE((
                          SELECT jsonb_agg(jsonb_build_object(
                                   'id', a.id, 'approverType', a.approver_type, 'roleId', a.role_id, 'userAccountId', a.user_account_id,
                                   'positionId', a.position_id, 'employeeGroupId', a.employee_group_id, 'orgUnitId', a.org_unit_id,
                                   'escalationApproverType', a.escalation_approver_type, 'escalationRoleId', a.escalation_role_id,
                                   'escalationUserAccountId', a.escalation_user_account_id))
                            FROM workflow_template_step_approvers a WHERE a.step_id = s.id), '[]'::jsonb))
                      ORDER BY s.step_order)
                 FROM workflow_template_steps s WHERE s.template_id = t.id), '[]'::jsonb)) AS def
      FROM workflow_templates t) d
ON CONFLICT (template_id, version_no) DO NOTHING;

-- ------------------------------------------------------------ instances (WFL-03, WFL-07)
ALTER TABLE workflow_instances
  ADD COLUMN IF NOT EXISTS template_version_id uuid REFERENCES workflow_template_versions(id),
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  ADD COLUMN IF NOT EXISTS due_at timestamptz,
  ADD COLUMN IF NOT EXISTS due_at_explicit boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hold_reason text,
  ADD COLUMN IF NOT EXISTS hold_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS returned_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

UPDATE workflow_instances wi SET template_version_id = v.id
  FROM workflow_template_versions v
 WHERE v.template_id = wi.template_id AND v.version_no = 1 AND wi.template_version_id IS NULL;

ALTER TABLE workflow_instances DROP CONSTRAINT IF EXISTS workflow_instances_status_check;
ALTER TABLE workflow_instances ADD CONSTRAINT workflow_instances_status_check
  CHECK (status IN ('in_progress', 'approved', 'rejected', 'cancelled', 'returned', 'on_hold'));

CREATE INDEX IF NOT EXISTS idx_workflow_instances_inbox ON workflow_instances (company_id, status, due_at) WHERE status IN ('in_progress', 'on_hold', 'returned');
CREATE INDEX IF NOT EXISTS idx_workflow_instances_submitter ON workflow_instances (submitted_by_user_account_id, status);

ALTER TABLE workflow_step_instances
  ADD COLUMN IF NOT EXISTS approval_mode text NOT NULL DEFAULT 'all' CHECK (approval_mode IN ('all', 'any', 'quorum')),
  ADD COLUMN IF NOT EXISTS quorum_count integer,
  ADD COLUMN IF NOT EXISTS parallel_group text,
  ADD COLUMN IF NOT EXISTS reminder_hours integer,
  ADD COLUMN IF NOT EXISTS require_comment_on_reject boolean NOT NULL DEFAULT false;
ALTER TABLE workflow_step_instances DROP CONSTRAINT IF EXISTS workflow_step_instances_status_check;
ALTER TABLE workflow_step_instances ADD CONSTRAINT workflow_step_instances_status_check
  CHECK (status IN ('pending', 'skipped', 'approved', 'rejected', 'returned'));

-- ------------------------------------------------------------ approval lines (WFL-03/04, ACC-06)
ALTER TABLE workflow_step_approvals
  ADD COLUMN IF NOT EXISTS position_id uuid REFERENCES positions(id),
  ADD COLUMN IF NOT EXISTS employee_group_id uuid REFERENCES employee_groups(id),
  ADD COLUMN IF NOT EXISTS escalation_approver_type text,
  ADD COLUMN IF NOT EXISTS escalation_role_id uuid REFERENCES roles(id),
  ADD COLUMN IF NOT EXISTS escalation_user_account_id uuid REFERENCES user_accounts(id),
  ADD COLUMN IF NOT EXISTS delegated_to_user_account_id uuid REFERENCES user_accounts(id),
  ADD COLUMN IF NOT EXISTS delegated_at timestamptz,
  ADD COLUMN IF NOT EXISTS delegated_from_user_account_id uuid REFERENCES user_accounts(id),
  ADD COLUMN IF NOT EXISTS delegation_id uuid,
  ADD COLUMN IF NOT EXISTS last_reminded_at timestamptz;

ALTER TABLE workflow_step_approvals DROP CONSTRAINT IF EXISTS workflow_step_approvals_approver_type_check;
ALTER TABLE workflow_step_approvals ADD CONSTRAINT workflow_step_approvals_approver_type_check
  CHECK (approver_type IN ('role', 'specific_user', 'manager_of_submitter', 'org_unit_head', 'dotted_line_manager', 'position', 'group'));
ALTER TABLE workflow_step_approvals DROP CONSTRAINT IF EXISTS workflow_step_approvals_status_check;
ALTER TABLE workflow_step_approvals ADD CONSTRAINT workflow_step_approvals_status_check
  CHECK (status IN ('pending', 'escalated', 'approved', 'rejected', 'returned', 'withdrawn'));
ALTER TABLE workflow_step_approvals DROP CONSTRAINT IF EXISTS workflow_step_approvals_decision_check;
ALTER TABLE workflow_step_approvals ADD CONSTRAINT workflow_step_approvals_decision_check
  CHECK (decision IN ('approved', 'rejected', 'send_back'));

CREATE INDEX IF NOT EXISTS idx_wf_approvals_user ON workflow_step_approvals (user_account_id) WHERE status IN ('pending', 'escalated');
CREATE INDEX IF NOT EXISTS idx_wf_approvals_role ON workflow_step_approvals (role_id) WHERE status IN ('pending', 'escalated');
CREATE INDEX IF NOT EXISTS idx_wf_approvals_delegate ON workflow_step_approvals (delegated_to_user_account_id) WHERE delegated_to_user_account_id IS NOT NULL AND status IN ('pending', 'escalated');
CREATE INDEX IF NOT EXISTS idx_wf_approvals_escalated_to ON workflow_step_approvals (escalated_to_user_account_id) WHERE escalated_to_user_account_id IS NOT NULL AND status = 'escalated';

-- ------------------------------------------------------------ delegations (ACC-06)
CREATE TABLE IF NOT EXISTS delegations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  delegator_user_account_id uuid NOT NULL REFERENCES user_accounts(id),
  delegate_user_account_id  uuid NOT NULL REFERENCES user_accounts(id),
  scope_object_keys       text[],                       -- NULL = every approval object
  valid_from              date NOT NULL DEFAULT CURRENT_DATE,
  valid_to                date NOT NULL,
  reason                  text NOT NULL CHECK (length(btrim(reason)) > 0),
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_by_user_account_id uuid NOT NULL REFERENCES user_accounts(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  revoked_at              timestamptz,
  revoked_by_user_account_id uuid REFERENCES user_accounts(id),
  CONSTRAINT delegations_not_self CHECK (delegator_user_account_id <> delegate_user_account_id),
  CONSTRAINT delegations_window CHECK (valid_to >= valid_from),
  CONSTRAINT delegations_revoked_consistent CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT delegations_scope_nonempty CHECK (scope_object_keys IS NULL OR cardinality(scope_object_keys) > 0)
);
CREATE INDEX IF NOT EXISTS idx_delegations_delegate ON delegations (delegate_user_account_id, valid_from, valid_to) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_delegations_delegator ON delegations (delegator_user_account_id) WHERE status = 'active';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_step_approvals_delegation_fk') THEN
    ALTER TABLE workflow_step_approvals ADD CONSTRAINT workflow_step_approvals_delegation_fk
      FOREIGN KEY (delegation_id) REFERENCES delegations(id);
  END IF;
END $$;

-- a template edit replaces approver rows; instance approval lines keep their
-- own snapshot (approver_type/user/role), so the back-reference may be nulled.
ALTER TABLE workflow_step_approvals DROP CONSTRAINT IF EXISTS workflow_step_approvals_template_approver_id_fkey;
ALTER TABLE workflow_step_approvals ADD CONSTRAINT workflow_step_approvals_template_approver_id_fkey
  FOREIGN KEY (template_approver_id) REFERENCES workflow_template_step_approvers(id) ON DELETE SET NULL;

-- ------------------------------------------------------------ comments / attachments (WFL-06)
CREATE TABLE IF NOT EXISTS workflow_comments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  workflow_instance_id   uuid NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  step_instance_id       uuid REFERENCES workflow_step_instances(id) ON DELETE SET NULL,
  author_user_account_id uuid REFERENCES user_accounts(id),
  kind                   text NOT NULL DEFAULT 'comment' CHECK (kind IN
                           ('comment', 'info_request', 'info_response', 'send_back', 'resubmit', 'delegation', 'decision', 'reminder', 'system')),
  body                   text NOT NULL CHECK (length(body) > 0),
  visibility             text NOT NULL DEFAULT 'participants' CHECK (visibility IN ('participants', 'approvers')),
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workflow_comments_instance ON workflow_comments (workflow_instance_id, created_at);

CREATE TABLE IF NOT EXISTS workflow_attachments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  workflow_instance_id   uuid NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  comment_id             uuid REFERENCES workflow_comments(id) ON DELETE SET NULL,
  file_name              text NOT NULL,
  content_type           text NOT NULL,
  size_bytes             integer NOT NULL CHECK (size_bytes >= 0),
  storage_key            text NOT NULL,
  visibility             text NOT NULL DEFAULT 'participants' CHECK (visibility IN ('participants', 'approvers')),
  uploaded_by_user_account_id uuid NOT NULL REFERENCES user_accounts(id),
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workflow_attachments_instance ON workflow_attachments (workflow_instance_id);

-- ------------------------------------------------------------ RLS + grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workflow_template_versions', 'delegations', 'workflow_comments', 'workflow_attachments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format($p$CREATE POLICY %I ON %I
      USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
      WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())$p$, t || '_all', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON workflow_template_versions, workflow_comments, workflow_attachments TO app_role;
GRANT SELECT, INSERT, UPDATE ON delegations TO app_role;

-- ------------------------------------------------------------ WFL-01 links
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['attendance_correction_requests', 'overtime_records', 'on_duty_requests', 'employee_loans',
                           'employee_additional_payments', 'offers', 'employee_compensation', 'employee_payment_accounts',
                           'employee_offboarding', 'performance_reviews'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS workflow_instance_id uuid REFERENCES workflow_instances(id) ON DELETE SET NULL', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (workflow_instance_id) WHERE workflow_instance_id IS NOT NULL', 'idx_' || t || '_workflow', t);
  END LOOP;
END $$;

-- the three TLM request tables can now be sent back / withdrawn
DO $$
DECLARE t text; c text;
BEGIN
  FOREACH t IN ARRAY ARRAY['attendance_correction_requests', 'overtime_records', 'on_duty_requests'] LOOP
    c := t || '_status_check';
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, c);
    EXECUTE format($q$ALTER TABLE %I ADD CONSTRAINT %I CHECK (status IN ('pending', 'approved', 'rejected', 'returned', 'cancelled'))$q$, t, c);
  END LOOP;
END $$;
