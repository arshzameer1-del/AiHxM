-- Tenant Management gap-fill batch 1 — MFA recovery codes
--
-- Every account has mandatory MFA (Phase 3) with no fallback if the
-- authenticator device is lost, reset, or the phone is wiped — the only
-- recovery path today is a Platform Admin resetting the account's
-- password, which does nothing for a stuck MFA enrollment. Recovery
-- codes are the standard fallback (same pattern as Google/GitHub/AWS):
-- a batch of single-use codes issued once, right when MFA enrollment
-- completes, that can each substitute for a TOTP code at login exactly
-- once.
--
-- Modeled directly on password_reset_tokens (0002_auth_identity.sql):
-- hashed (never store the raw code), single-use (used_at), owned by
-- user_accounts with ON DELETE CASCADE. A fast hash (sha256, via
-- AuthService's existing sha256() helper) is appropriate here — these
-- are 10-character cryptographically random strings, not user-chosen
-- passwords, so unlike hashPassword's slow bcrypt-style hashing there's
-- no brute-force risk from a fast hash.
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  code_hash       text NOT NULL,
  used_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mfa_recovery_codes_user_account
  ON mfa_recovery_codes (user_account_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_recovery_codes TO app_role;

ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_recovery_codes FORCE ROW LEVEL SECURITY;

-- Same CASE WHEN short-circuit fix as 0003_fix_user_accounts_sub_cast.sql
-- (never a plain OR ahead of a UUID cast) — SERVICE_CLAIMS' sub is the
-- literal string "auth-service", not a UUID, and every pre-auth query in
-- AuthService (including the ones this feature adds) runs under exactly
-- those claims.
CREATE POLICY mfa_recovery_codes_select ON mfa_recovery_codes FOR SELECT
  USING (
    CASE
      WHEN app.is_platform_admin() OR app.is_service() THEN true
      ELSE user_account_id = NULLIF(app.jwt() ->> 'sub', '')::uuid
    END
  );
CREATE POLICY mfa_recovery_codes_insert ON mfa_recovery_codes FOR INSERT
  WITH CHECK (
    CASE
      WHEN app.is_platform_admin() OR app.is_service() THEN true
      ELSE user_account_id = NULLIF(app.jwt() ->> 'sub', '')::uuid
    END
  );
CREATE POLICY mfa_recovery_codes_update ON mfa_recovery_codes FOR UPDATE
  USING (
    CASE
      WHEN app.is_platform_admin() OR app.is_service() THEN true
      ELSE user_account_id = NULLIF(app.jwt() ->> 'sub', '')::uuid
    END
  )
  WITH CHECK (
    CASE
      WHEN app.is_platform_admin() OR app.is_service() THEN true
      ELSE user_account_id = NULLIF(app.jwt() ->> 'sub', '')::uuid
    END
  );
CREATE POLICY mfa_recovery_codes_delete ON mfa_recovery_codes FOR DELETE
  USING (
    CASE
      WHEN app.is_platform_admin() OR app.is_service() THEN true
      ELSE user_account_id = NULLIF(app.jwt() ->> 'sub', '')::uuid
    END
  );
