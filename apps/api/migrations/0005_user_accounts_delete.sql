-- Phase 4 addendum — user_accounts had no DELETE grant or policy at all
--
-- Surfaced by writing this phase's own test suite: cleaning up test
-- fixtures needs to delete user_accounts rows, and doing that hit
-- "permission denied for table user_accounts" — migration 0002 granted
-- SELECT/INSERT/UPDATE to app_role but never DELETE, and defined no
-- DELETE policy either. That's not just a test-harness gap: there is
-- currently no way, even at the database layer, for a Platform Admin to
-- remove a mistakenly-created or compromised account. This closes it the
-- same way every other write surface in this schema is closed —
-- Platform-Admin-or-service only, no self-service deletion, no UI/endpoint
-- exposes it yet (none is needed until a real use case asks for one).

GRANT DELETE ON user_accounts TO app_role;

CREATE POLICY user_accounts_delete ON user_accounts FOR DELETE
  USING (app.is_platform_admin() OR app.is_service());
