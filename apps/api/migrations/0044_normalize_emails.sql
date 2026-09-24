-- Backfill: lowercase/trim every already-stored email on the three tables
-- that identify a login (user_accounts, platform_admins, company_admins).
--
-- None of these columns is `citext` — plain `text` with a plain `UNIQUE`
-- constraint (0001_platform_admin_core.sql / 0002_auth_identity.sql) — so
-- `WHERE email = $1` has always been byte-for-byte case-sensitive. Every
-- INSERT site now normalizes through auth/email.util.ts's normalizeEmail()
-- before writing (see that file's header comment for the incident this
-- fixes: a Platform Admin's "Add Admin" email and the tenant admin's own
-- typed-in login email matched except for case, so `/auth/login` returned
-- a generic "Invalid email or password" for a perfectly correct password).
-- This migration is the one-time cleanup for rows written before that
-- normalization existed — without it, an already-mismatched row stays
-- mismatched even after the code fix ships.
--
-- Scoped with a WHERE clause so it's a safe no-op on a database where
-- every row is already lowercase (including a fresh install seeded after
-- this migration exists).
--
-- All three tables have FORCE ROW LEVEL SECURITY, which applies even to
-- the migration/owner role connecting here — same reason every other
-- post-hoc data correction in this codebase (0023_payroll_seed.sql,
-- 0043_rebrand_aihxm.sql) sets a service claim before writing.
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

UPDATE user_accounts
SET email = lower(trim(email))
WHERE email <> lower(trim(email));

UPDATE platform_admins
SET email = lower(trim(email))
WHERE email <> lower(trim(email));

UPDATE company_admins
SET email = lower(trim(email))
WHERE email <> lower(trim(email));
