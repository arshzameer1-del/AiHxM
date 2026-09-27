-- Core Employee Enterprise, Phase 6 — Contact + Address sub-entities
-- (spec Section 6 cards 05/06, Section 39 logical model:
-- `employee_contacts`, `employee_addresses`). Reporting Relationships
-- (card 04) is NOT a new table here — it reuses Organization
-- Management's existing `org_relationships`/`employees.manager_id`
-- exactly as the roadmap doc already commits to; see
-- HiringProcessService.complete()'s own comment for how the
-- `reporting_relationships` card's data maps onto
-- `CreateEmployeeRequest.managerId` (the same pre-existing legacy field
-- EmployeesService.create() already writes) rather than a new table or a
-- new cross-module dependency on OrganizationModule (which itself already
-- imports EmployeesModule — importing it back here would be a circular
-- module dependency; see this migration's companion services for the
-- full writeup).
--
-- Neither table is effective-dated (no `_versions` table): unlike
-- Organization Management's assignment/relationship entities, a contact
-- method or an address is not a "slot that changes value over time and
-- needs an audit trail of who it used to be" in this phase's scope — it's
-- closer to `employee_documents` (0010_employee_core.sql) in shape: a
-- flat, append/update/end table scoped to one employee. If effective-dated
-- address/contact history becomes a real requirement later, the
-- STABLE-IDENTITY + VERSION-HISTORY split precedent
-- (0065/0068/0071/0073's own header comments) is what to reach for then —
-- not retrofitted speculatively now.
--
-- MULTIPLE ROWS PER EMPLOYEE, ONE PRIMARY PER TYPE: an employee can hold
-- several contact methods of the same `contact_type` (e.g. two personal
-- phone numbers) and several addresses of the same `address_type` is
-- deliberately NOT true — Section 6's card description ("Permanent,
-- current and mailing addresses") implies exactly one of each — so
-- `employee_addresses` gets a partial unique index enforcing at most one
-- OPEN row per {employee, address_type}, while `employee_contacts` has no
-- such constraint (multiple emails/phones of the same type are normal).
-- Both tables get an `is_primary` flag scoped by a partial unique index to
-- at most one primary per {employee, contact_type} — mirroring the
-- "at most one open primary assignment" shape 0071 already established,
-- reused here for a much simpler, non-effective-dated fact.

CREATE TABLE IF NOT EXISTS employee_contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  contact_type text NOT NULL CHECK (contact_type IN (
                 'business_email', 'personal_email', 'business_phone', 'personal_phone', 'emergency_contact'
               )),
  label        text,
  value        text NOT NULL,
  is_primary   boolean NOT NULL DEFAULT false,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_contacts_company ON employee_contacts (company_id);
CREATE INDEX IF NOT EXISTS idx_employee_contacts_employee ON employee_contacts (employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_contacts_one_primary_per_type
  ON employee_contacts (employee_id, contact_type) WHERE is_primary AND status = 'active';

CREATE TABLE IF NOT EXISTS employee_addresses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  address_type   text NOT NULL CHECK (address_type IN ('permanent', 'current', 'mailing')),
  line1          text NOT NULL,
  line2          text,
  city           text,
  state_province text,
  postal_code    text,
  country        text,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_addresses_company ON employee_addresses (company_id);
CREATE INDEX IF NOT EXISTS idx_employee_addresses_employee ON employee_addresses (employee_id);
-- At most one OPEN address per {employee, address_type} — see this
-- migration's own header comment.
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_addresses_one_open_per_type
  ON employee_addresses (employee_id, address_type) WHERE status = 'active';

GRANT SELECT, INSERT, UPDATE ON employee_contacts, employee_addresses TO app_role;

ALTER TABLE employee_contacts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_contacts  FORCE ROW LEVEL SECURITY;
ALTER TABLE employee_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_addresses FORCE ROW LEVEL SECURITY;

CREATE POLICY employee_contacts_select ON employee_contacts FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_contacts_insert ON employee_contacts FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_contacts_update ON employee_contacts FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY employee_addresses_select ON employee_addresses FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_addresses_insert ON employee_addresses FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_addresses_update ON employee_addresses FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
