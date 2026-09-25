-- Phase 3 item #1 (first slice) — SSO & Identity Federation: OpenID
-- Connect as a Relying Party. The `tenant_integrations` 'sso' provider row
-- (TM-031, migration 0042) already exists and already models a client
-- secret with the established masking discipline — this reuses that row
-- as-is (its `config` jsonb just gains new, OIDC-specific keys read by
-- the application, not the database: `protocol`, `issuerUrl`, `clientId`,
-- `clientSecret` (already a masked field), `scopes`, `groupsClaim`,
-- `roleMapping`, `defaultRoleKey`) rather than adding a second
-- configuration table for the same concept. SAML 2.0 support and SCIM
-- provisioning are deliberately NOT in this migration — see the roadmap
-- doc's Phase 3 item #1 entry for why this is being shipped as three
-- separate slices instead of one large, harder-to-verify change.
--
-- What IS new here: (1) a place to remember which external IdP subject
-- maps to which local login, so the same person signing in twice becomes
-- the same account rather than two; (2) a way to mark a `user_accounts`
-- row as SSO-only, so the existing password/MFA login path can refuse it
-- with a clear, correct message instead of silently trying (and failing
-- oddly) to verify a password that was never meant to exist.

-- ---------------------------------------------------------------------
-- user_accounts.auth_provider
-- ---------------------------------------------------------------------
-- 'local' (the default, every existing row) authenticates the existing
-- way (password + mandatory TOTP MFA). 'sso' means this account was
-- created by, or has been linked to, an external IdP login — its
-- password_hash is a random, never-derivable placeholder (see
-- sso.service.ts's provisionAccount()), and AuthService.authenticate()
-- now refuses local-password login for these rows outright rather than
-- reaching that placeholder hash's comparison at all. MFA is not
-- separately enforced for 'sso' rows either — the IdP is trusted to
-- enforce its own, exactly like Supabase Auth or any other delegated
-- identity provider; AIHXM never sees a code to check.
ALTER TABLE user_accounts
  ADD COLUMN IF NOT EXISTS auth_provider text NOT NULL DEFAULT 'local'
    CHECK (auth_provider IN ('local', 'sso'));

-- ---------------------------------------------------------------------
-- federated_identities
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS federated_identities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- Fixed to 'sso' for now (the one provider_key this feature attaches
  -- to in tenant_integrations) — kept as a column, not hardcoded into the
  -- table name, so a second federation provider_key never needs a second
  -- near-identical table.
  provider_key      text NOT NULL DEFAULT 'sso' CHECK (provider_key = 'sso'),
  -- The IdP's own immutable subject identifier for this person (the
  -- ID token's `sub` claim) — never the email, which a person can change
  -- at the IdP without AIHXM ever finding out.
  external_subject  text NOT NULL,
  external_email    text,
  user_account_id   uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_login_at     timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_federated_identities_subject
  ON federated_identities (company_id, provider_key, external_subject);
CREATE INDEX IF NOT EXISTS idx_federated_identities_user_account
  ON federated_identities (user_account_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON federated_identities TO app_role;

ALTER TABLE federated_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE federated_identities FORCE ROW LEVEL SECURITY;

-- Same shape as tenant_integrations' own policy (0042): only the SSO
-- login flow itself (is_service — the same pre-authentication window
-- AuthService's own SERVICE_CLAIMS uses) or a Platform Admin ever touches
-- this table. No tenant-side "my linked SSO identities" self-service view
-- exists yet — a real, small, additive follow-up if it's ever asked for.
CREATE POLICY federated_identities_all ON federated_identities FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());
