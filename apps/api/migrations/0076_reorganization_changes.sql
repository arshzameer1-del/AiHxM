-- Organization Management, Phase 5 — Reorganization workflow & data
-- quality.
--
-- Source: claude/organization-management-4000-gap-analysis-and-roadmap.md
-- ("Phase 5 — Reorganization workflow & data quality" row): "The Draft ->
-- Validate -> Impact Analysis -> Approval -> Effective-Date Execution ->
-- Publish -> Events lifecycle, built on the existing Workflow engine
-- (approvals) and Rules Engine (validation: cycle prevention, orphan
-- detection, overlapping effective dates). A scoped impact-preview screen
-- ... rather than a full simulation-and-rollback studio." This migration
-- is the schema for that lifecycle.
--
-- SCOPE (the one real judgment call this migration makes): a reorg change
-- in this first pass is a BATCH of proposed Org Unit mutations (move /
-- rename / retype / archive / activate) — the classic, most-requested
-- meaning of "reorganization" — not a generic mutation log over every
-- Organization Management entity (Position/Assignment/Location are all
-- structurally reachable from an Org Unit move's downstream impact, so
-- Impact Analysis below still covers them, just not as directly-editable
-- change-item targets in v1). Position/Location/Cost-Center reorg support
-- is a natural, additive follow-up (new `action`/target columns) once
-- real demand asks for it — not built ahead of that, per this project's
-- standing "rule of three" discipline.
--
-- TWO NEW TABLES, no stable-identity+version split this time: unlike
-- every prior phase's own master data (Org Unit/Job/Position/Location/
-- Cost Center/Profit Center), an `org_change` is itself already a
-- point-in-time record of a proposed edit — it doesn't need its own
-- history-of-edits-to-itself the way a Location's name does. Its `status`
-- column IS its lifecycle history (draft -> validated -> pending_approval
-- -> approved/rejected -> published/failed), and `org_change_items` are
-- fixed at creation time (no update-items endpoint in v1 — a wrong draft
-- is discarded and recreated, not edited in place, keeping the validation
-- state always in sync with the items it validated).
--
--   org_changes      — the batch itself: title/description, the proposed
--                       `effective_date`, lifecycle `status`,
--                       `workflow_instance_id` (set once submitted for
--                       approval — WorkflowService owns the actual
--                       approval routing, exactly LeaveRequestsService's
--                       own `workflow_instance_id` precedent),
--                       `validation_errors`/`validation_warnings`
--                       (jsonb — OrgChangesService.validate()'s findings),
--                       `impact_summary` (jsonb —
--                       OrgChangesService.analyzeImpact()'s counts), and
--                       `failure_reason` (set if execution fails partway
--                       through its items — see OrgChangesService.execute()
--                       for the documented non-atomicity this implies).
--   org_change_items — one proposed mutation per row, `sequence`-ordered
--                       (multi-unit reorgs are applied in a defined
--                       order), each targeting exactly one `org_unit_id`
--                       via exactly one `action`. `applied_at` is set
--                       per-item as OrgChangesService.execute() works
--                       through them, so a partially-executed batch shows
--                       precisely how far it got.
--
-- VALIDATION (cycle prevention / orphan detection / overlapping changes —
-- the "Rules Engine" line above): OrgUnitsService's own `move()` already
-- guards a SINGLE reparent against becoming a cycle by checking the
-- target's current descendant set; a BATCH of proposed moves needs more —
-- two items in the same batch can each be individually cycle-free today
-- and still combine into a cycle once both are simultaneously applied
-- (A moves under B, B moves under A). OrgChangesService.validate() builds
-- an in-memory combined parent map (current parent, overridden by any
-- 'move' item in this same batch) and walks it for cycles/self-parenting
-- across the WHOLE batch at once — the graph-aware check
-- 0065_organization_units.sql's own header comment explicitly deferred to
-- "Phase 5 territory." No new engine module was warranted for this: the
-- existing `rules-engine` module's `RuleExpression`/`RulesEngine.evaluate()`
-- is a flat field-condition evaluator (AND/OR/NOT over
-- equals/in/between/...), not a graph-traversal primitive, so it is not a
-- natural fit for cycle detection itself — this migration's "Rules
-- Engine" alignment is the DISCIPLINE that module established (validate
-- structural correctness explicitly, throw/report rather than silently
-- guess), applied here as bespoke graph checks rather than routed through
-- that module's own expression grammar. "Orphan detection" = no item may
-- move a unit under a parent this SAME batch is archiving. "Overlapping
-- changes" = no org unit may be the target of two different still-open
-- (non-terminal-status) `org_changes` at once, checked at validate() time
-- against the whole company's other in-flight batches.
--
-- No Configuration Center registration: an org_change is transactional/
-- operational data (a proposed, time-boxed batch of edits), not
-- reusable setup data — the same "setup vs. transactional" line Phase 2
-- drew for Position and Phase 3 drew for Employee Org Assignment/Org
-- Relationship.

CREATE TABLE IF NOT EXISTS org_changes (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title                         text NOT NULL,
  description                   text,
  status                        text NOT NULL DEFAULT 'draft'
                                  CHECK (status IN ('draft', 'validated', 'pending_approval', 'approved', 'rejected', 'published', 'failed')),
  effective_date                date NOT NULL,
  created_by_user_account_id    uuid NOT NULL REFERENCES user_accounts(id),
  workflow_instance_id          uuid REFERENCES workflow_instances(id),
  validation_errors             jsonb,
  validation_warnings           jsonb,
  impact_summary                jsonb,
  failure_reason                text,
  validated_at                  timestamptz,
  executed_at                   timestamptz,
  published_at                  timestamptz,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_org_changes_company_status ON org_changes (company_id, status);
-- Used by the effective-date execution sweep (OrgChangesService's own
-- `executeDueChanges()`, wired to a cron in organization.module.ts exactly
-- like WorkflowService.escalateOverdue()): "every approved change whose
-- effective date has arrived" is the entire query it runs.
CREATE INDEX IF NOT EXISTS idx_org_changes_due ON org_changes (status, effective_date) WHERE status = 'approved';

-- `org_unit_id`/`new_parent_id` are DELIBERATELY plain `uuid` columns, not
-- FKs to `org_units(id)`: a typo'd or since-superseded target is exactly
-- the kind of problem `OrgChangesService.validate()` exists to surface as
-- a clean, reportable "Item N: org unit ... not found" error (this
-- migration's own header comment). A hard FK would instead reject the
-- INSERT itself with a raw constraint-violation error at `create()` time
-- — before a draft even exists to run `validate()` against, and with no
-- way to show the caller which item(s) were the problem. Org units are
-- never hard-deleted in this codebase (only archived), so the FK's only
-- real value would have been catching a typo — which `validate()` already
-- does, with a far better error.
CREATE TABLE IF NOT EXISTS org_change_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_change_id  uuid NOT NULL REFERENCES org_changes(id) ON DELETE CASCADE,
  sequence       int NOT NULL,
  org_unit_id    uuid NOT NULL,
  action         text NOT NULL CHECK (action IN ('move', 'rename', 'retype', 'archive', 'activate')),
  new_parent_id  uuid,
  new_name       text,
  new_unit_type  text,
  applied_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_change_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_org_change_items_change ON org_change_items (org_change_id);
CREATE INDEX IF NOT EXISTS idx_org_change_items_unit ON org_change_items (org_unit_id);

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON org_changes, org_change_items TO app_role;

-- ---------------------------------------------------------------------
-- Row Level Security — org_changes gets the standard tenant policy;
-- org_change_items has no company_id of its own, scoped through its
-- parent, same pattern as workflow_template_steps (0007's own comment).
-- OrgChangesService's own RBAC checks (seeded in
-- 0077_reorganization_changes_seed.sql) are the real gate; RLS is
-- defense-in-depth underneath them.
-- ---------------------------------------------------------------------
ALTER TABLE org_changes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_changes       FORCE ROW LEVEL SECURITY;
ALTER TABLE org_change_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_change_items  FORCE ROW LEVEL SECURITY;

CREATE POLICY org_changes_rw ON org_changes FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY org_change_items_rw ON org_change_items FOR ALL
  USING (
    app.is_platform_admin() OR app.is_service()
    OR EXISTS (SELECT 1 FROM org_changes c WHERE c.id = org_change_id AND c.company_id = app.current_company_id())
  )
  WITH CHECK (
    app.is_platform_admin() OR app.is_service()
    OR EXISTS (SELECT 1 FROM org_changes c WHERE c.id = org_change_id AND c.company_id = app.current_company_id())
  );
