-- Phase 3 fix — user_accounts RLS policies must not crash on a
-- non-UUID `sub` claim
--
-- Found by running the real login flow end to end (not a hypothetical):
-- AuthService's pre-authentication queries run under SERVICE_CLAIMS,
-- whose `sub` is the literal string "auth-service" (see auth.service.ts
-- and the equivalent "seed-script" in database/seed.ts) — a deliberately
-- readable marker, not a UUID, since is_service is what actually grants
-- access and sub is otherwise unused in that path.
--
-- Migration 0002's user_accounts_select/update policies did:
--   id = NULLIF(app.jwt() ->> 'sub', '')::uuid
-- NULLIF only protects against an *empty* string; casting any other
-- non-UUID text still throws "invalid input syntax for type uuid" —
-- and Postgres does not guarantee OR short-circuits its operands, so
-- `app.is_service() OR id = ...bad cast...` can still evaluate (and
-- fail on) the second operand even though the first is already true.
-- CASE WHEN, unlike OR, has a documented short-circuit guarantee — it's
-- Postgres's own recommended idiom for exactly this class of "only
-- evaluate this if that other thing is false" problem (see the
-- divide-by-zero example in the Postgres docs for CASE) — so that's
-- what replaces the OR chain here.
--
-- This is a database-level fix because the bug is in the policy's own
-- logic, not in any particular caller's claims — a future `is_service`
-- or `is_platform_admin` caller with a non-UUID `sub` would hit the same
-- crash otherwise, no matter how careful the application code is.

DROP POLICY IF EXISTS user_accounts_select ON user_accounts;
CREATE POLICY user_accounts_select ON user_accounts FOR SELECT
  USING (
    CASE
      WHEN app.is_platform_admin() OR app.is_service() THEN true
      ELSE id = NULLIF(app.jwt() ->> 'sub', '')::uuid
    END
  );

DROP POLICY IF EXISTS user_accounts_update ON user_accounts;
CREATE POLICY user_accounts_update ON user_accounts FOR UPDATE
  USING (
    CASE
      WHEN app.is_platform_admin() OR app.is_service() THEN true
      ELSE id = NULLIF(app.jwt() ->> 'sub', '')::uuid
    END
  )
  WITH CHECK (
    CASE
      WHEN app.is_platform_admin() OR app.is_service() THEN true
      ELSE id = NULLIF(app.jwt() ->> 'sub', '')::uuid
    END
  );
