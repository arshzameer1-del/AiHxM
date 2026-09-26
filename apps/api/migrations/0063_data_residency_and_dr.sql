-- Phase 3 items #6/#7 — "Data Residency & Sovereignty" and "Backup &
-- Disaster Recovery (advanced)", built together since both extend the
-- existing Backups tab and share the same honesty discipline as Phase 3
-- item #5 (export encryption keys, migration 0062): describe what this
-- single-region, no-infra-team platform can genuinely do, never dress up
-- something it can't.
--
-- --- Data Residency & Sovereignty (item #6) --------------------------------
-- The roadmap's original wording ("multi-region data placement,
-- cross-region transfer approval, residency drift detection") assumes
-- multi-region infrastructure that this platform does not have — it runs
-- on ONE Supabase Postgres project, in whatever single region that
-- project was created in. Actually moving or placing tenant data across
-- regions is not feasible here, and pretending otherwise would be
-- dishonest. What IS honest and useful: a residency DECLARATION +
-- DISCLOSURE mechanism, not an enforcement one.
--
-- `data_residency_required` is freely-entered text (not a fixed enum —
-- real customer contracts name all sorts of things: "Pakistan", "EU",
-- "must stay in APAC", "no requirement") recording what the TENANT's own
-- contract/expectation says, if anything. It is compared, at read time
-- (see DataResidencyService in the API), against the platform's actual
-- region (the PLATFORM_DATA_REGION env var, a fixed single-region
-- constant — there is nothing per-tenant to move it to). When the two
-- don't obviously match, the API surfaces that plainly as "declared
-- requirement does not match actual hosting region" rather than silently
-- ignoring it. `acknowledged_by`/`acknowledged_at` record a Platform
-- Admin's real action ("Acknowledge — I've told this customer") for a
-- mismatch — the same "record the human action, don't fake automating
-- something the system can't actually do" discipline this codebase
-- already applies elsewhere (e.g. SCIM's Groups-out-of-scope decision,
-- Phase 1 item #5's second-approver pattern above). Both columns are
-- cleared whenever the requirement text changes, so a stale
-- acknowledgment of a DIFFERENT mismatch can never read as covering a new
-- one.
--
-- These live directly on `companies`, matching how Phase 1 item #5's
-- deletion-approval columns (migration 0050) were added directly to the
-- same table rather than a new one — small, tenant-identity-adjacent
-- fields, not a separate entity with its own lifecycle.
--
-- --- Backup & Disaster Recovery, advanced (item #7) ------------------------
-- The roadmap's own note: "Supabase's own backup/PITR already covers the
-- underlying need; a thin 'last backup status' display is reasonable, a
-- full DR test harness is not." Two genuinely useful, proportionate
-- pieces:
--
-- 1. RTO/RPO targets — two new rows in the ALREADY-BUILT
--    `tenant_configuration_defaults` mechanism (migration 0042, extended
--    for Phase 2 items #1/#3/#4 in migration 0055), category 'backup_dr'.
--    Nothing in this codebase automatically enforces an RTO/RPO (there is
--    no failover automation to enforce it with) — these are targets a
--    Platform Admin records per tenant, informational the same way
--    'security'.'max_login_attempts' was purely informational before
--    Phase 2 wired it up. Because ConfigurationTab (CompanyDetailPage.tsx)
--    renders every tenant_configuration_defaults row generically by
--    category, these two settings need NO frontend changes at all.
--
-- 2. `tenant_dr_test_log` — a manual DR TEST EVIDENCE log, not an
--    automated failover harness (explicitly out of scope: no real
--    infrastructure exists to fail over between). A Platform Admin
--    records the result of an actual, manually-performed recovery test
--    ("we restored tenant X's latest backup into a scratch environment
--    and verified Y") so a compliance-conscious customer or auditor can
--    be shown genuine evidence of when this tenant's data was last
--    actually tested for recoverability, and how it went — the honest
--    equivalent of a DR test log a real ops team keeps by hand.
--
-- Same "platform/service concern" RLS gate as every other Tenant
-- Management table since migration 0042: only a Platform Admin or the
-- service role ever touches this.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- --- Item #6: residency declaration + disclosure, on companies ------------

ALTER TABLE companies ADD COLUMN IF NOT EXISTS data_residency_required text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS data_residency_acknowledged_by text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS data_residency_acknowledged_at timestamptz;

-- --- Item #7a: RTO/RPO targets, via the existing generic mechanism --------

-- 0042's own CHECK constraint enumerates the allowed categories; unlike
-- Phase 2 item's #1/#3/#4 (migration 0055), which reused the existing
-- 'security' category, this needs a genuinely new one ('backup_dr'), so
-- the constraint has to be widened rather than reused as-is.
ALTER TABLE tenant_configuration_defaults DROP CONSTRAINT IF EXISTS tenant_configuration_defaults_category_check;
ALTER TABLE tenant_configuration_defaults ADD CONSTRAINT tenant_configuration_defaults_category_check
  CHECK (category IN ('general', 'organization', 'attendance', 'leave', 'payroll', 'security', 'backup_dr'));

INSERT INTO tenant_configuration_defaults (category, setting_key, label, description, value_type, default_value) VALUES
  ('backup_dr', 'rto_hours', 'Recovery Time Objective (hours)', 'How long this tenant accepts being down before service is restored after a disruption. Informational — there is no automated failover in this platform; see the DR test evidence log for real recovery evidence.', 'integer', '24'::jsonb),
  ('backup_dr', 'rpo_hours', 'Recovery Point Objective (hours)', 'How much data loss (in hours since the last recoverable point) this tenant accepts. Informational — actual recovery relies on Supabase''s own backup/PITR, not a per-tenant mechanism this platform controls.', 'integer', '24'::jsonb)
ON CONFLICT (category, setting_key) DO NOTHING;

-- --- Item #7b: manual DR test evidence log --------------------------------

CREATE TABLE IF NOT EXISTS tenant_dr_test_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tested_at     timestamptz NOT NULL,
  outcome       text NOT NULL CHECK (outcome IN ('pass', 'fail', 'partial')),
  notes         text,
  recorded_by   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_dr_test_log_company_idx ON tenant_dr_test_log (company_id, tested_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_dr_test_log TO app_role;

ALTER TABLE tenant_dr_test_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_dr_test_log FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_dr_test_log_all ON tenant_dr_test_log FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());
