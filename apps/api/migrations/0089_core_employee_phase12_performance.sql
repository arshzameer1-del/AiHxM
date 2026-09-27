-- Core Employee Enterprise, Phase 12 — Performance Hardening
--
-- No schema change, no new table — four composite indexes closing the
-- gaps this initiative's own new read paths exposed:
--
-- 1. `employees (company_id, employment_status)` — `EmployeesService.list()`
--    (Phase 1, pre-existing) and every one of Phase 11/12's own new
--    aggregate reads (`EmployeeAnalyticsService.getSummary()`,
--    `LegacyReconciliationService.getReport()`,
--    `OrganizationCommandCenterService`'s own `legacy_records_not_mapped`
--    count) all repeat the exact same
--    `WHERE company_id = $1 AND employment_status <> 'terminated'` shape.
--    The pre-existing `idx_employees_company` index (0010) only carries
--    half of that predicate; this composite covers both columns so the
--    planner can satisfy the whole WHERE clause from the index alone
--    rather than an index scan on `company_id` followed by a row-by-row
--    status filter.
-- 2. `employee_job_history (employee_id, effective_date)` —
--    `EmployeesService.listJobHistory()`'s own
--    `ORDER BY effective_date ASC, created_at ASC` per employee (0010,
--    pre-existing); the prior `idx_employee_job_history_employee` index
--    covered the employee filter but not the sort.
-- 3. `employee_important_dates (company_id, status, date_value)` —
--    `EmployeeAnalyticsService.getSummary()`'s own
--    "due in the next 30 days" range scan (Phase 12), company-wide rather
--    than per-employee, so the existing per-employee/per-company single-
--    column indexes (0085) don't cover the combination this new query
--    actually filters and ranges on.
-- 4. `employee_assets (company_id, status)` — the same
--    `getSummary()`'s own "currently assigned, company-wide" count.
--
-- Every one of these is additive (`CREATE INDEX IF NOT EXISTS`, no data
-- migration, no lock beyond the index build itself) — nothing here
-- changes any existing query's RESULT, only its plan.

CREATE INDEX IF NOT EXISTS idx_employees_company_status ON employees (company_id, employment_status);

CREATE INDEX IF NOT EXISTS idx_employee_job_history_employee_effective
  ON employee_job_history (employee_id, effective_date);

CREATE INDEX IF NOT EXISTS idx_employee_important_dates_company_status_date
  ON employee_important_dates (company_id, status, date_value);

CREATE INDEX IF NOT EXISTS idx_employee_assets_company_status
  ON employee_assets (company_id, status);
