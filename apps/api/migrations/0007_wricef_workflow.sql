-- Phase 6 — WRICEF Framework Skeleton: the Workflow engine
--
-- Plan doc Section 6's first WRICEF pillar: a generic, tenant-configurable
-- approval-routing engine. A Module Admin defines a chain of steps for a
-- given object type once; every record of that type then routes through
-- it without engineering involvement. This migration is deliberately
-- scoped to what Phase 6's own exit criterion needs and what a real BPD
-- actually asks for (plan doc Section 10's "don't let the workflow engine
-- become over-general" guardrail) — not a maximal workflow-engine schema.
--
-- Two approver types are supported: a role (any current holder of that
-- role in the tenant may act on the step) and a specific user. A third
-- type the plan doc's Section 6/BPD comparisons both mention —
-- "manager_of_submitter" / "delegate-on-leave" — is deliberately NOT
-- built here: it needs an employee/manager reporting hierarchy, which
-- doesn't exist until Employee Core (Phase 7). Building it against no
-- real hierarchy would mean inventing one twice. Tracked in
-- KNOWN_ISSUES.md as a Phase 7+ follow-up, not silently dropped.
--
-- "Parallel" steps (the plan doc's own wording) are modeled as a step
-- with more than one row in workflow_template_step_approvers — each row
-- is an independent required approval line; the step only advances once
-- every line on it has approved, and any single rejection fails the
-- whole workflow instance immediately (fail-fast, matching how a real
-- rejected leave/expense request behaves — nobody expects the remaining
-- approvers to still get a vote). "Conditional" steps are modeled via the
-- same opaque `condition` JSONB shape RBAC's field_permission_rules
-- already uses ({"field": "...", "equals": ...}) for consistency — a step
-- whose condition doesn't match the target record is skipped
-- automatically, no approval required.
--
-- SLA escalation: `sla_hours` on a template step sets `due_at` on its
-- instance approvals; a scheduled sweep (WorkflowService.escalateOverdue,
-- apps/api/src/workflow/workflow.service.ts) reassigns any approval still
-- `pending` past its `due_at` to that line's configured escalation
-- target, exactly the "forced-timeout escalation" this phase's exit
-- criterion asks for.

-- ---------------------------------------------------------------------
-- Templates: what a Module Admin configures, per object type
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workflow_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key         text NOT NULL,
  name        text NOT NULL,
  object_key  text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, key)
);

CREATE TABLE IF NOT EXISTS workflow_template_steps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE,
  step_order  int NOT NULL,
  name        text NOT NULL,
  -- Same shape as field_permission_rules.condition: {"field":"...","equals":...}.
  -- NULL means the step always applies.
  condition   jsonb,
  -- NULL means no SLA on this step — it waits indefinitely for a decision.
  sla_hours   int,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, step_order)
);

CREATE TABLE IF NOT EXISTS workflow_template_step_approvers (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  step_id                  uuid NOT NULL REFERENCES workflow_template_steps(id) ON DELETE CASCADE,
  approver_type            text NOT NULL CHECK (approver_type IN ('role', 'specific_user')),
  role_id                  uuid REFERENCES roles(id),
  user_account_id          uuid REFERENCES user_accounts(id),
  -- Optional per-line escalation target, consulted only once sla_hours
  -- elapses with no decision. NULL escalation_approver_type means "no
  -- escalation configured" — the line just stays pending past its due_at
  -- until someone builds a reminder/nag on top of it later.
  escalation_approver_type text CHECK (escalation_approver_type IN ('role', 'specific_user')),
  escalation_role_id       uuid REFERENCES roles(id),
  escalation_user_account_id uuid REFERENCES user_accounts(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (approver_type = 'role' AND role_id IS NOT NULL AND user_account_id IS NULL)
    OR (approver_type = 'specific_user' AND user_account_id IS NOT NULL AND role_id IS NULL)
  ),
  CHECK (
    escalation_approver_type IS NULL
    OR (escalation_approver_type = 'role' AND escalation_role_id IS NOT NULL AND escalation_user_account_id IS NULL)
    OR (escalation_approver_type = 'specific_user' AND escalation_user_account_id IS NOT NULL AND escalation_role_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_workflow_template_step_approvers_step
  ON workflow_template_step_approvers (step_id);

-- ---------------------------------------------------------------------
-- Instances: one per record actually routed through a template
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workflow_instances (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  template_id                 uuid NOT NULL REFERENCES workflow_templates(id),
  object_key                  text NOT NULL,
  record_id                   uuid NOT NULL,
  submitted_by_user_account_id uuid NOT NULL REFERENCES user_accounts(id),
  status                      text NOT NULL DEFAULT 'in_progress'
                                CHECK (status IN ('in_progress', 'approved', 'rejected', 'cancelled')),
  -- A snapshot of the target record at submission time, so conditional
  -- steps (workflow_template_steps.condition) can be evaluated without
  -- the engine needing to know how to query an arbitrary object's own
  -- table — the caller (whatever module owns the object) hands in the
  -- fields that matter once, here, keeping the engine fully decoupled
  -- from any specific object's schema.
  record_snapshot             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workflow_instances_record
  ON workflow_instances (object_key, record_id);

CREATE TABLE IF NOT EXISTS workflow_step_instances (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_instance_id  uuid NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  step_order            int NOT NULL,
  name                  text NOT NULL,
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'skipped', 'approved', 'rejected')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_instance_id, step_order)
);

CREATE TABLE IF NOT EXISTS workflow_step_approvals (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  step_instance_id            uuid NOT NULL REFERENCES workflow_step_instances(id) ON DELETE CASCADE,
  template_approver_id        uuid REFERENCES workflow_template_step_approvers(id),
  approver_type                text NOT NULL CHECK (approver_type IN ('role', 'specific_user')),
  role_id                      uuid REFERENCES roles(id),
  user_account_id              uuid REFERENCES user_accounts(id),
  status                       text NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'escalated', 'approved', 'rejected')),
  due_at                       timestamptz,
  escalated_at                 timestamptz,
  escalated_to_user_account_id uuid REFERENCES user_accounts(id),
  decided_by_user_account_id   uuid REFERENCES user_accounts(id),
  decision                     text CHECK (decision IN ('approved', 'rejected')),
  comment                      text,
  decided_at                   timestamptz,
  created_at                   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workflow_step_approvals_step
  ON workflow_step_approvals (step_instance_id);
-- Used by the escalation sweep: "every pending approval whose due_at has
-- passed" is the entire query it runs.
CREATE INDEX IF NOT EXISTS idx_workflow_step_approvals_due
  ON workflow_step_approvals (status, due_at) WHERE status = 'pending';

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_templates TO app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_template_steps TO app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_template_step_approvers TO app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_instances TO app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_step_instances TO app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_step_approvals TO app_role;

-- ---------------------------------------------------------------------
-- Row Level Security — every table here is tenant data (Section 4's
-- "no exceptions" rule), scoped exactly like dummy_records: Platform
-- Admin/service can see everything (needed for the escalation sweep,
-- which runs with no tenant context of its own — see WorkflowService),
-- an ordinary session sees only its own company's rows.
-- ---------------------------------------------------------------------

ALTER TABLE workflow_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE workflow_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_template_steps FORCE ROW LEVEL SECURITY;
ALTER TABLE workflow_template_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_template_step_approvers FORCE ROW LEVEL SECURITY;
ALTER TABLE workflow_template_step_approvers ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_instances FORCE ROW LEVEL SECURITY;
ALTER TABLE workflow_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_step_instances FORCE ROW LEVEL SECURITY;
ALTER TABLE workflow_step_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_step_approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE workflow_step_approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_templates_rw ON workflow_templates FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

-- Child tables have no company_id column of their own — scope through
-- their parent, same pattern the rest of this codebase uses wherever a
-- child table hangs off a tenant-scoped parent.
CREATE POLICY workflow_template_steps_rw ON workflow_template_steps FOR ALL
  USING (
    app.is_platform_admin() OR app.is_service()
    OR EXISTS (SELECT 1 FROM workflow_templates t WHERE t.id = template_id AND t.company_id = app.current_company_id())
  )
  WITH CHECK (
    app.is_platform_admin() OR app.is_service()
    OR EXISTS (SELECT 1 FROM workflow_templates t WHERE t.id = template_id AND t.company_id = app.current_company_id())
  );

CREATE POLICY workflow_template_step_approvers_rw ON workflow_template_step_approvers FOR ALL
  USING (
    app.is_platform_admin() OR app.is_service()
    OR EXISTS (
      SELECT 1 FROM workflow_template_steps s
      JOIN workflow_templates t ON t.id = s.template_id
      WHERE s.id = step_id AND t.company_id = app.current_company_id()
    )
  )
  WITH CHECK (
    app.is_platform_admin() OR app.is_service()
    OR EXISTS (
      SELECT 1 FROM workflow_template_steps s
      JOIN workflow_templates t ON t.id = s.template_id
      WHERE s.id = step_id AND t.company_id = app.current_company_id()
    )
  );

CREATE POLICY workflow_instances_rw ON workflow_instances FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY workflow_step_instances_rw ON workflow_step_instances FOR ALL
  USING (
    app.is_platform_admin() OR app.is_service()
    OR EXISTS (SELECT 1 FROM workflow_instances wi WHERE wi.id = workflow_instance_id AND wi.company_id = app.current_company_id())
  )
  WITH CHECK (
    app.is_platform_admin() OR app.is_service()
    OR EXISTS (SELECT 1 FROM workflow_instances wi WHERE wi.id = workflow_instance_id AND wi.company_id = app.current_company_id())
  );

CREATE POLICY workflow_step_approvals_rw ON workflow_step_approvals FOR ALL
  USING (
    app.is_platform_admin() OR app.is_service()
    OR EXISTS (
      SELECT 1 FROM workflow_step_instances si
      JOIN workflow_instances wi ON wi.id = si.workflow_instance_id
      WHERE si.id = step_instance_id AND wi.company_id = app.current_company_id()
    )
  )
  WITH CHECK (
    app.is_platform_admin() OR app.is_service()
    OR EXISTS (
      SELECT 1 FROM workflow_step_instances si
      JOIN workflow_instances wi ON wi.id = si.workflow_instance_id
      WHERE si.id = step_instance_id AND wi.company_id = app.current_company_id()
    )
  );
