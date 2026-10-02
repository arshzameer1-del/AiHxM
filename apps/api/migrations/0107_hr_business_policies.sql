-- HR Administration v2, "then 2" Phase 2 (2026-10-02) — item #8,
-- "Business policies (probation, confirmation, document, correction,
-- transfer, rehire, termination/exit, retention, required-info policies)
-- as configurable objects" from
-- `core-employee-configuration-hr-admin-v2-gap-analysis-and-roadmap.md`'s
-- gap table — the next item in sequence after Phase 1 (#7, personal/
-- reference catalogs, 0106).
--
-- A business policy is a genuinely different shape from Phase 1's
-- catalogs: a catalog item is a flat {code, label} pair, but a policy
-- carries STRUCTURED RULES that differ by policy type (a probation
-- policy needs a duration in days; a rehire policy needs a cooldown
-- period; a document policy needs a list of required document types).
-- Rather than one bespoke table per policy type (9 tables for 9 types,
-- most fields unique to their own type), this reuses the exact
-- JSONB-over-EAV tradeoff this codebase already made for `custom_fields`
-- (Decision #6) and `company_config` — one generic table, keyed by an
-- app-registered (not CHECK-constrained) `policy_type`, with the
-- type-specific shape living in a `rules jsonb` column that
-- `business-policy-registry.ts` and each consuming service agree on.
-- Same "one engine, not N bespoke tables" discipline `hr_reference_catalog_items`
-- (0090) already proved out for Phase 1's 13 catalog types.
--
-- Unlike a catalog item, a policy is a NAMED, ASSIGNABLE object — a
-- tenant can define more than one named policy per type (e.g. "Standard
-- Probation" vs "Senior Hire Probation") with exactly one marked the
-- DEFAULT per {company, policy_type} (the one `resolveDefaultPolicy()`
-- returns to a consuming service today; per-Employee-Group policy
-- assignment, mirroring `employee_group_policy_assignments`'
-- (0012_employee_groups_leave_policy.sql) own additive join, is real,
-- separately-scoped follow-up work once there is a second policy per
-- type in real use — not built speculatively here). The partial unique
-- index below enforces "at most one default per {company, policy_type}"
-- exactly the way `leave_policies` (0012) already enforces it for its
-- own single policy type.
CREATE TABLE IF NOT EXISTS hr_business_policies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  policy_type text NOT NULL,
  code        text NOT NULL,
  name        text NOT NULL,
  description text,
  rules       jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_default  boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, policy_type, code)
);
CREATE INDEX IF NOT EXISTS idx_hr_business_policies_lookup
  ON hr_business_policies (company_id, policy_type, is_active);
-- At most one ACTIVE default policy per {company, policy_type} — the
-- same partial-unique-index shape 0012's `leave_policies` already
-- established for its own single policy type, generalized here across
-- every registered policy type.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_business_policies_one_default_per_type
  ON hr_business_policies (company_id, policy_type) WHERE is_default = true AND is_active = true;

GRANT SELECT, INSERT, UPDATE ON hr_business_policies TO app_role;

ALTER TABLE hr_business_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_business_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY hr_business_policies_select ON hr_business_policies FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY hr_business_policies_insert ON hr_business_policies FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY hr_business_policies_update ON hr_business_policies FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

-- New dedicated permission pair, same pattern as 0090's
-- `hr_reference_catalog.manage.all`/`.view.all` — hr_admin only.
INSERT INTO permissions (key, description) VALUES
  ('hr_business_policy.manage.all', 'Create, edit, reorder, and set the default for the company''s HR business policies (probation, confirmation, document, correction, transfer, rehire, termination/exit, retention, required-info).'),
  ('hr_business_policy.view.all',   'View the company''s HR business policies')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key IN ('hr_business_policy.manage.all', 'hr_business_policy.view.all')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- Seed data — every existing company gets one DEFAULT named policy per
-- registered type, with a reasonable Pakistan-SMB starter rule set.
-- Of the 9, TWO are wired into real enforcement this same phase (see
-- `employees.service.ts`):
--   probation -> auto-computes an employee_important_dates
--                'probation_end' row at hire time from `durationDays`,
--                when the new hire's employment_type is 'probation'.
--   rehire     -> enforces `cooldownDays` (default 0 = no restriction,
--                so no existing tenant's behavior changes until they
--                raise it) against the most recent termination_date of
--                the same person, the moment a hire is matched to an
--                existing person by CNIC (persons.service.ts's own
--                deterministic rehire-matching key).
-- The remaining SEVEN (confirmation, document, correction, transfer,
-- termination_exit, retention, required_info) are registered and seeded
-- too, so an hr_admin can already see, edit, and set rules on them from
-- the HR Administration screen — but, like 7 of Phase 1's 13 personal
-- catalogs, none has a consuming transaction yet. Honestly labeled as
-- such in `business-policy-registry.ts`'s own `wiredInto` field. Wiring
-- each of these to a real transaction (a Confirm action, a Document
-- checklist at hire completion, a Correction-window guard on employee
-- edits, a Transfer notice-period check, an Exit clearance checklist, a
-- Retention-driven purge-eligibility date, a Required-Info completeness
-- gate at hire completion) is real, separately-scoped follow-up work.
INSERT INTO hr_business_policies (company_id, policy_type, code, name, description, rules, is_default, sort_order)
SELECT c.id, seed.policy_type, seed.code, seed.name, seed.description, seed.rules::jsonb, true, 0
FROM companies c
CROSS JOIN (VALUES
  ('probation', 'default', 'Standard Probation',
    'How long a new probationary hire''s probation period runs, and whether/how it can be extended.',
    '{"durationDays": 90, "maxExtensions": 1, "extensionDays": 30}'),

  ('confirmation', 'default', 'Standard Confirmation',
    'The minimum time that must elapse before a probationary employee can be confirmed, and the default confirmation reason.',
    '{"minProbationDays": 90, "defaultReasonCode": "probation_completed"}'),

  ('document', 'default', 'Standard Document Requirements',
    'The documents every employee is expected to have on file.',
    '{"requiredDocumentTypes": ["cnic", "photograph"]}'),

  ('correction', 'default', 'Standard Correction Window',
    'How long after a record is created HR can correct it without extra approval.',
    '{"editableWindowDays": 30, "requiresApprovalAfterWindow": true}'),

  ('transfer', 'default', 'Standard Transfer Notice',
    'The minimum notice period and approval requirement for an internal transfer.',
    '{"minNoticeDays": 7, "requiresApproval": true}'),

  ('rehire', 'default', 'Standard Rehire Eligibility',
    'How soon a previously terminated employee becomes eligible for rehire, and whether their old employee number is preserved.',
    '{"cooldownDays": 0, "preserveEmployeeNumber": false}'),

  ('termination_exit', 'default', 'Standard Termination / Exit',
    'Notice period, exit-clearance checklist requirement, and final-settlement timing on termination.',
    '{"noticeDays": 30, "requiresClearanceChecklist": true, "finalSettlementDays": 15}'),

  ('retention', 'default', 'Standard Data Retention',
    'How long a terminated employee''s records are retained before they become eligible for purge/anonymization.',
    '{"postTerminationRetentionDays": 2555}'),

  ('required_info', 'default', 'Standard Required Information',
    'The personal/employment fields that must be filled in before a hire can be completed.',
    '{"requiredFieldKeys": ["cnic", "dateOfBirth", "emergencyContact"]}')
) AS seed(policy_type, code, name, description, rules)
ON CONFLICT (company_id, policy_type, code) DO NOTHING;
