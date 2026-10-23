-- Reports & Analytics: read-only account and session metadata for the caller's own company.
--
-- Why: user_accounts is global (one login can serve several companies) and its row-level policy lets a tenant user see only
-- their own row; user_sessions is platform/service only. The access, authentication and adoption reports (I01, I02, I04,
-- J01, J05 to J07) need those facts for everyone in the caller's company. Rather than widening those policies, two narrow
-- SECURITY DEFINER functions return only non-secret columns, and only for people who belong to app.current_company_id():
--   * app.report_company_accounts()  - status, MFA flags, last sign-in, lockout state, credential age. Never the email,
--                                      password hash, MFA secret or any token.
--   * app.report_company_sessions()  - session start/last-seen/revoked times and device-risk flags. Never the IP address,
--                                      user agent or device label.
-- With no company in the session (or a platform admin without one) both return nothing.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS app.report_company_sessions();
--   DROP FUNCTION IF EXISTS app.report_company_accounts();

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

CREATE OR REPLACE FUNCTION app.report_company_accounts()
RETURNS TABLE (
  user_account_id uuid, status text, mfa_enabled boolean, mfa_required boolean, last_login_at timestamptz,
  locked_until timestamptz, failed_login_attempts integer, credential_issued_at timestamptz, auth_provider text, created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT ua.id, ua.status, ua.mfa_enabled, ua.mfa_required, ua.last_login_at, ua.locked_until, ua.failed_login_attempts,
         ua.credential_issued_at, ua.auth_provider, ua.created_at
    FROM user_accounts ua
   WHERE app.current_company_id() IS NOT NULL
     AND (EXISTS (SELECT 1 FROM user_role_assignments ura WHERE ura.user_account_id = ua.id AND ura.company_id = app.current_company_id())
          OR EXISTS (SELECT 1 FROM employees e WHERE e.user_account_id = ua.id AND e.company_id = app.current_company_id()))
$$;

CREATE OR REPLACE FUNCTION app.report_company_sessions()
RETURNS TABLE (
  user_account_id uuid, created_at timestamptz, last_seen_at timestamptz, expires_at timestamptz, revoked_at timestamptz,
  is_new_device boolean, is_rapid_network_change boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.user_account_id, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at, s.is_new_device, s.is_rapid_network_change
    FROM user_sessions s
   WHERE app.current_company_id() IS NOT NULL AND s.company_id = app.current_company_id() AND s.is_platform_admin = false
$$;

REVOKE ALL ON FUNCTION app.report_company_accounts() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.report_company_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.report_company_accounts() TO app_role;
GRANT EXECUTE ON FUNCTION app.report_company_sessions() TO app_role;
