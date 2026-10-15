-- Gap Register LIF-09 (Step 5D). ADDITIVE.
--
--  employee_onboarding_items  assignee, due date, link to a workflow task
--  onboarding_item_templates  applicability (who the item applies to), a
--                             default assignee rule and a due-date offset.
--
-- workflow_task_id deliberately has no FK yet: the unified task / My Inbox
-- entity arrives with the workflow unification step (WFL), which adds the FK.
-- Existing templates apply to everyone (empty applicability) with no assignee
-- and no due date, so current behaviour is unchanged.
--
-- ROLLBACK: DROP INDEX idx_onboarding_items_assignee, idx_onboarding_items_due;
--   ALTER TABLE employee_onboarding_items / onboarding_item_templates DROP the
--   columns added below.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE onboarding_item_templates
  ADD COLUMN IF NOT EXISTS applicability jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS assignee_rule text NOT NULL DEFAULT 'none' CHECK (assignee_rule IN ('none', 'employee', 'manager')),
  ADD COLUMN IF NOT EXISTS due_offset_days integer CHECK (due_offset_days IS NULL OR (due_offset_days >= 0 AND due_offset_days <= 365));

ALTER TABLE employee_onboarding_items
  ADD COLUMN IF NOT EXISTS assigned_to_user_account_id uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS due_date date,
  ADD COLUMN IF NOT EXISTS workflow_task_id uuid;

CREATE INDEX IF NOT EXISTS idx_onboarding_items_assignee ON employee_onboarding_items (assigned_to_user_account_id, due_date) WHERE status = 'pending' AND assigned_to_user_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_onboarding_items_due ON employee_onboarding_items (company_id, due_date) WHERE status = 'pending' AND due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_onboarding_items_workflow_task ON employee_onboarding_items (workflow_task_id) WHERE workflow_task_id IS NOT NULL;
