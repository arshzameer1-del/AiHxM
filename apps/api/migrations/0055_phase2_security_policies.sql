-- Phase 2 gap-fill items #1/#3/#4 — password/authentication policy
-- profiles, IP allow/denylist, and concurrent session limits, all per
-- tenant. Purely additive: new rows in the ALREADY-BUILT
-- `tenant_configuration_defaults` table (migration 0042) rather than new
-- columns or tables. Two of these settings ('security'.'max_login_attempts'
-- and 'security'.'session_timeout_minutes') already existed as of 0042 but
-- were never actually read by AuthService — its own seed comments say so
-- directly ("overridable per tenant" / "informational until wired into
-- token expiry per tenant"). This migration adds the two settings needed
-- to complete that pair (a configurable lockout duration to go with the
-- attempt threshold, and a concurrent-session cap) plus the two IP-list
-- settings — auth.service.ts and session.guard.ts are what actually wire
-- all four (old and new) into real enforcement; see SessionSecurityService.
--
-- Because ConfigurationTab (CompanyDetailPage.tsx) renders every
-- tenant_configuration_defaults row generically by category, these four
-- new settings need NO frontend changes at all — they show up in the
-- existing "Tenant configuration" tab automatically, with the same
-- override/history/rollback UI every other setting already has.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO tenant_configuration_defaults (category, setting_key, label, description, value_type, default_value) VALUES
  ('security', 'lockout_duration_minutes', 'Lockout duration (minutes)', 'How long an account stays locked after hitting the failed-attempt threshold above. Paired with max_login_attempts.', 'integer', '15'::jsonb),
  ('security', 'max_concurrent_sessions', 'Max concurrent sessions per user', '0 = unlimited. When a new login would exceed this, the oldest active session for that user is signed out to make room.', 'integer', '0'::jsonb),
  ('security', 'ip_allowlist', 'Allowed IP addresses/ranges', 'Comma-separated IPv4 addresses or CIDR ranges (e.g. 203.0.113.4, 10.0.0.0/24). Empty = allow any IP. Applies to this tenant''s own portal, not Platform Admin access.', 'text', '""'::jsonb),
  ('security', 'ip_denylist', 'Blocked IP addresses/ranges', 'Comma-separated IPv4 addresses or CIDR ranges, checked before the allowlist above. Empty = block none.', 'text', '""'::jsonb)
ON CONFLICT (category, setting_key) DO NOTHING;
