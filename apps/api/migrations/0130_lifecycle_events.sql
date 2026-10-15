-- Gap Register LIF-01, LIF-02, LIF-03, LIF-04, LIF-05, LIF-06, LIF-07, LIF-08 (Step 4C/4D).
-- ADDITIVE: no existing column or row is changed (job-history rows are only
-- READ by the backfill). employee_job_history stays what it was - a projection.
--
--  LIF-01  employee_lifecycle_events: one row per lifecycle action with the
--          employee, action type, reason (text + catalog id), effective date,
--          planned end date, status (scheduled | applied | failed | cancelled),
--          the request payload, before/after snapshots, an optional workflow
--          instance, the event it corrects, the channel it came from and the
--          job-history row it produced. Rows are IMMUTABLE once applied or
--          cancelled; only scheduled/failed rows may change state.
--  LIF-02  employee_job_history gains canonical id columns (org unit, position,
--          job, location, manager, cost centre) filled by trigger from the
--          employee's state at insert time - going forward only.
--  LIF-03  future-dated actions are stored 'scheduled' and executed on their
--          effective date by EmployeeLifecycleScheduler (partial index below).
--  LIF-04  a correction is a NEW event whose corrects_event_id points at the
--          original; the original is never rewritten.
--  LIF-05  employee_offboarding gains notice period, rehire eligibility, exit
--          interview and a link to the termination event it produced.
--  LIF-06  rehire eligibility lives on the offboarding record and is enforced
--          by EmployeesService / EmployeeLifecycleService.reactivate.
--  LIF-07  hire_processes.employee_id is unique (hire completion exactly once)
--          - created only if the existing data has no duplicates.
--  LIF-08  hire_processes.workflow_instance_id and offers.hire_process_id.
--
-- Backfill: every existing job-history row gets an 'applied' event
-- (source_channel 'backfill') so the event stream is complete from day one.
--
-- ROLLBACK: DROP TABLE employee_lifecycle_events (and functions
--   app.trg_lifecycle_event_guard / app.fill_job_history_canonical, trigger
--   trg_job_history_canonical); ALTER TABLE employee_job_history DROP the six
--   added id columns; ALTER TABLE employee_offboarding DROP notice_period_days,
--   notice_start_date, rehire_eligibility, rehire_eligibility_note,
--   exit_interview_status, exit_interview_completed_at, exit_interview_notes,
--   termination_event_id, reason_code; ALTER TABLE hire_processes DROP
--   workflow_instance_id; DROP INDEX idx_hire_processes_employee_unique;
--   ALTER TABLE offers DROP hire_process_id.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- ------------------------------------------------------------- LIF-01
CREATE TABLE IF NOT EXISTS employee_lifecycle_events (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                 uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  employment_id               uuid REFERENCES employments(id) ON DELETE SET NULL,
  action_type                 text NOT NULL CHECK (action_type ~ '^[a-z][a-z0-9_]{1,40}$'),
  reason_code                 text,
  reason_catalog_item_id      uuid REFERENCES hr_reference_catalog_items(id),
  effective_date              date NOT NULL,
  planned_end_date            date,
  status                      text NOT NULL DEFAULT 'applied' CHECK (status IN ('scheduled', 'applied', 'failed', 'cancelled')),
  payload                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  before_snapshot             jsonb,
  after_snapshot              jsonb,
  workflow_instance_id        uuid REFERENCES workflow_instances(id) ON DELETE SET NULL,
  corrects_event_id           uuid REFERENCES employee_lifecycle_events(id),
  source_channel              text NOT NULL DEFAULT 'api'
                              CHECK (source_channel IN ('ui', 'api', 'hire_process', 'offboarding', 'scheduler', 'bulk_import', 'system', 'backfill')),
  requested_by_user_account_id uuid REFERENCES user_accounts(id),
  job_history_id              uuid REFERENCES employee_job_history(id) ON DELETE SET NULL,
  notes                       text,
  failure_reason              text,
  applied_at                  timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lifecycle_events_planned_end CHECK (planned_end_date IS NULL OR planned_end_date >= effective_date)
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_employee ON employee_lifecycle_events (employee_id, effective_date DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_company ON employee_lifecycle_events (company_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_due ON employee_lifecycle_events (company_id, effective_date) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_corrects ON employee_lifecycle_events (corrects_event_id) WHERE corrects_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_reason_item ON employee_lifecycle_events (reason_catalog_item_id) WHERE reason_catalog_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_workflow ON employee_lifecycle_events (workflow_instance_id) WHERE workflow_instance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_job_history ON employee_lifecycle_events (job_history_id) WHERE job_history_id IS NOT NULL;

ALTER TABLE employee_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_lifecycle_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS employee_lifecycle_events_select ON employee_lifecycle_events;
DROP POLICY IF EXISTS employee_lifecycle_events_insert ON employee_lifecycle_events;
DROP POLICY IF EXISTS employee_lifecycle_events_update ON employee_lifecycle_events;
CREATE POLICY employee_lifecycle_events_select ON employee_lifecycle_events FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_lifecycle_events_insert ON employee_lifecycle_events FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_lifecycle_events_update ON employee_lifecycle_events FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
GRANT SELECT, INSERT, UPDATE ON employee_lifecycle_events TO app_role;

-- reason catalog: resolved from the action type, like job-history reasons
CREATE OR REPLACE FUNCTION app.trg_lifecycle_event_fill() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ctype text;
BEGIN
  IF NEW.reason_catalog_item_id IS NULL AND NEW.reason_code IS NOT NULL THEN
    ctype := CASE NEW.action_type
      WHEN 'acting' THEN 'lifecycle_reason:acting_assignment'
      WHEN 'salary_change' THEN 'lifecycle_reason:compensation_change'
      WHEN 'reactivation' THEN 'lifecycle_reason:return_from_leave'
      WHEN 'position_assignment' THEN 'lifecycle_reason:position_change'
      WHEN 'correction' THEN NULL
      WHEN 'other' THEN NULL
      ELSE 'lifecycle_reason:' || NEW.action_type
    END;
    IF ctype IS NOT NULL THEN
      NEW.reason_catalog_item_id := app.resolve_catalog_item(NEW.company_id, ctype, NEW.reason_code);
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.trg_lifecycle_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- cascades from a deleted employee/company are allowed; direct deletes are not
    IF EXISTS (SELECT 1 FROM employees WHERE id = OLD.employee_id) THEN
      RAISE EXCEPTION 'lifecycle events are never deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('applied', 'cancelled') THEN
    RAISE EXCEPTION 'lifecycle event % is % and can no longer change; record a correction instead', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.employee_id <> OLD.employee_id OR NEW.action_type <> OLD.action_type
     OR NEW.corrects_event_id IS DISTINCT FROM OLD.corrects_event_id THEN
    RAISE EXCEPTION 'lifecycle event identity cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_lifecycle_event_fill ON employee_lifecycle_events;
CREATE TRIGGER trg_lifecycle_event_fill BEFORE INSERT OR UPDATE ON employee_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION app.trg_lifecycle_event_fill();
DROP TRIGGER IF EXISTS trg_lifecycle_event_guard ON employee_lifecycle_events;
CREATE TRIGGER trg_lifecycle_event_guard BEFORE UPDATE OR DELETE ON employee_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION app.trg_lifecycle_event_guard();

-- ------------------------------------------------------------- LIF-02
ALTER TABLE employee_job_history
  ADD COLUMN IF NOT EXISTS org_unit_id    uuid REFERENCES org_units(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS position_id    uuid REFERENCES positions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS job_id         uuid REFERENCES jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS location_id    uuid REFERENCES locations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS manager_id     uuid REFERENCES employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cost_center_id uuid REFERENCES cost_centers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_job_history_org_unit ON employee_job_history (org_unit_id) WHERE org_unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_history_position ON employee_job_history (position_id) WHERE position_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_history_job ON employee_job_history (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_history_location ON employee_job_history (location_id) WHERE location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_history_manager ON employee_job_history (manager_id) WHERE manager_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_history_cost_center ON employee_job_history (cost_center_id) WHERE cost_center_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app.fill_job_history_canonical() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  e record;
  p record;
BEGIN
  SELECT org_unit_id, position_id, location_id, manager_id INTO e FROM employees WHERE id = NEW.employee_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  NEW.org_unit_id := COALESCE(NEW.org_unit_id, e.org_unit_id);
  NEW.position_id := COALESCE(NEW.position_id, e.position_id);
  NEW.location_id := COALESCE(NEW.location_id, e.location_id);
  NEW.manager_id  := COALESCE(NEW.manager_id, e.manager_id);
  IF NEW.position_id IS NOT NULL AND (NEW.job_id IS NULL OR NEW.cost_center_id IS NULL) THEN
    SELECT job_id, cost_center_id INTO p FROM positions WHERE id = NEW.position_id;
    NEW.job_id := COALESCE(NEW.job_id, p.job_id);
    NEW.cost_center_id := COALESCE(NEW.cost_center_id, p.cost_center_id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_job_history_canonical ON employee_job_history;
CREATE TRIGGER trg_job_history_canonical BEFORE INSERT ON employee_job_history
  FOR EACH ROW EXECUTE FUNCTION app.fill_job_history_canonical();

-- backfill the event stream from existing job history (canonical ids stay NULL on old rows)
INSERT INTO employee_lifecycle_events (company_id, employee_id, employment_id, action_type, reason_code, effective_date, planned_end_date,
    status, notes, source_channel, requested_by_user_account_id, job_history_id, applied_at, created_at)
SELECT jh.company_id, jh.employee_id, e.employment_id, jh.event_type, jh.reason_code, jh.effective_date, jh.end_date,
       'applied', jh.notes, 'backfill', jh.recorded_by_user_account_id, jh.id, jh.created_at, jh.created_at
  FROM employee_job_history jh
  JOIN employees e ON e.id = jh.employee_id
 WHERE NOT EXISTS (SELECT 1 FROM employee_lifecycle_events x WHERE x.job_history_id = jh.id);

-- ------------------------------------------------------------- LIF-05 / LIF-06
ALTER TABLE employee_offboarding
  ADD COLUMN IF NOT EXISTS reason_code                 text,
  ADD COLUMN IF NOT EXISTS notice_period_days          integer CHECK (notice_period_days IS NULL OR notice_period_days >= 0),
  ADD COLUMN IF NOT EXISTS notice_start_date           date,
  ADD COLUMN IF NOT EXISTS rehire_eligibility          text CHECK (rehire_eligibility IS NULL OR rehire_eligibility IN ('eligible', 'conditional', 'not_eligible')),
  ADD COLUMN IF NOT EXISTS rehire_eligibility_note     text,
  ADD COLUMN IF NOT EXISTS exit_interview_status       text NOT NULL DEFAULT 'not_required'
                           CHECK (exit_interview_status IN ('not_required', 'pending', 'completed', 'declined')),
  ADD COLUMN IF NOT EXISTS exit_interview_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS exit_interview_notes        text,
  ADD COLUMN IF NOT EXISTS termination_event_id        uuid REFERENCES employee_lifecycle_events(id);
CREATE INDEX IF NOT EXISTS idx_offboarding_termination_event ON employee_offboarding (termination_event_id) WHERE termination_event_id IS NOT NULL;

-- ------------------------------------------------------------- LIF-07 / LIF-08
ALTER TABLE hire_processes ADD COLUMN IF NOT EXISTS workflow_instance_id uuid REFERENCES workflow_instances(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_hire_processes_workflow ON hire_processes (workflow_instance_id) WHERE workflow_instance_id IS NOT NULL;

ALTER TABLE offers ADD COLUMN IF NOT EXISTS hire_process_id uuid REFERENCES hire_processes(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_offers_hire_process ON offers (hire_process_id) WHERE hire_process_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM hire_processes WHERE employee_id IS NOT NULL GROUP BY employee_id HAVING count(*) > 1) THEN
    RAISE WARNING 'LIF-07: hire_processes has employees linked to more than one hire process; the unique index was NOT created. Resolve the duplicates (SELECT employee_id, count(*) FROM hire_processes WHERE employee_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1) and re-run: CREATE UNIQUE INDEX idx_hire_processes_employee_unique ON hire_processes (employee_id) WHERE employee_id IS NOT NULL;';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hire_processes_employee_unique ON hire_processes (employee_id) WHERE employee_id IS NOT NULL;
  END IF;
END $$;

-- link offers to the hire process that hired them (only where unambiguous)
UPDATE offers o SET hire_process_id = h.id
  FROM hire_processes h
 WHERE o.hire_process_id IS NULL AND o.hired_employee_id IS NOT NULL AND h.employee_id = o.hired_employee_id
   AND (SELECT count(*) FROM hire_processes h2 WHERE h2.employee_id = o.hired_employee_id) = 1;
