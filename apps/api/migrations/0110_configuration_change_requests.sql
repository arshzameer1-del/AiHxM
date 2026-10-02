-- Core Employee Configuration/HR-Admin v2, "then 2" Phase 6 (2026-10-02)
-- — gap-table item #13, "Configuration Publish Lifecycle": Draft ->
-- Validate -> Dependency Check -> Impact Preview -> Approve -> Publish ->
-- Effective Date -> Active -> Retire; versioning; rollback.
--
-- THE REAL DESIGN DECISION THIS MIGRATION MAKES: every configuration
-- engine built so far this project (`hr_reference_catalog_items`,
-- `hr_business_policies`, `configuration_rule_mappings`) applies a
-- create/update/deactivate the moment its own CRUD method is called —
-- there is no draft state on any of those tables themselves, and
-- rearchitecting all three into effective-dated, versioned tables (the
-- `leave_policies`/`leave_policy_versions`-style split `org_units` uses)
-- would be a much larger, invasive change than "then 2" has scoped for
-- any single phase. Instead this is a WRAPPER lifecycle: a proposed
-- change is recorded here, inspected, approved, and only THEN actually
-- applied by calling the existing domain service's own create/update
-- method — the exact same "reuse, don't fork" discipline this phase's
-- own `ConfigurationRuleMappingService` used for `HrBusinessPolicyService`
-- rather than re-deriving policy-resolution logic a second time.
--
-- Consequently, two of the spec's named stages are deliberately merged
-- or narrowed, each documented here rather than silently dropped:
--   - "Validate", "Dependency Check", and "Impact Preview" are ONE
--     `validate()` call, not three pipeline stages — a dependency check
--     and an impact preview are both read-only analyses of the SAME
--     proposed change, computed together in practice in every real
--     change-management tool this kind of UI is modeled on, not separate
--     round trips.
--   - "Effective Date" and "Active" are ONE `published` terminal state
--     rather than a scheduled future activation — because the THREE
--     underlying tables this lifecycle wraps are not themselves
--     effective-dated (gap-table row #15 already states this plainly:
--     "N/A for now"), a change that actually took effect on a future
--     date would need its own scheduler polling this table, a genuinely
--     separate and non-trivial piece of infrastructure this platform
--     does not have yet (the one sweep job that DOES exist,
--     `WebhookDispatchService`, is purpose-built for webhook delivery
--     retries, not a generic business-data scheduler). `effective_from`
--     is still captured and shown — it is real, useful audit/record
--     metadata on WHEN this change was intended to apply — it just does
--     not itself gate when `publish()` actually calls the domain
--     service. Building that scheduler is real, separately-scoped
--     follow-up work, not invented here.
--
-- VERSIONING AND ROLLBACK: rather than a separate version-history table,
-- each change request for an existing target links to the immediately
-- prior PUBLISHED change for that same `(config_domain, target_id)` via
-- `previous_change_id` — a natural linked list, the same shape
-- `employee_job_history` already gives "what happened to this record
-- over time" without a bespoke versioning engine. `before_snapshot`
-- (captured at DRAFT time, directly from the live target row — the same
-- narrow, documented "read another domain's own table directly"
-- exception `configuration-rule-mapping.service.ts`'s own `resolveOverride()`
-- already uses for `org_units`) is what a rollback restores: creating a
-- NEW draft change whose payload reproduces that snapshot, which must
-- then go through this SAME full pipeline again — a rollback is never
-- auto-applied, so the maker-checker control below still holds even for
-- undoing a change.
--
-- MAKER-CHECKER: `approve()`/`reject()` are gated by a new
-- `configuration_change.approve.all` permission, separate from
-- `configuration_change.manage.all` (create/validate/submit/publish/
-- retire/rollback) — both granted to `hr_admin` below, since this
-- platform has no separate "approver" role yet and inventing one
-- speculatively is its own separately-scoped piece of work. The real
-- control enforced here is in the SERVICE layer, not RBAC: `approve()`
-- rejects a request whose `approved_by` would equal its own
-- `submitted_by`, so two humans — even two people who both hold the
-- hr_admin role — are required end to end, which is still a genuine
-- maker-checker control for any tenant with more than one HR Admin user
-- (the realistic case this is built for).
CREATE TABLE IF NOT EXISTS configuration_change_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  config_domain      text NOT NULL CHECK (config_domain IN ('hr_reference_catalog_item', 'hr_business_policy', 'configuration_rule_mapping')),
  operation          text NOT NULL CHECK (operation IN ('create', 'update', 'deactivate')),
  -- NULL only for operation = 'create', before the target row exists.
  target_id          uuid,
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status             text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'validated', 'pending_approval', 'approved', 'rejected', 'published', 'retired')),
  effective_from     date,
  before_snapshot     jsonb,
  validation_result  jsonb,
  rejection_reason    text,
  previous_change_id uuid REFERENCES configuration_change_requests(id),
  submitted_by        uuid REFERENCES user_accounts(id),
  approved_by          uuid REFERENCES user_accounts(id),
  approved_at          timestamptz,
  published_at         timestamptz,
  retired_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (operation = 'create' OR target_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_configuration_change_requests_lookup
  ON configuration_change_requests (company_id, config_domain, status);
CREATE INDEX IF NOT EXISTS idx_configuration_change_requests_target
  ON configuration_change_requests (company_id, config_domain, target_id);

GRANT SELECT, INSERT, UPDATE ON configuration_change_requests TO app_role;

ALTER TABLE configuration_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE configuration_change_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY configuration_change_requests_select ON configuration_change_requests FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY configuration_change_requests_insert ON configuration_change_requests FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY configuration_change_requests_update ON configuration_change_requests FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

INSERT INTO permissions (key, description) VALUES
  ('configuration_change.manage.all',  'Draft, validate, submit, publish, retire, and roll back HR Administration configuration change requests.'),
  ('configuration_change.approve.all', 'Approve or reject a submitted HR Administration configuration change request (must be a different user than the one who submitted it).'),
  ('configuration_change.view.all',    'View HR Administration configuration change requests and their history.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key IN ('configuration_change.manage.all', 'configuration_change.approve.all', 'configuration_change.view.all')
ON CONFLICT DO NOTHING;
