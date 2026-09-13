-- Phase 7 — Employee Core
--
-- The first real HR object. Everything from Phase 1 through Phase 6 was
-- infrastructure this phase now actually uses: `employee` was already a
-- licensed module (0006_module_entitlement.sql), the RBAC/field-permission
-- engine (0004_rbac.sql) now protects real sensitive fields (CNIC, salary
-- band, bank account, date of birth, termination reason) instead of a
-- dummy_records placeholder, and the WRICEF workflow/custom-field engines
-- (0007-0009) are available to any future employee-facing feature that
-- needs them (a profile-change approval, a custom field on the employee
-- object) without this migration needing to know about either.
--
-- Employee Number (plan doc Section 5): `employees.employee_number` is the
-- human-facing business key, `employees.id` (uuid) is the technical key —
-- never the same field, per Section 5's own opening rule. The format
-- (prefix/padding/startingSequence) was already captured at company-
-- creation time in `company_config.employee_number_format` (Phase 1/2);
-- this migration adds the missing piece — an actual atomic counter to
-- assign from.
--
-- That counter is a DEDICATED table, deliberately NOT a new column on
-- `company_config`, for an RLS reason discovered while building this:
-- Postgres treats `SELECT ... FOR UPDATE` under row-level security as
-- requiring the table's UPDATE policy (not just its SELECT policy) to
-- pass, because a row lock is "like performing a trivial update." Every
-- real employee hire needs to atomically increment this counter from an
-- ordinary tenant HR Admin session — but `company_config`'s own UPDATE
-- policy (0001_platform_admin_core.sql) is deliberately Platform-Admin-
-- only, since branding/module-format settings there are still real
-- config, not something to open up to every tenant session just to fix
-- a locking problem. `employee_number_sequences` holds nothing but an
-- operational counter — a tenant incrementing their own sequence value
-- carries none of that risk, so it gets its own, more permissive RLS
-- write policy below instead of loosening company_config's.
CREATE TABLE IF NOT EXISTS employee_number_sequences (
  company_id     uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  next_sequence  integer NOT NULL DEFAULT 1
);

-- ---------------------------------------------------------------------
-- employees — the org chart + master data object
-- ---------------------------------------------------------------------
-- `manager_id` is a self-reference (org chart edge) rather than a
-- separate table — this is Section 5's "Person"/"Employment" split
-- deliberately NOT built yet (that's a documented Phase 17 refinement);
-- one row per person is enough for an SMB in year one.
--
-- `user_account_id` is nullable and links this HR record to a real login
-- (Phase 3's `user_accounts`) — the User-vs-Employee identity split
-- Section 3 calls for stays real here: an Employee row can exist (e.g.
-- freshly hired, HR hasn't created their login yet) with no user account,
-- and a user account is never required to have exactly one Employee row
-- (Platform Admins and Company Super Admins don't).
CREATE TABLE IF NOT EXISTS employees (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_account_id      uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  employee_number      text NOT NULL,
  first_name           text NOT NULL,
  last_name            text NOT NULL,
  email                text,
  phone                text,
  cnic                 text,
  date_of_birth        date,
  gender               text,
  marital_status       text,
  department           text,
  designation          text,
  manager_id           uuid REFERENCES employees(id) ON DELETE SET NULL,
  employment_status    text NOT NULL DEFAULT 'active'
                         CHECK (employment_status IN ('active', 'on_leave', 'terminated')),
  date_of_joining       date NOT NULL DEFAULT CURRENT_DATE,
  termination_date      date,
  termination_reason    text,
  salary_band           text,
  bank_account_number   text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, employee_number)
);
CREATE INDEX IF NOT EXISTS idx_employees_company ON employees (company_id);
CREATE INDEX IF NOT EXISTS idx_employees_manager ON employees (manager_id);
CREATE INDEX IF NOT EXISTS idx_employees_user_account ON employees (user_account_id);

-- ---------------------------------------------------------------------
-- employee_documents — the document vault
-- ---------------------------------------------------------------------
-- `storage_path` is an opaque key into whichever FileStorageService
-- implementation is wired (Decision #7: a local-filesystem implementation
-- for now, Supabase Storage/S3 later behind the same interface) — this
-- table never assumes a specific storage backend, matching Section 9's
-- "no Supabase-only convenience as the only path" discipline.
CREATE TABLE IF NOT EXISTS employee_documents (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                 uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  document_type               text NOT NULL,
  file_name                   text NOT NULL,
  mime_type                   text NOT NULL,
  size_bytes                  integer NOT NULL,
  storage_path                text NOT NULL,
  uploaded_by_user_account_id uuid REFERENCES user_accounts(id),
  created_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_documents_employee ON employee_documents (employee_id);

-- ---------------------------------------------------------------------
-- employee_job_history — every position/status change, append-only
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_job_history (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  event_type                   text NOT NULL
                                 CHECK (event_type IN ('hire', 'promotion', 'transfer', 'salary_change', 'termination', 'rehire', 'other')),
  effective_date               date NOT NULL,
  department                   text,
  designation                  text,
  salary_band                  text,
  notes                        text,
  recorded_by_user_account_id  uuid REFERENCES user_accounts(id),
  created_at                   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_job_history_employee ON employee_job_history (employee_id);

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON employees, employee_documents, employee_job_history, employee_number_sequences TO app_role;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
-- Unlike dummy_records (Platform-Admin/service-write-only, since it's
-- pure test fixture data), employees is a genuine tenant self-service
-- object — real HR Admins create and update real employee rows through
-- the API under their own tenant session. RLS here is Section 2's
-- tenant-isolation BACKSTOP only: "is company_id the caller's own
-- company." Who specifically is allowed to write is decided by
-- EmployeesService's own RbacService.can() checks (employee.manage.all),
-- same division of labor the plan doc's Section 2 describes — RLS
-- doesn't replace that, it backs it up.
ALTER TABLE employees             ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees             FORCE ROW LEVEL SECURITY;
ALTER TABLE employee_documents    ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_documents    FORCE ROW LEVEL SECURITY;
ALTER TABLE employee_job_history  ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_job_history  FORCE ROW LEVEL SECURITY;

CREATE POLICY employees_select ON employees FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employees_insert ON employees FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employees_update ON employees FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY employee_documents_select ON employee_documents FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_documents_insert ON employee_documents FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_documents_delete ON employee_documents FOR DELETE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY employee_job_history_select ON employee_job_history FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_job_history_insert ON employee_job_history FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

-- employee_number_sequences: a bare operational counter, not sensitive
-- config — see this migration's header comment for why it's a separate
-- table with its own (more permissive) write policy rather than a column
-- on company_config. FOR ALL covers INSERT/UPDATE/SELECT/DELETE in one
-- policy since there's no meaningful distinction here between "who can
-- read this counter" and "who can advance it" the way there is for
-- company_config's real settings.
ALTER TABLE employee_number_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_number_sequences FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_number_sequences_all ON employee_number_sequences FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
