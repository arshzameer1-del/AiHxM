-- Tenant Management — schema for the Platform Admin "Tenant Management"
-- module (client-supplied UI/functional mapping: Tenant Directory, Tenant
-- Creation wizard, Tenant Overview/Profile/Branding, Tenant Users +
-- Sessions, Tenant Configuration (override/inheritance/history), Tenant
-- Modules/Features, Subscription/Seats, Usage, Storage, Security (Lock),
-- Integrations, Health, Support, Backups, Export, Lifecycle/Deletion).
--
-- Every route the spec names is under /platform/tenants/... — i.e. every
-- new capability here is Platform-Admin-only, the same tier every table in
-- this migration is gated to (no self-service tenant exposure is asked
-- for, so RLS below is uniformly `app.is_platform_admin() OR
-- app.is_service()`, matching tenant_module_entitlement's own write policy
-- in 0006 rather than inventing a new shape).
--
-- Nothing here duplicates existing functionality: company creation
-- (companies/company_config/company_admins, 0001), module entitlement
-- (module_catalog/tenant_module_entitlement, 0006), and the tenant-side
-- "Configuration Center" discovery index (configuration_registry, 0032)
-- already exist and are extended, not re-built, below.

-- ---------------------------------------------------------------------
-- 0. Widen `companies_update` for `is_service()` — same shape as 0025's
--    widening of companies_select/companies_write (INSERT) for the
--    self-signup flow. This migration adds the first legitimate
--    server-side (non-Platform-Admin-session) writer of `companies` rows
--    via UPDATE: CompaniesLifecycleScheduler's grace-period purge sweep
--    (TM-038), which runs on a cron tick with no HTTP request/session
--    behind it at all, the same shape as WorkflowService.escalateOverdue().
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS companies_update ON companies;
CREATE POLICY companies_update ON companies FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

-- ---------------------------------------------------------------------
-- 1. Company info, localization, domain, lifecycle, seats, quota
-- ---------------------------------------------------------------------
-- Widen the existing `companies` row rather than a side table — these are
-- all 1:1 attributes of a company, same as `name`/`slug` already are.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS legal_name text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS company_code text UNIQUE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS registration_number text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS industry text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'PK';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Asia/Karachi';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'PKR';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS fiscal_year_start_month integer NOT NULL DEFAULT 7
  CHECK (fiscal_year_start_month BETWEEN 1 AND 12);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS custom_domain text UNIQUE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS seats_purchased integer NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS storage_quota_mb integer NOT NULL DEFAULT 5120;

-- Lifecycle (TM-037/038): widen the status enum from
-- trial/active/suspended/churned to the spec's own state list. 'churned'
-- is kept (existing data may use it) and treated as a synonym callers
-- should migrate off; 'draft'/'locked'/'archived' are new.
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_status_check;
ALTER TABLE companies ADD CONSTRAINT companies_status_check
  CHECK (status IN ('draft', 'trial', 'active', 'suspended', 'locked', 'archived', 'churned'));

ALTER TABLE companies ADD COLUMN IF NOT EXISTS status_reason text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS status_changed_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS deletion_reason text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS deletion_purge_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS deletion_requested_by text;

-- ---------------------------------------------------------------------
-- 2. Sessions — the piece that makes "Force Logout" (TM-017/029) and
--    "Tenant Lock" (TM-030) actually enforceable, not just a status flag
--    nobody checks.
-- ---------------------------------------------------------------------
-- Auth is (and stays) stateless JWT for normal request performance — this
-- table is NOT a session store the guard reads on every request by
-- default; it exists so a specific session CAN be revoked. AuthService
-- embeds this row's id as the JWT's `jti` claim at sign time; the guards
-- only do the (cached, see auth.service/guards) revoked-session lookup
-- when a jti is present. A JWT with no `jti` (tokens signed before this
-- migration) is treated as unrevoked/unrevokable — those will simply
-- expire naturally via the existing 12h `expiresIn` and 30m impersonation
-- expiry.
CREATE TABLE IF NOT EXISTS user_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id    uuid NOT NULL,
  company_id         uuid REFERENCES companies(id) ON DELETE CASCADE,
  is_platform_admin  boolean NOT NULL DEFAULT false,
  device_label       text,
  ip_address         text,
  user_agent         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  revoked_by         text
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_company ON user_sessions (company_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_account ON user_sessions (user_account_id);

-- ---------------------------------------------------------------------
-- 3. Module dependencies (TM-011/022) and feature-level entitlements
--    (TM-023/024) — one level more granular than module_catalog (0006).
-- ---------------------------------------------------------------------

-- Same reasoning as 0006's identical line: FORCE ROW LEVEL SECURITY
-- applies to the migration/owner connection too, so every seed/backfill
-- write below needs the same is_service claims the app itself would use.
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE module_catalog ADD COLUMN IF NOT EXISTS depends_on text REFERENCES module_catalog(key);
-- Every module built so far (roadmap Section 3) is layered on Employee
-- Core (Employee Number assignment, org structure) — this is a real
-- dependency, not an invented one: Leave/Attendance, Recruitment,
-- Performance, and Payroll all key off `employees`.
UPDATE module_catalog SET depends_on = 'employee'
  WHERE key IN ('leave', 'recruitment', 'performance', 'payroll', 'succession', 'learning', 'exit')
    AND depends_on IS NULL;

CREATE TABLE IF NOT EXISTS module_features (
  key            text PRIMARY KEY,
  module_key     text NOT NULL REFERENCES module_catalog(key) ON DELETE CASCADE,
  name           text NOT NULL,
  description    text,
  default_limit  integer, -- null = unlimited
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_feature_entitlement (
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  feature_key  text NOT NULL REFERENCES module_features(key) ON DELETE CASCADE,
  enabled      boolean NOT NULL DEFAULT true,
  usage_limit  integer, -- override; null defers to module_features.default_limit
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, feature_key)
);
CREATE INDEX IF NOT EXISTS idx_tenant_feature_entitlement_company ON tenant_feature_entitlement (company_id);

INSERT INTO module_features (key, module_key, name, description, default_limit) VALUES
  ('employee.document_vault', 'employee', 'Document Vault', 'Per-employee document uploads.', NULL),
  ('employee.org_chart', 'employee', 'Org Chart', 'Interactive reporting-line chart.', NULL),
  ('leave.biometric_clock_in', 'leave', 'Biometric/GPS Clock-In', 'Device- or location-verified attendance capture.', NULL),
  ('leave.on_duty', 'leave', 'On-Duty Requests', 'Off-site work authorization requests.', NULL),
  ('recruitment.kanban', 'recruitment', 'Candidate Kanban', 'Drag-and-drop candidate pipeline board.', NULL),
  ('performance.calibration', 'performance', 'Calibration', 'Cross-team rating calibration sessions.', NULL),
  ('payroll.bank_disbursement_export', 'payroll', 'Bank Disbursement Export', 'CSV export for salary disbursement.', NULL),
  ('payroll.statutory_reports', 'payroll', 'Statutory Reports', 'FBR/EOBI/PESSI/SESSI compliance reports.', 12)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------
-- 4. Tenant Configuration: override + inheritance + version history
--    (TM-018/019/020). Distinct from `configuration_registry` (0032),
--    which is a tenant-FACING index of existing per-module admin screens
--    (leave policy, shifts, tax slabs, ...) — this is a NEW, generic,
--    Platform-Admin-facing key/value settings store with a real
--    inheritance model: `tenant_configuration_defaults` is the product
--    default for a (category, setting_key); a row in `tenant_configuration`
--    is that one tenant's override; the "effective value" a screen shows
--    is COALESCE(override, default). Every write is versioned into
--    `tenant_configuration_versions`, which is what Rollback restores from.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tenant_configuration_defaults (
  category       text NOT NULL CHECK (category IN ('general', 'organization', 'attendance', 'leave', 'payroll', 'security')),
  setting_key    text NOT NULL,
  label          text NOT NULL,
  description    text,
  value_type     text NOT NULL CHECK (value_type IN ('boolean', 'integer', 'text')),
  default_value  jsonb NOT NULL,
  PRIMARY KEY (category, setting_key)
);

CREATE TABLE IF NOT EXISTS tenant_configuration (
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category     text NOT NULL,
  setting_key  text NOT NULL,
  value        jsonb NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text NOT NULL,
  PRIMARY KEY (company_id, category, setting_key)
);
CREATE INDEX IF NOT EXISTS idx_tenant_configuration_company ON tenant_configuration (company_id);

CREATE TABLE IF NOT EXISTS tenant_configuration_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category     text NOT NULL,
  setting_key  text NOT NULL,
  old_value    jsonb,
  new_value    jsonb NOT NULL,
  changed_by   text NOT NULL,
  changed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tenant_configuration_versions_lookup
  ON tenant_configuration_versions (company_id, category, setting_key, changed_at DESC);

INSERT INTO tenant_configuration_defaults (category, setting_key, label, description, value_type, default_value) VALUES
  ('general', 'support_email', 'Support email shown to employees', 'Contact address surfaced in the tenant portal footer.', 'text', '""'::jsonb),
  ('general', 'date_format', 'Date format', 'Display format for dates across the tenant portal.', 'text', '"DD-MM-YYYY"'::jsonb),
  ('organization', 'week_start_day', 'Week starts on', '0 = Sunday .. 6 = Saturday.', 'integer', '1'::jsonb),
  ('attendance', 'late_grace_minutes', 'Late grace period (minutes)', 'Minutes after shift start before a clock-in counts as late.', 'integer', '10'::jsonb),
  ('leave', 'carry_forward_enabled', 'Allow leave carry-forward', 'Whether unused leave balances roll into the next cycle by default.', 'boolean', 'true'::jsonb),
  ('leave', 'max_carry_forward_days', 'Max carry-forward days', 'Cap on carried-forward leave days (0 = no cap).', 'integer', '10'::jsonb),
  ('payroll', 'payslip_rounding', 'Round net pay to nearest (currency units)', 'e.g. 1 = no rounding, 10 = nearest 10.', 'integer', '1'::jsonb),
  ('security', 'session_timeout_minutes', 'Session timeout (minutes)', 'How long an idle session stays valid — informational until wired into token expiry per tenant.', 'integer', '720'::jsonb),
  ('security', 'max_login_attempts', 'Max failed login attempts before lockout', 'Mirrors AuthService''s existing lockout threshold; overridable per tenant.', 'integer', '5'::jsonb)
ON CONFLICT (category, setting_key) DO NOTHING;

-- ---------------------------------------------------------------------
-- 5. Subscription / seats (TM-025/026), Usage (TM-027), Integrations
--    (TM-031), Health (TM-032), Support (TM-033), Backups (TM-035),
--    Data export (TM-036), saved views (TM-003).
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tenant_subscription_history (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  from_tier        text,
  to_tier          text NOT NULL,
  seats_purchased  integer,
  changed_by       text NOT NULL,
  changed_at       timestamptz NOT NULL DEFAULT now()
);

-- Real daily counters (not a mock) — incremented by TenantUsageInterceptor
-- (API requests) and MailerService (emails actually sent/logged) so the
-- Usage dashboard's api/email figures are genuine, not fabricated.
CREATE TABLE IF NOT EXISTS tenant_daily_usage_counter (
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  usage_date          date NOT NULL DEFAULT CURRENT_DATE,
  api_request_count   integer NOT NULL DEFAULT 0,
  email_sent_count    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, usage_date)
);

CREATE TABLE IF NOT EXISTS tenant_integrations (
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider_key  text NOT NULL CHECK (provider_key IN ('smtp', 'sso', 'biometric_device', 'webhook')),
  enabled       boolean NOT NULL DEFAULT false,
  config        jsonb NOT NULL DEFAULT '{}'::jsonb, -- may contain secrets — never returned by GET, see service
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text NOT NULL,
  PRIMARY KEY (company_id, provider_key)
);

CREATE TABLE IF NOT EXISTS tenant_health_check_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid REFERENCES companies(id) ON DELETE CASCADE, -- null = platform-wide check
  check_key    text NOT NULL,
  status       text NOT NULL CHECK (status IN ('ok', 'degraded', 'down')),
  detail       text,
  checked_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tenant_health_check_log_lookup ON tenant_health_check_log (company_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS support_tickets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  subject      text NOT NULL,
  description  text NOT NULL,
  priority     text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  created_by   text NOT NULL,
  assignee     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_company ON support_tickets (company_id);

CREATE TABLE IF NOT EXISTS tenant_backups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  size_bytes    bigint,
  file_key      text, -- FileStorageService key of the resulting JSON snapshot
  requested_by  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  error         text
);
CREATE INDEX IF NOT EXISTS idx_tenant_backups_company ON tenant_backups (company_id);

CREATE TABLE IF NOT EXISTS tenant_data_exports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  scope         text NOT NULL CHECK (scope IN ('full', 'employees', 'payroll', 'attendance')),
  format        text NOT NULL DEFAULT 'json' CHECK (format IN ('json', 'csv')),
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  file_key      text,
  size_bytes    bigint,
  requested_by  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  expires_at    timestamptz,
  error         text
);
CREATE INDEX IF NOT EXISTS idx_tenant_data_exports_company ON tenant_data_exports (company_id);

-- Platform Admin's own saved tenant-list searches (TM-003) — not tenant
-- data at all (no company_id), so it sits outside the RLS block below.
CREATE TABLE IF NOT EXISTS platform_saved_views (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  filters     jsonb NOT NULL,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON
  user_sessions, module_features, tenant_feature_entitlement,
  tenant_configuration_defaults, tenant_configuration, tenant_configuration_versions,
  tenant_subscription_history, tenant_daily_usage_counter, tenant_integrations,
  tenant_health_check_log, support_tickets, tenant_backups, tenant_data_exports,
  platform_saved_views
  TO app_role;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
-- Every table below is reached only via /platform/tenants/... routes per
-- the spec's own Route column — Platform-Admin/service only, no tenant
-- self-service tier, matching tenant_module_entitlement_write (0006).
-- user_sessions is the one exception with a slightly wider SELECT (a
-- session's own guard check needs to read its own row — done under
-- is_service claims from the guard, see auth module changes, so the
-- policy below is still satisfied without opening this to end users).

ALTER TABLE user_sessions                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions                  FORCE ROW LEVEL SECURITY;
ALTER TABLE module_features                ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_features                FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_feature_entitlement     ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_feature_entitlement     FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_configuration_defaults  ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_configuration_defaults  FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_configuration           ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_configuration           FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_configuration_versions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_configuration_versions  FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_subscription_history    ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_subscription_history    FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_daily_usage_counter     ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_daily_usage_counter     FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_integrations            ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_integrations            FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_health_check_log        ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_health_check_log        FORCE ROW LEVEL SECURITY;
ALTER TABLE support_tickets                ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets                FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_backups                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_backups                 FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_data_exports            ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_data_exports            FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_saved_views           ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_saved_views           FORCE ROW LEVEL SECURITY;

CREATE POLICY user_sessions_all ON user_sessions FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

CREATE POLICY module_features_select ON module_features FOR SELECT
  USING (app.jwt() ? 'sub');
CREATE POLICY module_features_write ON module_features FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

CREATE POLICY tenant_feature_entitlement_all ON tenant_feature_entitlement FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

CREATE POLICY tenant_configuration_defaults_select ON tenant_configuration_defaults FOR SELECT
  USING (app.jwt() ? 'sub');
CREATE POLICY tenant_configuration_defaults_write ON tenant_configuration_defaults FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

CREATE POLICY tenant_configuration_all ON tenant_configuration FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

CREATE POLICY tenant_configuration_versions_all ON tenant_configuration_versions FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

CREATE POLICY tenant_subscription_history_all ON tenant_subscription_history FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

CREATE POLICY tenant_daily_usage_counter_all ON tenant_daily_usage_counter FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

CREATE POLICY tenant_integrations_all ON tenant_integrations FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

CREATE POLICY tenant_health_check_log_all ON tenant_health_check_log FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

CREATE POLICY support_tickets_all ON support_tickets FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

CREATE POLICY tenant_backups_all ON tenant_backups FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

CREATE POLICY tenant_data_exports_all ON tenant_data_exports FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

CREATE POLICY platform_saved_views_all ON platform_saved_views FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());
