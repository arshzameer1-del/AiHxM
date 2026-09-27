-- Core Employee Enterprise, Phase 2 — Hiring Process Engine.
--
-- Source: claude/core-employee-enterprise-gap-analysis-and-roadmap.md
-- ("Phase 2 — Hiring Process Engine"), built against the spec's own
-- Sections 5/6/9/10/17/23/24/25/36/39. Builds the state machine and the
-- data-driven card framework the spec calls for; does NOT yet wire real
-- field content into most of the 20 cards — that is Phases 4/6/7/8/9's
-- job, each landing its own card(s) on top of this engine.
--
-- FOUR NEW TABLES, matching the spec's own Section 39 logical model
-- naming exactly (`core_employee_card_definitions`, `hire_processes`,
-- `hire_process_cards`, `hire_process_card_data`) with one explicit
-- omission: Section 39 also names `hire_process_revisions`. Section 39's
-- own closing line gives explicit permission not to build it as a
-- separate table ("Physical tables may be adapted to the existing
-- codebase... not permission to duplicate existing platform tables") —
-- this codebase already has a generic, tenant-scoped `AuditService` used
-- by every other module for exactly this "who changed what, when" job.
-- HiringProcessService logs through it instead of a bespoke parallel
-- history table.
--
-- PER-COMPANY CARD DEFINITIONS, NOT GLOBAL: Section 19's own
-- Configuration Center tree ("Hiring Cards > Card Registry / Order /
-- Visibility / Requiredness / Dependencies") is explicit that this is
-- tenant-configurable, and kumail's own scoping decision #2 on this
-- initiative ("real engine, scoped admin surface — enable/disable and
-- reorder now") only makes sense if each tenant has its own editable row
-- per card. `core_employee_card_definitions` is seeded per company —
-- LAZILY, on first use (see HiringProcessService.ensureCardDefinitions())
-- rather than backfilled here or hooked into company provisioning: a
-- company that has never started a hire has no need for these rows yet,
-- and lazy-seeding keeps this migration from having to reach into
-- companies.service.ts's create() path at all (Section 52's "smallest
-- appropriate architectural change").
--
-- STATE MACHINE — Section 10's diagram, deliberately scoped down: this
-- phase implements `draft -> in_progress -> ready_for_completion ->
-- hired`, plus `cancelled` from any pre-completion state. Section 10's
-- `approval_required`/`returned`/`approved` branch is real Workflow-engine
-- integration (Section 34) — out of scope until a later phase actually
-- wires per-card approval (kumail's own decision #2 explicitly deferred
-- "workflow-per-card" past this initial pass). `NEW` (Section 10's
-- pre-persistence state) never gets its own row — a hire process is
-- persisted as `draft` the instant it's created, matching Section 9's own
-- "Draft: persist hiring process state" contract.
--
-- OPTIMISTIC LOCKING (Section 25) — two independent revision counters,
-- not one: `hire_processes.revision` guards process-level actions
-- (next/cancel/complete), `hire_process_card_data.revision` guards a
-- single card's own save — two HR users editing DIFFERENT cards of the
-- same draft concurrently is normal, expected behavior (Section 24's own
-- "prevent conflicting edits OR implement optimistic locking" — this
-- picks the second, and scopes the lock to the actual unit of
-- contention, a card's data, not the whole process).
--
-- IDEMPOTENT COMPLETION (Section 17) — no separate idempotency-key table:
-- `hire_processes.id` (the "hire_process_id... transaction correlation
-- key" the spec itself calls for) already uniquely identifies one
-- completion attempt. HiringProcessService.complete() checks
-- `status = 'hired'` first and returns the existing result rather than
-- re-running completion — a double-click or a retried request is a
-- second call with the same id, which is exactly what that check catches.

CREATE TABLE IF NOT EXISTS core_employee_card_definitions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  card_key      text NOT NULL,
  label         text NOT NULL,
  description   text,
  -- Section 19's own example ("Bank requires Employment") is the only
  -- dependency this phase's engine needs to express — a single optional
  -- predecessor, not a general dependency graph. A richer graph is
  -- Configuration Center territory once real usage asks for one.
  depends_on_card_key text,
  display_order int NOT NULL,
  is_enabled    boolean NOT NULL DEFAULT true,
  is_required   boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, card_key)
);
CREATE INDEX IF NOT EXISTS idx_core_employee_card_definitions_company
  ON core_employee_card_definitions (company_id, display_order);

CREATE TABLE IF NOT EXISTS hire_processes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'in_progress', 'ready_for_completion', 'hired', 'cancelled')),
  current_card_key text,
  -- Section 20 — retained by an in-progress transaction so a later admin
  -- edit to the card configuration can't pull the rug out from under a
  -- hire that's already underway. Fixed at 1 until Phase 3's admin
  -- surface actually produces a second configuration version to retain.
  config_version int NOT NULL DEFAULT 1,
  revision      int NOT NULL DEFAULT 1,
  employee_id   uuid REFERENCES employees(id),
  created_by_user_account_id uuid NOT NULL REFERENCES user_accounts(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  cancelled_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_hire_processes_company_status ON hire_processes (company_id, status);
CREATE INDEX IF NOT EXISTS idx_hire_processes_created_by ON hire_processes (created_by_user_account_id);

CREATE TABLE IF NOT EXISTS hire_process_cards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hire_process_id uuid NOT NULL REFERENCES hire_processes(id) ON DELETE CASCADE,
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  card_key        text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'saved', 'complete')),
  saved_at        timestamptz,
  UNIQUE (hire_process_id, card_key)
);
CREATE INDEX IF NOT EXISTS idx_hire_process_cards_process ON hire_process_cards (hire_process_id);

CREATE TABLE IF NOT EXISTS hire_process_card_data (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hire_process_id uuid NOT NULL REFERENCES hire_processes(id) ON DELETE CASCADE,
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  card_key        text NOT NULL,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision        int NOT NULL DEFAULT 1,
  saved_by_user_account_id uuid REFERENCES user_accounts(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hire_process_id, card_key)
);
CREATE INDEX IF NOT EXISTS idx_hire_process_card_data_process ON hire_process_card_data (hire_process_id);

GRANT SELECT, INSERT, UPDATE ON
  core_employee_card_definitions, hire_processes, hire_process_cards, hire_process_card_data
  TO app_role;

ALTER TABLE core_employee_card_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE core_employee_card_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE hire_processes                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE hire_processes                 FORCE ROW LEVEL SECURITY;
ALTER TABLE hire_process_cards             ENABLE ROW LEVEL SECURITY;
ALTER TABLE hire_process_cards             FORCE ROW LEVEL SECURITY;
ALTER TABLE hire_process_card_data         ENABLE ROW LEVEL SECURITY;
ALTER TABLE hire_process_card_data         FORCE ROW LEVEL SECURITY;

CREATE POLICY core_employee_card_definitions_select ON core_employee_card_definitions FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY core_employee_card_definitions_insert ON core_employee_card_definitions FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY core_employee_card_definitions_update ON core_employee_card_definitions FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY hire_processes_select ON hire_processes FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY hire_processes_insert ON hire_processes FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY hire_processes_update ON hire_processes FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY hire_process_cards_select ON hire_process_cards FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY hire_process_cards_insert ON hire_process_cards FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY hire_process_cards_update ON hire_process_cards FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY hire_process_card_data_select ON hire_process_card_data FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY hire_process_card_data_insert ON hire_process_card_data FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY hire_process_card_data_update ON hire_process_card_data FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
