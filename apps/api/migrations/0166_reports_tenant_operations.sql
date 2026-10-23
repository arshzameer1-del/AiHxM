-- Reports & Analytics: read-only operational metadata for the caller's own company.
--
-- Why: tenant_configuration, tenant_integrations, tenant_daily_usage_counter, tenant_data_exports and tenant_health_check_log
-- are readable only by the platform or the service role. The security-configuration, usage, export, integration and health
-- reports (J13, N01, N07, N08, N10, N11, N12) must show a company its OWN rows. Instead of widening those policies, narrow
-- SECURITY DEFINER functions return only non-secret columns for app.current_company_id():
--   * app.report_company_configuration()  - category, key, value, status, effective dates, scope
--   * app.report_company_integrations()   - provider, enabled flags, last update. Never config, tokens or secrets
--   * app.report_company_usage()          - daily API request and email counters
--   * app.report_company_exports()        - export status, size, timings. Never the file key
--   * app.report_company_health()         - health-check results
-- With no company in the session each returns nothing.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS app.report_company_health(); DROP FUNCTION IF EXISTS app.report_company_exports();
--   DROP FUNCTION IF EXISTS app.report_company_usage(); DROP FUNCTION IF EXISTS app.report_company_integrations();
--   DROP FUNCTION IF EXISTS app.report_company_configuration();

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

CREATE OR REPLACE FUNCTION app.report_company_configuration()
RETURNS TABLE (category text, setting_key text, value text, status text, effective_from date, effective_to date, scope_type text, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT tc.category, tc.setting_key, tc.value::text, tc.status, tc.effective_from, tc.effective_to, tc.scope_type, tc.updated_at
    FROM tenant_configuration tc WHERE app.current_company_id() IS NOT NULL AND tc.company_id = app.current_company_id()
$$;

CREATE OR REPLACE FUNCTION app.report_company_integrations()
RETURNS TABLE (provider_key text, enabled boolean, scim_enabled boolean, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT ti.provider_key, ti.enabled, ti.scim_enabled, ti.updated_at
    FROM tenant_integrations ti WHERE app.current_company_id() IS NOT NULL AND ti.company_id = app.current_company_id()
$$;

CREATE OR REPLACE FUNCTION app.report_company_usage()
RETURNS TABLE (usage_date date, api_request_count integer, email_sent_count integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.usage_date, u.api_request_count, u.email_sent_count
    FROM tenant_daily_usage_counter u WHERE app.current_company_id() IS NOT NULL AND u.company_id = app.current_company_id()
$$;

CREATE OR REPLACE FUNCTION app.report_company_exports()
RETURNS TABLE (id uuid, scope text, format text, status text, size_bytes bigint, created_at timestamptz, completed_at timestamptz, expires_at timestamptz, is_password_protected boolean, error text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT x.id, x.scope, x.format, x.status, x.size_bytes, x.created_at, x.completed_at, x.expires_at, x.is_password_protected, x.error
    FROM tenant_data_exports x WHERE app.current_company_id() IS NOT NULL AND x.company_id = app.current_company_id()
$$;

CREATE OR REPLACE FUNCTION app.report_company_health()
RETURNS TABLE (check_key text, status text, detail text, checked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT h.check_key, h.status, h.detail, h.checked_at
    FROM tenant_health_check_log h WHERE app.current_company_id() IS NOT NULL AND h.company_id = app.current_company_id()
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['report_company_configuration', 'report_company_integrations', 'report_company_usage', 'report_company_exports', 'report_company_health'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION app.%I() FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.%I() TO app_role', f);
  END LOOP;
END $$;
