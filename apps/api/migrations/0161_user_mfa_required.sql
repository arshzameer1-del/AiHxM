-- Per-login "must use an authenticator" switch, controlled by the company's System Admin.
-- true (default) = password + authenticator code at every sign-in (today's behaviour for everyone).
-- false = this login signs in with login ID + password only. Only ever honoured for ordinary company users
-- (never a Platform Admin or Company Admin account), see AuthService.authenticate.
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS mfa_required boolean NOT NULL DEFAULT true;
