-- Gap Register ORG-01, ORG-02, ORG-03, ORG-06, ORG-07, ORG-09, ORG-18 (Step 7). ADDITIVE.
--
--  ORG-09  org_reconciliation_runs / org_reconciliation_items: every backfill or
--          drift-repair run (dry-run or applied) and the per-record outcome,
--          including the unresolved-mapping log (no match / ambiguous / fuzzy only).
--  ORG-03  same tables hold projection-drift repairs (employees.* vs the open
--          primary assignment).
--  ORG-02  position_incumbents (employee, fte, dates), position_budgets (per
--          fiscal year), position_relationships (reports_to / dotted_line);
--          positions + position_versions accept 'pending_approval' / 'rejected'
--          so position creation can be routed through the workflow engine;
--          positions.workflow_instance_id.
--  ORG-01  job_requisitions: position_id, org_unit_id, job_id, location_id,
--          filled_headcount, hold/open/filled/cancelled statuses; unambiguous
--          org_unit_id backfill from the department text.
--  ORG-07  org_change_items: entity_type / entity_id / payload so a reorganization
--          can batch positions, locations, cost / profit centers and assignments;
--          org_unit_id becomes nullable for non-unit items; failed batches can be
--          resumed (applied items are skipped).
--  ORG-06  event_consumer_receipts: per-consumer idempotency ledger for the
--          internal consumers of the org domain events (domain_events outbox).
--          workflow_step_approvals.org_unit_id lets pending org_unit_head lines
--          be re-resolved after an organization change.
--  ORG-18  case-insensitive code uniqueness per company, created only where no
--          duplicates exist today (a NOTICE names any table skipped).
--
-- ROLLBACK: DROP TABLE org_reconciliation_items, org_reconciliation_runs,
--   position_incumbents, position_budgets, position_relationships,
--   event_consumer_receipts; ALTER TABLE ... DROP the columns added below;
--   restore positions/position_versions status CHECK (vacant|filled|frozen|abolished),
--   job_requisitions status CHECK (draft|pending_approval|approved|rejected|closed),
--   org_change_items action CHECK (move|rename|retype|archive|activate) and
--   org_change_items.org_unit_id NOT NULL (only if no non-unit items exist);
--   DROP INDEX the idx_*_code_ci indexes.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- ------------------------------------------------------------ reconciliation log (ORG-09 / ORG-03)
CREATE TABLE IF NOT EXISTS org_reconciliation_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('legacy_backfill', 'projection_drift')),
  dry_run             boolean NOT NULL,
  status              text NOT NULL DEFAULT 'completed' CHECK (status IN ('running', 'completed', 'failed')),
  started_by_user_account_id uuid REFERENCES user_accounts(id),
  counts              jsonb NOT NULL DEFAULT '{}'::jsonb,
  error               text,
  started_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz
);
CREATE INDEX IF NOT EXISTS idx_org_recon_runs_company ON org_reconciliation_runs (company_id, started_at DESC);

CREATE TABLE IF NOT EXISTS org_reconciliation_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid NOT NULL REFERENCES org_reconciliation_runs(id) ON DELETE CASCADE,
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id    uuid REFERENCES employees(id) ON DELETE CASCADE,
  gap_type       text NOT NULL,
  legacy_value   text,
  outcome        text NOT NULL CHECK (outcome IN ('applied', 'would_apply', 'unresolved', 'failed')),
  reason         text,
  target_id      uuid,
  details        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_org_recon_items_run ON org_reconciliation_items (run_id);
CREATE INDEX IF NOT EXISTS idx_org_recon_items_unresolved ON org_reconciliation_items (company_id, gap_type) WHERE outcome = 'unresolved';

-- ------------------------------------------------------------ positions (ORG-02)
ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_status_check;
ALTER TABLE positions ADD CONSTRAINT positions_status_check
  CHECK (status IN ('vacant', 'filled', 'frozen', 'abolished', 'pending_approval', 'rejected'));
ALTER TABLE position_versions DROP CONSTRAINT IF EXISTS position_versions_status_check;
ALTER TABLE position_versions ADD CONSTRAINT position_versions_status_check
  CHECK (status IN ('vacant', 'filled', 'frozen', 'abolished', 'pending_approval', 'rejected'));
ALTER TABLE positions ADD COLUMN IF NOT EXISTS workflow_instance_id uuid REFERENCES workflow_instances(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS position_incumbents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  position_id     uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  fte             numeric(5,2) NOT NULL DEFAULT 1 CHECK (fte > 0 AND fte <= 1),
  effective_from  date NOT NULL DEFAULT CURRENT_DATE,
  effective_to    date,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT position_incumbents_window CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT position_incumbents_status_consistent CHECK ((status = 'ended') = (effective_to IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_position_incumbents_one_active ON position_incumbents (position_id, employee_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_position_incumbents_employee ON position_incumbents (employee_id) WHERE status = 'active';

-- backfill from the single-seat projection (idempotent: skipped where an active row exists)
INSERT INTO position_incumbents (company_id, position_id, employee_id, fte, effective_from)
SELECT e.company_id, e.position_id, e.id, LEAST(1, p.headcount_fte), COALESCE(e.date_of_joining, CURRENT_DATE)
  FROM employees e JOIN positions p ON p.id = e.position_id
 WHERE e.position_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM position_incumbents i WHERE i.position_id = e.position_id AND i.employee_id = e.id AND i.status = 'active');

CREATE TABLE IF NOT EXISTS position_budgets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  position_id         uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  fiscal_year         integer NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2100),
  planned_headcount   numeric(6,2) NOT NULL CHECK (planned_headcount >= 0),
  budget_amount       numeric(14,2) CHECK (budget_amount IS NULL OR budget_amount >= 0),
  currency            text NOT NULL DEFAULT 'PKR',
  notes               text,
  created_by_user_account_id uuid REFERENCES user_accounts(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (position_id, fiscal_year)
);
CREATE INDEX IF NOT EXISTS idx_position_budgets_company_year ON position_budgets (company_id, fiscal_year);

CREATE TABLE IF NOT EXISTS position_relationships (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  position_id          uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  related_position_id  uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  relationship_type    text NOT NULL CHECK (relationship_type IN ('reports_to', 'dotted_line')),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  effective_from       date NOT NULL DEFAULT CURRENT_DATE,
  effective_to         date,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT position_relationships_not_self CHECK (position_id <> related_position_id),
  CONSTRAINT position_relationships_status_consistent CHECK ((status = 'ended') = (effective_to IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_position_relationships_one_reports_to
  ON position_relationships (position_id) WHERE relationship_type = 'reports_to' AND status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_position_relationships_one_dotted
  ON position_relationships (position_id, related_position_id) WHERE relationship_type = 'dotted_line' AND status = 'active';

-- ------------------------------------------------------------ requisitions (ORG-01)
ALTER TABLE job_requisitions
  ADD COLUMN IF NOT EXISTS position_id uuid REFERENCES positions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS org_unit_id uuid REFERENCES org_units(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES jobs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES locations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS filled_headcount integer NOT NULL DEFAULT 0 CHECK (filled_headcount >= 0),
  ADD COLUMN IF NOT EXISTS status_reason text;
ALTER TABLE job_requisitions DROP CONSTRAINT IF EXISTS job_requisitions_status_check;
ALTER TABLE job_requisitions ADD CONSTRAINT job_requisitions_status_check
  CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected', 'closed', 'open', 'on_hold', 'filled', 'cancelled'));
CREATE INDEX IF NOT EXISTS idx_job_requisitions_position ON job_requisitions (position_id) WHERE position_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_requisitions_org_unit ON job_requisitions (org_unit_id) WHERE org_unit_id IS NOT NULL;

-- unambiguous-only backfill: the department text equals exactly one active org unit name (case-insensitive)
UPDATE job_requisitions r
   SET org_unit_id = m.unit_id
  FROM (
    SELECT r2.id AS req_id, (array_agg(u.id))[1] AS unit_id
      FROM job_requisitions r2
      JOIN org_units u ON u.company_id = r2.company_id AND lower(trim(u.name)) = lower(trim(r2.department)) AND u.status <> 'archived'
     WHERE r2.org_unit_id IS NULL AND r2.department IS NOT NULL AND trim(r2.department) <> ''
     GROUP BY r2.id
    HAVING count(*) = 1
  ) m
 WHERE r.id = m.req_id;

-- ------------------------------------------------------------ reorganization items (ORG-07)
ALTER TABLE org_change_items
  ADD COLUMN IF NOT EXISTS entity_type text NOT NULL DEFAULT 'org_unit'
    CHECK (entity_type IN ('org_unit', 'position', 'location', 'cost_center', 'profit_center', 'assignment')),
  ADD COLUMN IF NOT EXISTS entity_id uuid,
  ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS failure_reason text;
UPDATE org_change_items SET entity_id = org_unit_id WHERE entity_id IS NULL AND org_unit_id IS NOT NULL;
ALTER TABLE org_change_items ALTER COLUMN org_unit_id DROP NOT NULL;
ALTER TABLE org_change_items DROP CONSTRAINT IF EXISTS org_change_items_action_check;
ALTER TABLE org_change_items ADD CONSTRAINT org_change_items_action_check CHECK (action IN (
  'move', 'rename', 'retype', 'archive', 'activate',
  'position_freeze', 'position_unfreeze', 'position_abolish', 'position_reactivate', 'position_rename', 'position_move',
  'location_rename', 'location_archive', 'location_activate',
  'cost_center_rename', 'cost_center_archive', 'cost_center_activate',
  'profit_center_rename', 'profit_center_archive', 'profit_center_activate',
  'assignment_transfer'));
ALTER TABLE org_change_items DROP CONSTRAINT IF EXISTS org_change_items_entity_consistent;
ALTER TABLE org_change_items ADD CONSTRAINT org_change_items_entity_consistent CHECK (
  (entity_type = 'org_unit' AND org_unit_id IS NOT NULL) OR (entity_type <> 'org_unit' AND entity_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_org_change_items_entity ON org_change_items (entity_type, entity_id);

-- ------------------------------------------------------------ consumers (ORG-06)
CREATE TABLE IF NOT EXISTS event_consumer_receipts (
  consumer      text NOT NULL,
  event_id      uuid NOT NULL REFERENCES domain_events(id) ON DELETE CASCADE,
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'done' CHECK (status IN ('done', 'failed')),
  attempts      integer NOT NULL DEFAULT 1,
  error         text,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
CREATE INDEX IF NOT EXISTS idx_event_consumer_receipts_failed ON event_consumer_receipts (consumer) WHERE status = 'failed';

ALTER TABLE workflow_step_approvals ADD COLUMN IF NOT EXISTS org_unit_id uuid REFERENCES org_units(id) ON DELETE SET NULL;

-- ------------------------------------------------------------ RLS + grants
GRANT SELECT, INSERT, UPDATE, DELETE ON org_reconciliation_runs, org_reconciliation_items, position_incumbents,
  position_budgets, position_relationships, event_consumer_receipts TO app_role;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['org_reconciliation_runs', 'org_reconciliation_items', 'position_incumbents', 'position_budgets',
                           'position_relationships', 'event_consumer_receipts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = t::regclass AND p.polname = t || '_all') THEN
      EXECUTE format($p$CREATE POLICY %I ON %I FOR ALL
        USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
        WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())$p$, t || '_all', t);
    END IF;
  END LOOP;
END $$;

-- ------------------------------------------------------------ ORG-18 case-insensitive code uniqueness
DO $$
DECLARE
  spec record;
  dupes integer;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('org_units', 'code', 'idx_org_units_code_ci'),
      ('positions', 'position_code', 'idx_positions_code_ci'),
      ('locations', 'code', 'idx_locations_code_ci'),
      ('cost_centers', 'code', 'idx_cost_centers_code_ci'),
      ('profit_centers', 'code', 'idx_profit_centers_code_ci'),
      ('jobs', 'job_code', 'idx_jobs_code_ci')
    ) v(tbl, col, idx)
  LOOP
    EXECUTE format('SELECT count(*) FROM (SELECT 1 FROM %I WHERE %I IS NOT NULL GROUP BY company_id, lower(%I) HAVING count(*) > 1) d',
                   spec.tbl, spec.col, spec.col) INTO dupes;
    IF dupes > 0 THEN
      RAISE NOTICE 'ORG-18: % has % case-insensitive duplicate code group(s) per company; % not created - fix the data and re-run', spec.tbl, dupes, spec.idx;
    ELSE
      EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (company_id, lower(%I)) WHERE %I IS NOT NULL', spec.idx, spec.tbl, spec.col, spec.col);
    END IF;
  END LOOP;
END $$;
