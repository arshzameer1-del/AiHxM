-- Gap Register CFG-13 (Step 5C). ADDITIVE.
--
--   employee_number_policy   per-company rules: when a number is generated
--                            (hire | draft | save | approval), series reset
--                            (never | yearly), whether manual / imported
--                            numbers are accepted and their allowed pattern.
--   employee_number_series   one counter per (company, series); series ''
--                            continues the legacy employee_number_sequences.
--   employee_numbers         LEDGER of every number ever seen: reserved ->
--                            issued, or reserved -> void. A number is never
--                            reused: UNIQUE (company_id, employee_number) holds
--                            for void rows too. A trigger on employees keeps the
--                            ledger complete (manual / imported numbers are
--                            recorded as issued) and refuses a number that is
--                            void or reserved for a different hire process.
--   [VERIFY] UNIQUE (company_id, employee_number) on employees EXISTS
--            (employees_company_id_employee_number_key).
--
-- ROLLBACK: DROP TRIGGER trg_employee_number_ledger_* ON employees; DROP
--   FUNCTIONs app.trg_employee_number_ledger_before/after; DROP TABLE
--   employee_numbers, employee_number_series, employee_number_policy;
--   DELETE FROM configuration_registry WHERE domain_key = 'employee_numbering'.
--   The legacy employee_number_sequences table is untouched throughout.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

CREATE TABLE IF NOT EXISTS employee_number_policy (
  company_id          uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  generation_timing   text NOT NULL DEFAULT 'hire' CHECK (generation_timing IN ('hire', 'draft', 'save', 'approval')),
  uniqueness_scope    text NOT NULL DEFAULT 'company' CHECK (uniqueness_scope IN ('company')),
  reset_policy        text NOT NULL DEFAULT 'never' CHECK (reset_policy IN ('never', 'yearly')),
  allow_manual        boolean NOT NULL DEFAULT true,
  manual_pattern      text NOT NULL DEFAULT '^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$',
  updated_by_user_account_id uuid REFERENCES user_accounts(id),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS employee_number_series (
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  series_key    text NOT NULL,
  next_sequence integer NOT NULL DEFAULT 1 CHECK (next_sequence >= 1),
  PRIMARY KEY (company_id, series_key)
);

CREATE TABLE IF NOT EXISTS employee_numbers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_number       text NOT NULL,
  state                 text NOT NULL DEFAULT 'issued' CHECK (state IN ('reserved', 'issued', 'void')),
  series_key            text NOT NULL DEFAULT '',
  sequence_no           integer,
  source                text NOT NULL DEFAULT 'generated' CHECK (source IN ('generated', 'manual', 'imported', 'backfill')),
  hire_process_id       uuid REFERENCES hire_processes(id) ON DELETE SET NULL,
  employee_id           uuid REFERENCES employees(id) ON DELETE SET NULL,
  reserved_at           timestamptz,
  issued_at             timestamptz,
  voided_at             timestamptz,
  void_reason           text,
  created_by_user_account_id uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_numbers_unique UNIQUE (company_id, employee_number),
  CONSTRAINT employee_numbers_void_has_reason CHECK (state <> 'void' OR voided_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_employee_numbers_process ON employee_numbers (hire_process_id) WHERE hire_process_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employee_numbers_employee ON employee_numbers (employee_id) WHERE employee_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employee_number_policy', 'employee_number_series', 'employee_numbers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format($p$CREATE POLICY %I ON %I
      USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
      WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())$p$, t || '_all', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON employee_number_policy, employee_number_series, employee_numbers TO app_role;

-- the ledger is never deleted from (cascade from a deleted company/employee row aside)
CREATE OR REPLACE FUNCTION app.trg_employee_numbers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.employee_number <> OLD.employee_number OR NEW.company_id <> OLD.company_id THEN
      RAISE EXCEPTION 'an employee number cannot be renamed; void it and issue another' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.state = 'void' AND NEW.state <> 'void' THEN
      RAISE EXCEPTION 'a voided employee number is never reused' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.state = 'issued' AND NEW.state <> 'issued' THEN
      RAISE EXCEPTION 'an issued employee number cannot go back to %', NEW.state USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_employee_numbers_guard ON employee_numbers;
CREATE TRIGGER trg_employee_numbers_guard BEFORE UPDATE ON employee_numbers
  FOR EACH ROW EXECUTE FUNCTION app.trg_employee_numbers_guard();

-- ------------------------------------------------------------ backfill
-- every existing employee number is recorded as issued (re-runnable)
INSERT INTO employee_numbers (company_id, employee_number, state, source, employee_id, issued_at)
SELECT e.company_id, e.employee_number, 'issued', 'backfill', e.id, e.created_at
  FROM employees e
 WHERE e.employee_number IS NOT NULL
ON CONFLICT (company_id, employee_number) DO NOTHING;

-- legacy counters become the '' series
INSERT INTO employee_number_series (company_id, series_key, next_sequence)
SELECT company_id, '', next_sequence FROM employee_number_sequences
ON CONFLICT (company_id, series_key) DO NOTHING;

-- ------------------------------------------------------------ employees triggers
-- BEFORE: refuse void numbers and numbers reserved for another hire process.
CREATE OR REPLACE FUNCTION app.trg_employee_number_ledger_before() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE
  led employee_numbers%ROWTYPE;
  proc text := NULLIF(current_setting('app.hire_process_id', true), '');
BEGIN
  IF NEW.employee_number IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.employee_number = OLD.employee_number THEN RETURN NEW; END IF;
  SELECT * INTO led FROM employee_numbers WHERE company_id = NEW.company_id AND employee_number = NEW.employee_number;
  IF FOUND THEN
    IF led.state = 'void' THEN
      RAISE EXCEPTION 'employee number % was voided and is never reused', NEW.employee_number USING ERRCODE = 'unique_violation';
    END IF;
    IF led.state = 'reserved' AND led.hire_process_id IS NOT NULL AND led.hire_process_id::text IS DISTINCT FROM proc THEN
      RAISE EXCEPTION 'employee number % is reserved for another hiring process', NEW.employee_number USING ERRCODE = 'unique_violation';
    END IF;
    IF led.state = 'issued' AND led.employee_id IS NOT NULL AND led.employee_id <> NEW.id THEN
      RAISE EXCEPTION 'employee number % was already issued', NEW.employee_number USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- AFTER: keep the ledger complete (manual / imported numbers are recorded as issued).
CREATE OR REPLACE FUNCTION app.trg_employee_number_ledger_after() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
BEGIN
  IF NEW.employee_number IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.employee_number = OLD.employee_number THEN RETURN NEW; END IF;
  INSERT INTO employee_numbers (company_id, employee_number, state, source, employee_id, issued_at)
  VALUES (NEW.company_id, NEW.employee_number, 'issued', 'manual', NEW.id, now())
  ON CONFLICT (company_id, employee_number) DO UPDATE
    SET state = 'issued', employee_id = EXCLUDED.employee_id, issued_at = now()
    WHERE employee_numbers.state = 'reserved';
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_employee_number_ledger_before ON employees;
CREATE TRIGGER trg_employee_number_ledger_before BEFORE INSERT OR UPDATE OF employee_number ON employees
  FOR EACH ROW EXECUTE FUNCTION app.trg_employee_number_ledger_before();
DROP TRIGGER IF EXISTS trg_employee_number_ledger_after ON employees;
CREATE TRIGGER trg_employee_number_ledger_after AFTER INSERT OR UPDATE OF employee_number ON employees
  FOR EACH ROW EXECUTE FUNCTION app.trg_employee_number_ledger_after();

-- ------------------------------------------------------------ registration
INSERT INTO configuration_registry (domain_key, label, description, manage_permission, view_permission, admin_route, supports_effective_dating, sort_order, layer, owner_module, is_versioned, show_in_center)
VALUES ('employee_numbering', 'Employee numbering', 'When employee numbers are generated, series reset, manual numbers and the issued-number ledger.',
        'employee.manage.all', 'employee.manage.all', '/app/configuration-center/employee-numbering', false, 14, 'configuration', 'employee', false, true)
ON CONFLICT (domain_key) DO NOTHING;
