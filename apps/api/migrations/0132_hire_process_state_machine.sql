-- Gap Register CFG-08, CFG-09, CFG-10 (Step 5A). ADDITIVE.
--
--  CFG-08  hire_processes.status gains validation_required, submitted,
--          approved, rejected and failed. Every status change is checked
--          against an explicit transition graph by a trigger and written to
--          hire_process_status_history (who, from, to, why). New columns
--          failure_reason and idempotency_key (unique per company).
--  CFG-09  owner/delegate, expires_at (draft retention), last_validated_at +
--          validation state, hire reason, effective hire date, planned end
--          date, reserved employee number, and the configuration snapshot the
--          process was started under (config_snapshot + configuration_version_id).
--  CFG-10  hire_process_cards gain validation_state/errors, completed_at,
--          completed_by; hire_processes.current_card_key gets a real FK.
--
-- ROLLBACK: DROP TRIGGER trg_hire_process_status ON hire_processes; DROP
--   FUNCTION app.trg_hire_process_status(); DROP TABLE hire_process_status_history;
--   restore hire_processes_status_check to the five original values (first
--   UPDATE any validation_required/submitted/approved/rejected/failed rows to
--   in_progress/ready_for_completion); DROP the added columns, the FK
--   hire_processes_current_card_fk and idx_hire_processes_idempotency.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE hire_processes DROP CONSTRAINT IF EXISTS hire_processes_status_check;
ALTER TABLE hire_processes ADD CONSTRAINT hire_processes_status_check CHECK (status IN
  ('draft', 'in_progress', 'validation_required', 'ready_for_completion', 'submitted', 'approved', 'rejected', 'hired', 'failed', 'cancelled'));

ALTER TABLE hire_processes
  ADD COLUMN IF NOT EXISTS failure_reason text,
  ADD COLUMN IF NOT EXISTS failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS owner_user_account_id uuid REFERENCES user_accounts(id),
  ADD COLUMN IF NOT EXISTS delegate_user_account_id uuid REFERENCES user_accounts(id),
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_validated_at timestamptz,
  ADD COLUMN IF NOT EXISTS validation_state text NOT NULL DEFAULT 'unvalidated' CHECK (validation_state IN ('unvalidated', 'valid', 'invalid')),
  ADD COLUMN IF NOT EXISTS hire_reason_code text,
  ADD COLUMN IF NOT EXISTS hire_reason_catalog_item_id uuid REFERENCES hr_reference_catalog_items(id),
  ADD COLUMN IF NOT EXISTS effective_hire_date date,
  ADD COLUMN IF NOT EXISTS planned_end_date date,
  ADD COLUMN IF NOT EXISTS reserved_employee_number text,
  ADD COLUMN IF NOT EXISTS config_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS configuration_version_id uuid REFERENCES configuration_versions(id),
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS decided_by_user_account_id uuid REFERENCES user_accounts(id),
  ADD COLUMN IF NOT EXISTS decision_reason text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hire_processes_planned_end_check') THEN
    ALTER TABLE hire_processes ADD CONSTRAINT hire_processes_planned_end_check
      CHECK (planned_end_date IS NULL OR effective_hire_date IS NULL OR planned_end_date >= effective_hire_date);
  END IF;
END $$;

-- backfill: the creator owns existing processes; no snapshot is invented for old ones
UPDATE hire_processes SET owner_user_account_id = created_by_user_account_id WHERE owner_user_account_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_hire_processes_idempotency ON hire_processes (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hire_processes_owner ON hire_processes (company_id, owner_user_account_id) WHERE status NOT IN ('hired', 'cancelled');
CREATE INDEX IF NOT EXISTS idx_hire_processes_expiry ON hire_processes (expires_at) WHERE expires_at IS NOT NULL AND status IN ('draft', 'in_progress', 'validation_required', 'rejected');

-- ---------------------------------------------------------------- CFG-10
ALTER TABLE hire_process_cards
  ADD COLUMN IF NOT EXISTS validation_state text NOT NULL DEFAULT 'unvalidated' CHECK (validation_state IN ('unvalidated', 'valid', 'invalid')),
  ADD COLUMN IF NOT EXISTS validation_errors jsonb,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_by_user_account_id uuid REFERENCES user_accounts(id);

UPDATE hire_process_cards SET completed_at = COALESCE(saved_at, now()) WHERE status = 'complete' AND completed_at IS NULL;

-- current_card_key must name a real card definition of the same company
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hire_processes_current_card_fk') THEN
    ALTER TABLE hire_processes ADD CONSTRAINT hire_processes_current_card_fk
      FOREIGN KEY (company_id, current_card_key) REFERENCES core_employee_card_definitions (company_id, card_key) NOT VALID;
    BEGIN
      ALTER TABLE hire_processes VALIDATE CONSTRAINT hire_processes_current_card_fk;
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE NOTICE 'hire_processes_current_card_fk left NOT VALID: some existing rows point at a removed card definition';
    END;
  END IF;
END $$;

-- ---------------------------------------------------------------- CFG-08
CREATE TABLE IF NOT EXISTS hire_process_status_history (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  hire_process_id       uuid NOT NULL REFERENCES hire_processes(id) ON DELETE CASCADE,
  from_status           text,
  to_status             text NOT NULL,
  actor_user_account_id uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  reason                text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hire_status_history_process ON hire_process_status_history (hire_process_id, created_at);

ALTER TABLE hire_process_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE hire_process_status_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hire_status_history_select ON hire_process_status_history;
DROP POLICY IF EXISTS hire_status_history_insert ON hire_process_status_history;
CREATE POLICY hire_status_history_select ON hire_process_status_history FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY hire_status_history_insert ON hire_process_status_history FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
GRANT SELECT, INSERT ON hire_process_status_history TO app_role;

-- history is append-only
CREATE OR REPLACE FUNCTION app.trg_hire_status_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM hire_processes WHERE id = OLD.hire_process_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'hire process status history is append-only' USING ERRCODE = 'restrict_violation';
END $$;
DROP TRIGGER IF EXISTS trg_hire_status_history_immutable ON hire_process_status_history;
CREATE TRIGGER trg_hire_status_history_immutable BEFORE UPDATE OR DELETE ON hire_process_status_history
  FOR EACH ROW EXECUTE FUNCTION app.trg_hire_status_history_immutable();

-- Allowed transitions. Terminal states: hired, cancelled.
CREATE OR REPLACE FUNCTION app.hire_status_transition_allowed(p_from text, p_to text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_from
    WHEN 'draft'                THEN p_to IN ('in_progress', 'validation_required', 'ready_for_completion', 'cancelled')
    WHEN 'in_progress'          THEN p_to IN ('draft', 'validation_required', 'ready_for_completion', 'cancelled')
    WHEN 'validation_required'  THEN p_to IN ('in_progress', 'ready_for_completion', 'cancelled')
    WHEN 'ready_for_completion' THEN p_to IN ('in_progress', 'validation_required', 'submitted', 'hired', 'failed', 'cancelled')
    WHEN 'submitted'            THEN p_to IN ('approved', 'rejected', 'cancelled')
    WHEN 'approved'             THEN p_to IN ('hired', 'failed', 'in_progress', 'cancelled')
    WHEN 'rejected'             THEN p_to IN ('in_progress', 'cancelled')
    WHEN 'failed'               THEN p_to IN ('in_progress', 'ready_for_completion', 'hired', 'cancelled')
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION app.trg_hire_process_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  claims jsonb := COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
  actor uuid;
  why text := NULLIF(current_setting('app.hire_status_reason', true), '');
BEGIN
  IF (claims ->> 'sub') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT id INTO actor FROM user_accounts WHERE id = (claims ->> 'sub')::uuid;
  END IF;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO hire_process_status_history (company_id, hire_process_id, from_status, to_status, actor_user_account_id, reason)
    VALUES (NEW.company_id, NEW.id, NULL, NEW.status, actor, why);
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT app.hire_status_transition_allowed(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'hire process cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO hire_process_status_history (company_id, hire_process_id, from_status, to_status, actor_user_account_id, reason)
    VALUES (NEW.company_id, NEW.id, OLD.status, NEW.status, actor, COALESCE(why, NEW.failure_reason, NEW.decision_reason));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_hire_process_status ON hire_processes;
CREATE TRIGGER trg_hire_process_status AFTER INSERT OR UPDATE OF status ON hire_processes
  FOR EACH ROW EXECUTE FUNCTION app.trg_hire_process_status();

-- hire reason resolves to the lifecycle_reason:hire catalog like job-history reasons do
CREATE OR REPLACE FUNCTION app.trg_hire_process_reason() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hire_reason_code IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.hire_reason_code IS DISTINCT FROM OLD.hire_reason_code) THEN
    NEW.hire_reason_catalog_item_id := app.resolve_catalog_item(NEW.company_id, 'lifecycle_reason:hire', NEW.hire_reason_code);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_hire_process_reason ON hire_processes;
CREATE TRIGGER trg_hire_process_reason BEFORE INSERT OR UPDATE OF hire_reason_code ON hire_processes
  FOR EACH ROW EXECUTE FUNCTION app.trg_hire_process_reason();

-- backfill one history row per existing process (current state only; earlier steps were not recorded)
INSERT INTO hire_process_status_history (company_id, hire_process_id, from_status, to_status, reason, created_at)
SELECT p.company_id, p.id, NULL, p.status, 'backfilled at migration 0132', p.created_at
  FROM hire_processes p
 WHERE NOT EXISTS (SELECT 1 FROM hire_process_status_history h WHERE h.hire_process_id = p.id);
