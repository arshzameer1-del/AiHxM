-- Phase 3 — Auth & Identity
--
-- Real per-account authentication (password + mandatory TOTP MFA),
-- replacing Phase 2's single shared platform-admin credential outright.
-- Also the first half of the User-vs-Employee identity split (plan doc
-- Section 3 / Phase 3 row): a login identity (user_accounts) is now a
-- distinct object from the admin *profile* rows it's linked to.
-- Employee itself doesn't exist until Phase 7 — when it lands, it links
-- to this same user_accounts table rather than getting its own separate
-- identity concept invented from scratch.
--
-- Supabase note: this is genuine authentication against local/self-hosted
-- Postgres, not a placeholder — provisioning a live Supabase project
-- still hasn't happened (needs the account owner's own credentials).
-- When it does, the standard move is to let Supabase Auth's `auth.users`
-- become the identity source of truth and either point user_accounts.id
-- at the same id or fold this table into the app-side profile pattern
-- Supabase projects already use. Nothing about RLS or RequestClaims
-- changes either way — see Decision #1's portability note.

-- ---------------------------------------------------------------------
-- app.is_service() — a claim only OUR OWN server code ever sets
-- ---------------------------------------------------------------------
-- Login has a chicken-and-egg problem: verifying a password requires
-- reading user_accounts by email, before the caller has any valid JWT to
-- carry claims at all. `is_service` is how the API's own auth code (never
-- a request handler acting on a client-supplied token) reaches those
-- tables during that pre-authentication window. This is safe by
-- construction, not by trust: every guard in this codebase builds
-- RequestClaims field-by-field from a verified JWT's payload (see
-- PlatformAdminGuard) rather than spreading the decoded token, so
-- `is_service` can never be smuggled in through a client-supplied JWT —
-- it only ever originates from a literal `{ is_service: true, ... }`
-- object written in auth.service.ts or the seed script.

CREATE OR REPLACE FUNCTION app.is_service() RETURNS boolean
  LANGUAGE sql STABLE
AS $$
  SELECT COALESCE((app.jwt() ->> 'is_service')::boolean, false)
$$;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_accounts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                  text NOT NULL UNIQUE,
  password_hash          text NOT NULL,
  -- AES-256-GCM ciphertext (iv:authTag:ciphertext, hex), never plaintext.
  -- Set as soon as enrollment starts; `mfa_enabled` is what makes it live.
  mfa_secret_encrypted   text,
  mfa_enabled            boolean NOT NULL DEFAULT false,
  -- Manual admin action (Platform Admin panel), independent of the
  -- automatic cool-down below. Either one blocks login.
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked')),
  failed_login_attempts  int NOT NULL DEFAULT 0,
  locked_until           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE platform_admins
  ADD COLUMN IF NOT EXISTS user_account_id uuid REFERENCES user_accounts(id),
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked'));

ALTER TABLE company_admins
  ADD COLUMN IF NOT EXISTS user_account_id uuid REFERENCES user_accounts(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_admins_user_account
  ON platform_admins (user_account_id) WHERE user_account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_admins_user_account
  ON company_admins (user_account_id) WHERE user_account_id IS NOT NULL;

-- Single-use, hashed (never store the raw token), short-lived.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  token_hash      text NOT NULL,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_account
  ON password_reset_tokens (user_account_id);

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON user_accounts TO app_role;
GRANT SELECT, INSERT, UPDATE ON password_reset_tokens TO app_role;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------

ALTER TABLE user_accounts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_accounts          FORCE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens  ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens  FORCE ROW LEVEL SECURITY;

-- A caller sees/updates their own account, a platform admin sees every
-- account, and the auth service itself can operate before either of
-- those identities is established (that's the whole reason it exists).
CREATE POLICY user_accounts_select ON user_accounts FOR SELECT
  USING (
    app.is_platform_admin()
    OR app.is_service()
    OR id = NULLIF(app.jwt() ->> 'sub', '')::uuid
  );
CREATE POLICY user_accounts_insert ON user_accounts FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service());
CREATE POLICY user_accounts_update ON user_accounts FOR UPDATE
  USING (
    app.is_platform_admin()
    OR app.is_service()
    OR id = NULLIF(app.jwt() ->> 'sub', '')::uuid
  )
  WITH CHECK (
    app.is_platform_admin()
    OR app.is_service()
    OR id = NULLIF(app.jwt() ->> 'sub', '')::uuid
  );

CREATE POLICY password_reset_tokens_all ON password_reset_tokens FOR ALL
  USING (app.is_service() OR app.is_platform_admin())
  WITH CHECK (app.is_service() OR app.is_platform_admin());

-- Extend migration 0001's platform_admins / company_admins SELECT
-- policies so the login flow can resolve "which admin row does this
-- user_account belong to, and is it locked" before a real session JWT
-- exists. Write policies are unchanged — creating or updating an admin
-- profile always happens under an authenticated Platform Admin session,
-- never the pre-auth service context, except the one-time seed script
-- bootstrapping the very first platform admin (hence is_service on
-- platform_admins' insert/update too).
DROP POLICY IF EXISTS platform_admins_select ON platform_admins;
CREATE POLICY platform_admins_select ON platform_admins FOR SELECT
  USING (app.is_platform_admin() OR app.is_service());

DROP POLICY IF EXISTS platform_admins_write ON platform_admins;
CREATE POLICY platform_admins_write ON platform_admins FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service());

CREATE POLICY platform_admins_update ON platform_admins FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());

DROP POLICY IF EXISTS company_admins_select ON company_admins;
CREATE POLICY company_admins_select ON company_admins FOR SELECT
  USING (
    app.is_platform_admin()
    OR app.is_service()
    OR company_id = app.current_company_id()
  );
