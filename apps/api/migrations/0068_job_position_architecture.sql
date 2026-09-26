-- Organization Management, Phase 2 — Job + Position Architecture.
--
-- Source: the product owner's Master Engineering Instruction doc
-- (claude/organization-management-master-engineering-instruction.md),
-- Section 9 (Position Management) + Section 10 (Job Architecture) +
-- Section 27/Phase 2 roadmap entry. Phase 1
-- (0065_organization_units.sql) built the canonical Org Unit hierarchy;
-- this phase adds the two entities that actually sit IN that hierarchy:
--
--   Job      — a canonical, reusable WORK DEFINITION ("Software Engineer
--              II", "Regional Sales Manager"). A tenant defines a job
--              once and reuses it across many positions/org units — the
--              same "define once, reference everywhere" role
--              `leave_policies` plays relative to employees, or
--              `org_units` now plays relative to `department`.
--   Position — an actual organizational SEAT: "the Backend Engineer seat
--              in the Platform Engineering department." A position
--              belongs to exactly one org unit, optionally references a
--              job, and can exist — deliberately, as a first-class valid
--              state, not an edge case — with zero occupants (`vacant`).
--              `employees.position_id` is what actually seats someone in
--              it.
--
-- STABLE-IDENTITY + VERSION-HISTORY SPLIT, replicated a second time:
-- exactly 0065's own design decision (see that migration's header
-- comment for the full reasoning), applied here for the same reason —
-- `jobs.id` is an FK target from `positions.job_id`, and `positions.id`
-- is an FK target from `employees.position_id`; neither can rotate on a
-- routine edit (a title change, a headcount bump, a freeze) without
-- every referencing row silently pointing at a now-dead id. So, exactly
-- as with `org_units`/`org_unit_versions`:
--
--   `jobs` / `positions`          — stable identity + current-state
--                                    cache, kept in sync by
--                                    JobsService/PositionsService's own
--                                    `applyVersionAndSync()` helpers.
--                                    Every reference (positions.job_id,
--                                    employees.position_id) and every
--                                    listing query reads THESE tables.
--   `job_versions` /
--   `position_versions`           — the EffectiveDatingEngine-managed
--                                    history, scope = { job_id } /
--                                    { position_id }, same shape 0033/
--                                    0065 already established.
--
-- JOB_FAMILY / JOB_LEVEL: `job_family` is a validated-but-OPEN set (CHECK
-- constraint, not a hardcoded enum type) — Section 39's "must not
-- happen" list explicitly forbids hard-coding a fixed taxonomy where a
-- canonical reference should exist instead, but Phase 2 has no separate
-- "Job Family" master entity to reference yet (that would be its own
-- gap-analysis item, not invented here). A CHECK'd text column is this
-- same "validated but open, not a rigid hardcoded level system" posture
-- `org_units.unit_type` already established for exactly this reason.
-- `job_level` is a free, nullable text label (a grade/band name like
-- "L4" or "Band 3") — tenants' banding schemes vary too widely for this
-- phase to normalize into its own table; Compensation Bands (a separate,
-- already-existing concept in payroll) are NOT touched or referenced
-- here.
--
-- POSITION OCCUPANCY: `positions.status` transitions (vacant <-> filled,
-- plus frozen/abolished) are explicit application-layer state in
-- PositionsService (see positions.service.ts's own header comment) —
-- deliberately NOT a database trigger, matching this codebase's
-- "business logic lives in the service layer" convention every other
-- state transition here follows (OrgUnitsService.archive()/activate(),
-- EmployeesService's employment_status handling). `headcount_fte`
-- defaults to 1.0 (numeric, not integer) to support part-time/shared
-- seats without inventing a separate concept for it.
--
-- OUT OF SCOPE THIS PHASE (explicit, per the master instruction — not an
-- oversight): no `location_id`/`cost_center_id` on positions (Phase 5 —
-- those tables don't exist yet, so no placeholder columns are added
-- ahead of them); no Recruitment requisition-references-position wiring
-- (do not implement until the Position contract is stable); no typed
-- reporting-relationship changes (`employees.manager_id` untouched,
-- Phase 4 territory); no org-wide eventing (Phase 7).

-- ---------------------------------------------------------------------
-- jobs — stable identity + current-state cache
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  job_code    text,
  title       text NOT NULL,
  job_family  text CHECK (job_family IS NULL OR job_family IN (
                'engineering', 'sales', 'marketing', 'finance', 'hr',
                'operations', 'legal', 'customer_support', 'product',
                'administration', 'executive', 'other'
              )),
  job_level   text,
  description text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs (company_id);
-- Same "optional but unique when set" business-key shape org_units.code
-- already established.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_company_code
  ON jobs (company_id, job_code) WHERE job_code IS NOT NULL;

-- ---------------------------------------------------------------------
-- job_versions — effective-dated history, scope = { job_id }
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  job_code       text,
  title          text NOT NULL,
  job_family     text CHECK (job_family IS NULL OR job_family IN (
                   'engineering', 'sales', 'marketing', 'finance', 'hr',
                   'operations', 'legal', 'customer_support', 'product',
                   'administration', 'executive', 'other'
                 )),
  job_level      text,
  description    text,
  status         text NOT NULL CHECK (status IN ('active', 'archived')),
  effective_from date NOT NULL,
  effective_to   date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS idx_job_versions_job ON job_versions (job_id, effective_from);
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_versions_one_open
  ON job_versions (job_id) WHERE effective_to IS NULL;

-- ---------------------------------------------------------------------
-- positions — stable identity + current-state cache
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS positions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- NOT NULL: a position is always a seat IN some org unit — that's the
  -- whole point of the entity (Section 9: "an organizational seat"). A
  -- job, by contrast, can be defined before any seat references it, so
  -- job_id below stays nullable.
  org_unit_id    uuid NOT NULL REFERENCES org_units(id) ON DELETE RESTRICT,
  job_id         uuid REFERENCES jobs(id) ON DELETE SET NULL,
  position_code  text,
  position_title text NOT NULL,
  headcount_fte  numeric(4, 2) NOT NULL DEFAULT 1.0 CHECK (headcount_fte > 0),
  status         text NOT NULL DEFAULT 'vacant' CHECK (status IN ('vacant', 'filled', 'frozen', 'abolished')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_positions_company ON positions (company_id);
CREATE INDEX IF NOT EXISTS idx_positions_org_unit ON positions (org_unit_id);
CREATE INDEX IF NOT EXISTS idx_positions_job ON positions (job_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_company_code
  ON positions (company_id, position_code) WHERE position_code IS NOT NULL;

-- ---------------------------------------------------------------------
-- position_versions — effective-dated history, scope = { position_id }
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS position_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id    uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  org_unit_id    uuid NOT NULL REFERENCES org_units(id) ON DELETE RESTRICT,
  job_id         uuid REFERENCES jobs(id) ON DELETE SET NULL,
  position_code  text,
  position_title text NOT NULL,
  headcount_fte  numeric(4, 2) NOT NULL CHECK (headcount_fte > 0),
  status         text NOT NULL CHECK (status IN ('vacant', 'filled', 'frozen', 'abolished')),
  effective_from date NOT NULL,
  effective_to   date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS idx_position_versions_position ON position_versions (position_id, effective_from);
CREATE UNIQUE INDEX IF NOT EXISTS idx_position_versions_one_open
  ON position_versions (position_id) WHERE effective_to IS NULL;

-- ---------------------------------------------------------------------
-- employees.position_id — additive, nullable, backward-compatible.
-- `employees.designation` (free text) is untouched, exactly the same
-- "new canonical FK alongside, never replacing, the legacy free-text
-- column" posture `org_unit_id` took relative to `department` in Phase 1.
-- The ONLY writer of this column is PositionsService.assignEmployee()/
-- unassignEmployee() (see that service's own header comment for why) —
-- EmployeesController's create/update endpoints do not accept a
-- positionId input this phase.
-- ---------------------------------------------------------------------
ALTER TABLE employees ADD COLUMN IF NOT EXISTS position_id uuid REFERENCES positions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_employees_position ON employees (position_id);

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON jobs, job_versions, positions, position_versions TO app_role;

-- ---------------------------------------------------------------------
-- Row Level Security — same tenant-isolation-backstop shape 0065
-- established for org_units/org_unit_versions. JobsService's/
-- PositionsService's own permission checks (seeded in
-- 0069_job_position_seed.sql) are the real gate; RLS is defense-in-depth
-- underneath them.
-- ---------------------------------------------------------------------
ALTER TABLE jobs               ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs               FORCE ROW LEVEL SECURITY;
ALTER TABLE job_versions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_versions       FORCE ROW LEVEL SECURITY;
ALTER TABLE positions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions          FORCE ROW LEVEL SECURITY;
ALTER TABLE position_versions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE position_versions  FORCE ROW LEVEL SECURITY;

CREATE POLICY jobs_select ON jobs FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY jobs_insert ON jobs FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY jobs_update ON jobs FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY job_versions_select ON job_versions FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY job_versions_insert ON job_versions FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY job_versions_update ON job_versions FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY positions_select ON positions FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY positions_insert ON positions FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY positions_update ON positions FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY position_versions_select ON position_versions FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY position_versions_insert ON position_versions FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY position_versions_update ON position_versions FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
