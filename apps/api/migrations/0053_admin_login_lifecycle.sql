-- Tenant Management gap-fill Phase 1 item #8 — Login/invitation lifecycle
-- visibility. AIHXM hands a Platform-Admin-chosen password straight to the
-- tenant admin rather than emailing an accept-link (there's no separate
-- "invitation" row anywhere in this schema), so "pending" vs "accepted"
-- here means exactly what it can honestly mean given that design: has this
-- login ever actually been used to sign in yet, or is it still sitting
-- unused since the moment a Platform Admin created/reset it.
--
-- `last_login_at` is the one new column this needs — stamped by
-- AuthService.issueSessionToken() on every REAL session issuance (normal
-- login, MFA enrollment completion). Deliberately NOT touched by
-- CompaniesService.impersonate() (a different INSERT path, Phase 1 item
-- #4) — a Platform Admin borrowing a tenant admin's session via "Login As"
-- must never count as that admin having accepted their own login.

-- `credential_issued_at` tracks when the CURRENT password was (re)issued —
-- distinct from `created_at` (when the login/user_accounts row itself was
-- first created), because resetAdminPassword() ("Resend" in the UI) issues
-- a brand-new credential for an existing login and that new credential
-- hasn't been used yet either, even if an earlier one was. Existing rows
-- default to the migration's own run time rather than their true (unknown)
-- issuance date — this codebase has no historical record of that, the
-- same honest limitation `last_login_at` below has for existing logins.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS credential_issued_at timestamptz NOT NULL DEFAULT now();
