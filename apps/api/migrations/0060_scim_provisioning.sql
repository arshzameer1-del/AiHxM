-- Phase 3 item #1 (third and final slice) — SSO & Identity Federation:
-- SCIM 2.0 inbound provisioning. Slices 1 (OIDC) and 2 (SAML) let a
-- tenant's people AUTHENTICATE through their own identity provider; this
-- slice lets that SAME identity provider proactively PROVISION and
-- DEPROVISION portal access — most importantly, disabling a login the
-- moment someone is removed from the IdP, without waiting for them to
-- attempt a login again. See the roadmap doc's Phase 3 item #1 entry for
-- the full design reasoning, including the deliberate scope decision this
-- schema reflects: SCIM here manages LOGIN/ACCESS (who can sign in, with
-- what role), never HR employee records (headcount, compensation,
-- personal data) — those stay owned inside AIHXM, created only by a
-- deliberate HR action, the same "record the human action, don't
-- automate a legally sensitive operation" principle migration
-- 0057_data_subject_requests.sql already established. Groups-resource
-- provisioning (push group membership -> roleMapping) is deliberately
-- NOT in this slice either, the same kind of narrow, documented scope
-- decision slice 2 made about SP-initiated request signing — a real,
-- additive follow-up if a tenant ever needs it; every SCIM-created user
-- gets `tenant_integrations.config.defaultRoleKey` (the same field OIDC/
-- SAML JIT provisioning already reads) until then.

-- ---------------------------------------------------------------------
-- tenant_integrations.scim_enabled / scim_bearer_token_hash
-- ---------------------------------------------------------------------
-- SCIM provisioning is configured on the SAME `sso` provider row OIDC and
-- SAML already share (one tenant, one "who is this and how do they get
-- in" integration) rather than a fourth provider_key — its role-mapping
-- (`config.defaultRoleKey`) is deliberately shared with OIDC/SAML JIT
-- provisioning too (SsoService.resolveRoleKey()), so an admin configures
-- "what role does a new SSO/SCIM user get" in exactly one place, never
-- two. Meaningful only for provider_key = 'sso' rows — the same
-- convention migration 0054's previous_secret_* columns already
-- established for a subset of providers rather than all four.
--
-- The token itself is stored HASHED (sha256 — a full 256-bit random
-- value, not a human password, so a fast hash is the right choice here,
-- exactly like migration 0049's recovery codes), never inside `config`
-- jsonb alongside the OIDC client secret or SAML certificate: this
-- credential authenticates INCOMING requests from the IdP (compared
-- against on every SCIM call, a materially different and much
-- higher-frequency access pattern than a write-only outbound secret) and
-- so warrants its own typed column ScimAuthGuard can index and compare
-- directly, rather than parsing it out of an untyped jsonb blob on every
-- request.
ALTER TABLE tenant_integrations
  ADD COLUMN IF NOT EXISTS scim_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS scim_bearer_token_hash text;

-- ---------------------------------------------------------------------
-- scim_provisioned_users
-- ---------------------------------------------------------------------
-- Deliberately NOT reusing federated_identities: that table's
-- `external_subject` is the identifier an IdP hands back at LOGIN time
-- (an OIDC ID token's `sub`, a SAML NameID) — for a SCIM-provisioned
-- account, the SCIM resource `id` AIHXM itself assigns (this row's own
-- `user_account_id`, returned as-is to the IdP) is not guaranteed to be
-- the same value that IdP later sends at an actual OIDC/SAML login for
-- the same person, and conflating the two risks silently creating a
-- second, duplicate JIT-provisioned account instead of recognizing the
-- same one. No real gap results from keeping them separate:
-- `SsoService.provisionAndIssueToken()`'s existing email-matching
-- fallback (slice 1, unchanged here) already links a later real SSO
-- login to whichever account this table's Create already made, by email
-- — this table only ever needs to remember SCIM's own bookkeeping (the
-- IdP's optional `externalId`, and the given/family name SCIM expects
-- echoed back in every response), never an identifier meant to be
-- matched against a login claim.
--
-- given_name/family_name exist ONLY so a SCIM response can echo back
-- what the IdP itself sent (most SCIM clients expect to read back what
-- they wrote) — the product's own display name for a real employee still
-- comes from a genuine employees.first_name/last_name row when one
-- exists. Nothing else in this codebase ever reads these two columns.
CREATE TABLE IF NOT EXISTS scim_provisioned_users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_account_id  uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  external_id      text,
  given_name       text,
  family_name      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_scim_provisioned_users_account
  ON scim_provisioned_users (company_id, user_account_id);
CREATE INDEX IF NOT EXISTS idx_scim_provisioned_users_external_id
  ON scim_provisioned_users (company_id, external_id) WHERE external_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON scim_provisioned_users TO app_role;

ALTER TABLE scim_provisioned_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE scim_provisioned_users FORCE ROW LEVEL SECURITY;

-- Same shape as federated_identities' own policy (migration 0059): only
-- the SCIM inbound flow itself (is_service — ScimAuthGuard's own
-- pre-authentication claims, the bearer-token equivalent of SsoService's
-- SERVICE_CLAIMS) or a Platform Admin ever touches this table.
CREATE POLICY scim_provisioned_users_all ON scim_provisioned_users FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());
