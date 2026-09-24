-- Permanent, database-level close-out for the bug 0044_normalize_emails.sql
-- backfilled: user_accounts/platform_admins/company_admins.email have
-- always had a plain, byte-for-byte-case-sensitive UNIQUE constraint
-- (0001_platform_admin_core.sql / 0002_auth_identity.sql), which let
-- "Admin@x.com" and "admin@x.com" both exist as if they were different
-- people. auth/email.util.ts's normalizeEmail() already stops every
-- known write site from INSERTing a new case-variant duplicate — but
-- that's still "the application code remembers to check correctly." A
-- unique INDEX on the case-insensitive value makes it impossible at the
-- database level too, regardless of any future code path, a raw SQL
-- script, or a bug in some write site nobody thought to audit — the same
-- posture companies.slug already has via its own UNIQUE constraint.
--
-- Safe to add now specifically because 0044 (which runs before this one,
-- by filename order) already normalized every existing row — this would
-- fail with the exact same "duplicate key" error 0044 can hit if any
-- case-variant duplicate still existed when this runs. Existing
-- duplicates must be resolved by hand (delete/merge the extra row) before
-- both 0044 and this migration can apply.
--
-- Left the original exact-match UNIQUE constraints in place rather than
-- dropping them — redundant once every row is normalized, but harmless,
-- and removing them isn't necessary for this fix.
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

CREATE UNIQUE INDEX company_admins_company_id_email_ci_key
  ON company_admins (company_id, lower(trim(email)));

CREATE UNIQUE INDEX platform_admins_email_ci_key
  ON platform_admins (lower(trim(email)));

CREATE UNIQUE INDEX user_accounts_email_ci_key
  ON user_accounts (lower(trim(email)));
