-- Payroll Administration — Payroll Areas (the SAP HCM "Payroll Area"
-- equivalent, master engineering instruction §5.1's "payroll areas/
-- groups" item). Closes the Data Scope gap the cross-module integration
-- audit (item 3/7, 2026-10-01) left documented in PayrollService's own
-- header comment: `payroll_runs` had no sub-company dimension at all, so
-- `payroll.calculate/finalize/disburse` could only ever be company-wide
-- `.all` checks. A Payroll Area gives a run a genuine scope column
-- instead of an artificial one.
--
-- Four additive, backward-compatible pieces:
--
--   payroll_areas             — a tenant-scoped, named grouping of
--                               employees for payroll processing ("Karachi
--                               Monthly", "Lahore Weekly"). Deactivated,
--                               never deleted (runs keep pointing at it).
--   payroll_area_scope_links  — which org units / locations / cost centers
--                               a Payroll Area belongs to, for Data Scope.
--                               Deliberately the SAME shape as
--                               `data_scope_assignments` (0078): a
--                               `scope_type` + bare `scope_entity_id`,
--                               validated in the API layer (RbacModule's
--                               exported `scopeEntityExists()`), not three
--                               near-identical link tables. A caller
--                               holding a `payroll.*.scoped` permission can
--                               touch a Payroll Area iff at least one of
--                               its links falls inside one of the caller's
--                               own data_scope_assignments (org_unit /
--                               location expanded to subtree, cost_center
--                               flat) — the same "either dimension" rule
--                               PositionsService.resolveViewAccess() uses.
--                               An area with ZERO links is reachable only
--                               by `.all` holders (fails closed).
--   employees.payroll_area_id — the employee's CURRENT payroll area. A
--                               nullable FK on `employees` exactly like
--                               org_unit_id (0065) / position_id (0068) /
--                               location_id (0073): the established shape
--                               for a per-employee classification FK in
--                               this codebase. Its ONLY writer is
--                               PayrollAreasService.assignEmployee() —
--                               the same "owning domain reaches across the
--                               table boundary via plain SQL" precedent
--                               PositionsService set for position_id.
--                               (SAP keeps ABKRS on the time-dependent
--                               IT0001; putting it on the effective-dated
--                               employee_org_assignments slot would mean
--                               changing EmployeeOrgAssignmentsService's
--                               versioning sync, owned by Organization.
--                               Current-state-only is a documented gap: a
--                               past period recalculated after an
--                               employee changes area uses their CURRENT
--                               area.)
--   payroll_runs.payroll_area_id — null = company-wide run (every run that
--                               existed before this migration, and still
--                               the default). Non-null = calculateRun()
--                               only includes that area's employees.
--
-- The single-active-run-per-period index (0094) is widened to one active
-- run per {period, payroll area}, with NULL (company-wide) treated as its
-- own distinct key via COALESCE. PayrollService.createRun() additionally
-- refuses to mix a company-wide run and area runs for the same period
-- (which would pay the same employee twice) — an application check, since
-- "no NULL row exists while any non-NULL row does" is not expressible as
-- a unique index.

CREATE TABLE IF NOT EXISTS payroll_areas (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code         text NOT NULL CHECK (length(trim(code)) > 0),
  name         text NOT NULL CHECK (length(trim(name)) > 0),
  description  text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);
CREATE INDEX IF NOT EXISTS idx_payroll_areas_company ON payroll_areas (company_id);

CREATE TABLE IF NOT EXISTS payroll_area_scope_links (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_area_id  uuid NOT NULL REFERENCES payroll_areas(id) ON DELETE CASCADE,
  scope_type       text NOT NULL CHECK (scope_type IN ('org_unit', 'location', 'cost_center')),
  scope_entity_id  uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payroll_area_id, scope_type, scope_entity_id)
);
CREATE INDEX IF NOT EXISTS idx_payroll_area_scope_links_lookup
  ON payroll_area_scope_links (company_id, scope_type, scope_entity_id);

-- payroll_runs.payroll_area_id is NO ACTION (the default), deliberately not
-- RESTRICT: a company delete cascades into payroll_areas AND payroll_runs
-- in the same statement, and NO ACTION is only checked at statement end,
-- after every cascade ran. Areas are deactivated, never deleted, in the
-- app; this only keeps tenant teardown working.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS payroll_area_id uuid REFERENCES payroll_areas(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_employees_payroll_area ON employees (payroll_area_id);

ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS payroll_area_id uuid REFERENCES payroll_areas(id);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_payroll_area ON payroll_runs (payroll_area_id);

DROP INDEX IF EXISTS payroll_runs_active_period_key;
CREATE UNIQUE INDEX payroll_runs_active_period_key
  ON payroll_runs (company_id, period_start, period_end, COALESCE(payroll_area_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status <> 'reversed';

GRANT SELECT, INSERT, UPDATE ON payroll_areas TO app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_area_scope_links TO app_role;

ALTER TABLE payroll_areas            ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_areas            FORCE ROW LEVEL SECURITY;
ALTER TABLE payroll_area_scope_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_area_scope_links FORCE ROW LEVEL SECURITY;

CREATE POLICY payroll_areas_all ON payroll_areas FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY payroll_area_scope_links_all ON payroll_area_scope_links FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
