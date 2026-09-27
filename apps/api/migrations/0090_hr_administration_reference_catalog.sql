-- HR Administration — reference-data catalog engine (Core Employee
-- Configuration/HR-Admin v2 spec, supplied 2026-09-27, Section 6 "HR
-- Administration — Complete Core Employee Scope"). See the project doc
-- `core-employee-configuration-hr-admin-v2-gap-analysis-and-roadmap.md`
-- for the full audit this migration answers — the short version: this
-- spec draws a hard line between Configuration Center (HOW the system
-- behaves) and HR Administration (WHICH business reference data a tenant
-- uses), and today's codebase has almost none of the latter as real,
-- tenant-editable data — `employees.employment_type` is a 4-value
-- hardcoded CHECK constraint, `termination_reason` is free text, and every
-- other lifecycle transaction (transfer/promote/demote/second/act/
-- change-manager/change-location/reactivate) records no reason at all.
--
-- Most of the spec's ~30 reference-data domains are structurally
-- identical: a small, tenant-owned, ordered, soft-deactivatable list of
-- code/label pairs (employment types, and the 19 lifecycle reason
-- catalogs in Section 6.2). Rather than building N near-identical tables,
-- this is ONE generic table keyed by `catalog_type` — the same "one
-- generic engine for structurally identical domains" discipline this
-- codebase's own `SubEntityPanel.tsx` already applies on the frontend
-- side for Contacts/Addresses/Family/Education/etc.
--
-- Deliberately NOT the spec's Section 21 "Mapping/Control Engine" (a much
-- larger, generic runtime rule-mapping model covering visibility/
-- validation/workflow/security rules per field) — that remains future,
-- separately-scoped work per kumail's own decision to sequence this
-- initiative "HR Administration reference data first, then deeper
-- field-level configuration second." This table only covers simple named
-- lists: code, label, description, order, active/inactive.

CREATE TABLE IF NOT EXISTS hr_reference_catalog_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- Not a CHECK-constrained enum — the whole point of this table is that
  -- new catalog types can be registered in `catalog-type-registry.ts`
  -- (application code) without a migration. Validity of `catalog_type`
  -- itself is enforced at the service layer against that registry.
  catalog_type text NOT NULL,
  code         text NOT NULL,
  label        text NOT NULL,
  description  text,
  sort_order   integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, catalog_type, code)
);
CREATE INDEX IF NOT EXISTS idx_hr_reference_catalog_items_lookup
  ON hr_reference_catalog_items (company_id, catalog_type, is_active);

GRANT SELECT, INSERT, UPDATE ON hr_reference_catalog_items TO app_role;

ALTER TABLE hr_reference_catalog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_reference_catalog_items FORCE ROW LEVEL SECURITY;

CREATE POLICY hr_reference_catalog_items_select ON hr_reference_catalog_items FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY hr_reference_catalog_items_insert ON hr_reference_catalog_items FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY hr_reference_catalog_items_update ON hr_reference_catalog_items FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

-- New dedicated permission pair, same pattern as 0074's
-- location/cost_center/profit_center rows — HR Administration reference
-- data is its own manageable surface, not folded into the already broad
-- `employee.manage.all`, so a future role could hold one without the
-- other.
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('hr_reference_catalog.manage.all', 'Create, edit, reorder, and deactivate the company''s HR Administration reference lists (employment types, lifecycle reasons, etc.)'),
  ('hr_reference_catalog.view.all',   'View the company''s HR Administration reference lists')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key IN ('hr_reference_catalog.manage.all', 'hr_reference_catalog.view.all')
ON CONFLICT DO NOTHING;

-- Configuration Center is explicitly NOT where this lives (Section 7:
-- "Do not turn HR Administration into a second Configuration Center" —
-- and the inverse holds too, this document's whole point is the two stay
-- separate) — no `configuration_registry` row is added here. It gets its
-- own nav entry instead (PortalLayout.tsx's own change, delivered
-- alongside this migration).

-- ---------------------------------------------------------------------
-- employees.employment_type — drop the hardcoded 4-value CHECK, replace
-- with application-level validation against this company's own active
-- `employment_type` catalog items (EmployeesService, see that file's own
-- comment). The column type and existing data are completely unchanged —
-- only the constraint moves from the database to a data-driven check, per
-- the spec's own Section 38 ("hard-coded... tenant-specific requiredness"
-- must not be hard-coded) and Section 41 (additive migration only).
-- ---------------------------------------------------------------------
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_employment_type_check;

-- ---------------------------------------------------------------------
-- employee_job_history.reason_code — additive column so the 9 explicit
-- lifecycle transactions (EmployeeLifecycleService, Phase 10) can record
-- WHICH catalog reason was selected, alongside the pre-existing free-text
-- `notes` column (kept for any additional detail). Nullable: every
-- existing row, and every future call that doesn't supply a reason, keeps
-- working unchanged — this is optional metadata, not a new requirement.
-- ---------------------------------------------------------------------
ALTER TABLE employee_job_history ADD COLUMN IF NOT EXISTS reason_code text;

-- ---------------------------------------------------------------------
-- Seed data — every existing company gets the same starter set kumail's
-- own product should ship with by default (SAP SuccessFactors' own
-- Admin Center ships default picklists the same way), immediately
-- editable/extendable by any hr_admin from the new HR Administration
-- screen. `employment_type`'s 4 rows exactly match the values already
-- live in `employees.employment_type` today, so nothing already stored
-- becomes invalid.
-- ---------------------------------------------------------------------
INSERT INTO hr_reference_catalog_items (company_id, catalog_type, code, label, sort_order)
SELECT c.id, seed.catalog_type, seed.code, seed.label, seed.sort_order
FROM companies c
CROSS JOIN (VALUES
  ('employment_type', 'permanent', 'Permanent', 0),
  ('employment_type', 'contract', 'Contract', 1),
  ('employment_type', 'probation', 'Probationary', 2),
  ('employment_type', 'intern', 'Intern', 3),

  ('lifecycle_reason:hire', 'new_position', 'New position', 0),
  ('lifecycle_reason:hire', 'replacement', 'Replacement hire', 1),
  ('lifecycle_reason:hire', 'business_growth', 'Business growth', 2),
  ('lifecycle_reason:hire', 'referral', 'Employee referral', 3),

  ('lifecycle_reason:rehire', 'rejoined', 'Rejoined after resignation', 0),
  ('lifecycle_reason:rehire', 'contract_renewed', 'Contract renewed', 1),
  ('lifecycle_reason:rehire', 'seasonal_return', 'Seasonal return', 2),

  ('lifecycle_reason:transfer', 'business_need', 'Business need', 0),
  ('lifecycle_reason:transfer', 'employee_request', 'Employee request', 1),
  ('lifecycle_reason:transfer', 'restructuring', 'Departmental restructuring', 2),
  ('lifecycle_reason:transfer', 'skill_match', 'Better skill match', 3),

  ('lifecycle_reason:promotion', 'merit', 'Merit-based', 0),
  ('lifecycle_reason:promotion', 'role_change', 'Role change', 1),
  ('lifecycle_reason:promotion', 'annual_review', 'Annual review outcome', 2),

  ('lifecycle_reason:demotion', 'performance', 'Performance issue', 0),
  ('lifecycle_reason:demotion', 'restructuring', 'Restructuring', 1),
  ('lifecycle_reason:demotion', 'voluntary', 'Employee request', 2),

  ('lifecycle_reason:position_change', 'restructuring', 'Organizational restructuring', 0),
  ('lifecycle_reason:position_change', 'reclassification', 'Position reclassification', 1),

  ('lifecycle_reason:manager_change', 'restructuring', 'Team restructuring', 0),
  ('lifecycle_reason:manager_change', 'manager_exit', 'Manager left the company', 1),
  ('lifecycle_reason:manager_change', 'realignment', 'Reporting realignment', 2),

  ('lifecycle_reason:location_change', 'relocation', 'Employee relocation', 0),
  ('lifecycle_reason:location_change', 'business_need', 'Business need', 1),
  ('lifecycle_reason:location_change', 'office_closure', 'Office closure', 2),

  ('lifecycle_reason:secondment', 'project_assignment', 'Project assignment', 0),
  ('lifecycle_reason:secondment', 'cross_training', 'Cross-training', 1),
  ('lifecycle_reason:secondment', 'business_need', 'Business need', 2),

  ('lifecycle_reason:acting_assignment', 'vacancy_coverage', 'Covering a vacancy', 0),
  ('lifecycle_reason:acting_assignment', 'leave_coverage', 'Covering leave', 1),
  ('lifecycle_reason:acting_assignment', 'interim_need', 'Interim business need', 2),

  ('lifecycle_reason:compensation_change', 'annual_increment', 'Annual increment', 0),
  ('lifecycle_reason:compensation_change', 'market_adjustment', 'Market adjustment', 1),
  ('lifecycle_reason:compensation_change', 'promotion_linked', 'Linked to promotion', 2),

  ('lifecycle_reason:probation_extension', 'performance_review', 'Performance needs more time', 0),
  ('lifecycle_reason:probation_extension', 'attendance', 'Attendance concerns', 1),
  ('lifecycle_reason:probation_extension', 'training_incomplete', 'Training not yet complete', 2),

  ('lifecycle_reason:confirmation', 'satisfactory_performance', 'Satisfactory performance', 0),
  ('lifecycle_reason:confirmation', 'probation_completed', 'Probation period completed', 1),

  ('lifecycle_reason:suspension', 'misconduct_investigation', 'Misconduct under investigation', 0),
  ('lifecycle_reason:suspension', 'policy_violation', 'Policy violation', 1),
  ('lifecycle_reason:suspension', 'disciplinary', 'Disciplinary action', 2),

  ('lifecycle_reason:termination', 'resignation', 'Resignation', 0),
  ('lifecycle_reason:termination', 'performance', 'Performance', 1),
  ('lifecycle_reason:termination', 'misconduct', 'Misconduct', 2),
  ('lifecycle_reason:termination', 'redundancy', 'Redundancy', 3),
  ('lifecycle_reason:termination', 'end_of_contract', 'End of contract', 4),

  ('lifecycle_reason:retirement', 'normal_retirement', 'Normal retirement age', 0),
  ('lifecycle_reason:retirement', 'early_retirement', 'Early retirement', 1),

  ('lifecycle_reason:resignation', 'better_opportunity', 'Better opportunity', 0),
  ('lifecycle_reason:resignation', 'personal_reasons', 'Personal reasons', 1),
  ('lifecycle_reason:resignation', 'relocation', 'Relocation', 2),
  ('lifecycle_reason:resignation', 'higher_education', 'Higher education', 3),

  ('lifecycle_reason:contract_extension', 'business_need', 'Continued business need', 0),
  ('lifecycle_reason:contract_extension', 'satisfactory_performance', 'Satisfactory performance', 1),

  ('lifecycle_reason:return_from_leave', 'leave_completed', 'Leave period completed', 0),
  ('lifecycle_reason:return_from_leave', 'early_return', 'Early return from leave', 1)
) AS seed(catalog_type, code, label, sort_order)
ON CONFLICT (company_id, catalog_type, code) DO NOTHING;
