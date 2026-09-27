-- Core Employee Enterprise, Phase 7 — Important Dates card (spec Section 6
-- card 10, Section 39 logical model: `employee_important_dates`).
--
-- Working Time (card 07) is NOT a new table here — it reuses the existing
-- Shifts/Work Schedule module's own `shift_assignments`
-- (0026_shift_management.sql) via `ShiftsService.assignShiftWithinTransaction()`
-- (this phase's companion change to shifts.service.ts), the same
-- "reuse the real domain, don't fork a parallel copy" discipline Phase 6
-- already applied to Reporting Relationships/org_relationships.
--
-- Documents (card 14) is ALSO not a new table here — `employee_documents`
-- already exists (0010_employee_core.sql) with a real, working
-- `EmployeesService.addDocument()` endpoint. It is deliberately NOT wired
-- into the hiring flow's completion step this phase: every other card's
-- data is a plain JSON blob (`hire_process_card_data.data jsonb`), but a
-- document is binary file content, which needs a real multipart upload
-- endpoint scoped to a hire process, not a JSON field. That is a real,
-- separate piece of work (a new endpoint + storage wiring) rather than a
-- one-line projection like Contact/Addresses/Important Dates got — an
-- HR user can already upload documents for a NEW employee immediately
-- after hire completion via the existing `POST /employees/:id/documents`
-- endpoint, so nothing is lost, only deferred. Documented here rather
-- than silently skipped; a future phase can add a hire-process-scoped
-- upload endpoint that stages files against `hire_process_id` and moves
-- them to `employee_documents` at completion, mirroring this migration's
-- own `employee_important_dates` shape.
--
-- Multiple rows per employee, one per {employee, date_type} (an employee
-- has exactly one joining date, one confirmation date, etc. — not a list
-- of each) — same "one open row per {employee, type}" shape
-- 0084_core_employee_contact_address.sql already established for
-- `employee_addresses`, reused here for a third, simpler entity. Not
-- effective-dated for the same reason 0084's own header comment gives for
-- Contact/Address: a flat, append/update/end fact, not a "slot that
-- changes value over time and needs an audit trail" in this phase's scope.
CREATE TABLE IF NOT EXISTS employee_important_dates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date_type   text NOT NULL CHECK (date_type IN (
                'joining', 'confirmation', 'probation_end', 'contract_end', 'document_expiry'
              )),
  date_value  date NOT NULL,
  label       text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_important_dates_company ON employee_important_dates (company_id);
CREATE INDEX IF NOT EXISTS idx_employee_important_dates_employee ON employee_important_dates (employee_id);
-- `document_expiry` is deliberately EXCLUDED from the one-open-row
-- constraint below: an employee can hold several documents each with
-- their own expiry (CNIC, passport, work permit, ...), so multiple open
-- `document_expiry` rows are normal, unlike every other date type here
-- which is a single fact.
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_important_dates_one_open_per_type
  ON employee_important_dates (employee_id, date_type) WHERE status = 'active' AND date_type <> 'document_expiry';

GRANT SELECT, INSERT, UPDATE ON employee_important_dates TO app_role;

ALTER TABLE employee_important_dates ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_important_dates FORCE ROW LEVEL SECURITY;

CREATE POLICY employee_important_dates_select ON employee_important_dates FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_important_dates_insert ON employee_important_dates FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_important_dates_update ON employee_important_dates FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
