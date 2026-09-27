-- Core Employee Enterprise, Phase 1 — Person identity: a stable `persons`
-- record standing behind `employees`, so a rehire (or, later, a genuine
-- second concurrent employment) can link back to the SAME person instead
-- of silently creating an unrelated duplicate record.
--
-- Source: claude/core-employee-enterprise-gap-analysis-and-roadmap.md
-- ("Phase 1 — Person/Employment split"). kumail's own scoping decision:
-- build this now, not deferred again — 0010_employee_core.sql's original
-- call ("one row per person is enough for an SMB in year one") is what
-- this phase revisits.
--
-- DEVIATION FROM THIS INITIATIVE'S OWN GAP-ANALYSIS DOC, CALLED OUT HERE
-- (Section 52's "don't blindly replace files, make the smallest
-- appropriate architectural change" discipline applies just as much to a
-- prior planning doc as to a prior file): that doc proposed `employees`
-- becoming a view/projection over separate `persons` + `employments`
-- tables. That shape is not buildable in Postgres as described — a plain
-- SQL view cannot be an FK target, and `employees.id` is referenced by
-- FKs from employee_documents, employee_compensation,
-- employee_job_history, org_relationships, employee_org_assignments,
-- positions' occupancy pointer, and more. Turning `employees` into a view
-- would mean re-pointing every one of those FKs at whatever table
-- actually carries the identity, in one irreversible pass, across a table
-- every other module in this codebase already reads from — exactly the
-- "less forgiving than Organization Management" risk the gap-analysis
-- doc itself flagged under its own Question 4.
--
-- What this migration does instead:
--   `employees`            — STAYS the real base table, unchanged shape.
--                             Every existing FK, every existing reader,
--                             every existing query keeps working exactly
--                             as it does today.
--   `persons`               — NEW, additive. One row per distinct human
--                             being, matched deterministically by CNIC
--                             (the one identifier this codebase already
--                             treats as a real, stable national ID — see
--                             0010's own header comment). This is the
--                             "stable identity surviving across
--                             employment relationships" the spec actually
--                             asks for; it sits ALONGSIDE `employees`
--                             rather than replacing it.
--   `employees.person_id`  — NEW, additive, NULLABLE FK. Backfilled below
--                             for every row that exists today, and always
--                             set going forward by EmployeesService.
--                             create() (see persons.service.ts). Stays
--                             nullable rather than being tightened to NOT
--                             NULL — deliberately, not an oversight: a
--                             live audit of this test suite while
--                             building this migration found upwards of a
--                             dozen spec files across unrelated feature
--                             areas (organization, workflow, performance
--                             benchmarks, and more) that `INSERT INTO
--                             employees` directly via raw SQL fixture
--                             helpers, bypassing EmployeesService
--                             entirely — the exact same "reads/writes
--                             `employees` from outside this migration's
--                             control" situation `org_unit_id` and
--                             `location_id` were already kept nullable
--                             for (0065/0073's own header comments). A
--                             NOT NULL constraint here would have meant
--                             hunting down and fixing every one of those
--                             call sites across modules this initiative
--                             has no reason to touch. `person_id IS NULL`
--                             means exactly what `org_unit_id IS NULL`
--                             already means: this employee hasn't been
--                             linked to the canonical record yet.
--
-- A separate `employments` table (one row per person-to-tenant employment
-- relationship, distinct from the person) is deliberately NOT built in
-- this phase. `employees` already fulfills that role today. A third
-- table would be pure indirection with no new capability until this
-- codebase has a real, asked-for case of one person holding two
-- concurrent employments at the same tenant — not built ahead of that
-- demand, the same "rule of three" discipline this module's own
-- EmployeesService class comment already applies to webhook events.
-- Revisit this if/when Phase 10's lifecycle-actions work, or a real
-- multi-employment request, makes a dedicated `employments` table earn
-- its keep.
--
-- SYNC DIRECTION — the opposite way round from
-- resolveDepartment()/resolveLocation(): those two derive a legacy
-- free-text field FROM a canonical linked entity. Here it runs the other
-- way: `employees` stays authoritative (first/last name, CNIC, DOB,
-- gender all still live there, and are still what every screen reads and
-- writes) and `persons` is a derived shadow record, kept in sync by the
-- new PersonsService whenever an employee's identity fields change. This
-- is temporary by design — once a real Person UI/API exists (a later
-- phase), authority can move onto `persons` without another schema
-- change, only a service-layer cutover.
--
-- BACKFILL — CNIC-based, two passes, using a temporary staging column
-- rather than relying on INSERT...SELECT row-order correlation (which
-- Postgres never actually guarantees to match a later join):
--   Pass 1: employees sharing the same (company_id, cnic) are the same
--           person by definition (a CNIC is a real national ID) — one
--           `persons` row per distinct (company_id, cnic) group, then
--           every employee in that group is pointed at it.
--   Pass 2: employees with a NULL cnic get their own distinct person
--           each — there is no identifier to safely group them on.
-- Runs inside this migration's own transaction (migrate.ts wraps every
-- file in BEGIN/COMMIT), so a mid-backfill failure never leaves any
-- employee half-migrated.

-- ---------------------------------------------------------------------
-- persons — stable identity, additive
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS persons (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  full_name     text NOT NULL,
  cnic          text,
  date_of_birth date,
  gender        text,
  nationality   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_persons_company ON persons (company_id);
-- Same "human-facing stable identifier, unique within the tenant when
-- present" role idx_org_units_company_code/employee_number play elsewhere
-- in this schema.
CREATE UNIQUE INDEX IF NOT EXISTS idx_persons_company_cnic
  ON persons (company_id, cnic) WHERE cnic IS NOT NULL;

-- ---------------------------------------------------------------------
-- employees.person_id — additive. Nullable for now so the backfill below
-- can run as ordinary UPDATEs; tightened to NOT NULL at the very end of
-- this migration once every row has one.
-- ---------------------------------------------------------------------
ALTER TABLE employees ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES persons(id);
CREATE INDEX IF NOT EXISTS idx_employees_person ON employees (person_id);

-- ---------------------------------------------------------------------
-- Backfill (see header comment for why the staging-column approach)
-- ---------------------------------------------------------------------
ALTER TABLE persons ADD COLUMN _backfill_employee_id uuid;

-- Pass 1: CNIC groups. One person per distinct (company_id, cnic); the
-- earliest-created employee in each group names the person (full_name,
-- date_of_birth, gender) — an arbitrary but deterministic tie-break,
-- matching this INSERT's own ORDER BY.
INSERT INTO persons (company_id, full_name, cnic, date_of_birth, gender, _backfill_employee_id)
SELECT DISTINCT ON (e.company_id, e.cnic)
  e.company_id,
  e.first_name || ' ' || e.last_name,
  e.cnic,
  e.date_of_birth,
  e.gender,
  e.id
FROM employees e
WHERE e.cnic IS NOT NULL AND e.person_id IS NULL
ORDER BY e.company_id, e.cnic, e.created_at ASC;

-- Link EVERY employee in each CNIC group — not just the one row that
-- produced the person above.
UPDATE employees e
SET person_id = p.id
FROM persons p
WHERE p._backfill_employee_id IS NOT NULL
  AND e.person_id IS NULL
  AND e.company_id = p.company_id
  AND e.cnic = p.cnic;

-- Pass 2: no CNIC on file — no identifier to safely group on, so each
-- such employee becomes their own distinct person.
INSERT INTO persons (company_id, full_name, cnic, date_of_birth, gender, _backfill_employee_id)
SELECT e.company_id, e.first_name || ' ' || e.last_name, e.cnic, e.date_of_birth, e.gender, e.id
FROM employees e
WHERE e.cnic IS NULL AND e.person_id IS NULL;

UPDATE employees e
SET person_id = p.id
FROM persons p
WHERE p._backfill_employee_id = e.id
  AND e.person_id IS NULL;

ALTER TABLE persons DROP COLUMN _backfill_employee_id;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON persons TO app_role;

-- ---------------------------------------------------------------------
-- Row Level Security — same tenant-isolation-backstop shape every real
-- tenant self-service object since Phase 7 uses. PersonsService itself
-- deliberately exposes no direct create/update surface of its own yet
-- (it is only ever written from inside EmployeesService's create()/
-- update(), which already holds employee.manage.all) — RLS here is
-- defense-in-depth behind that, not a replacement for it.
-- ---------------------------------------------------------------------
ALTER TABLE persons ENABLE ROW LEVEL SECURITY;
ALTER TABLE persons FORCE ROW LEVEL SECURITY;

CREATE POLICY persons_select ON persons FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY persons_insert ON persons FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY persons_update ON persons FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
