-- Fix: GET /api/configuration-center returned [] again on production (Configuration Center page empty for a login
-- holding every role, 2026-10-16). Same cause as 0115: `configuration_registry` is a GLOBAL catalog (no company_id,
-- no tenant data) and must not have Row Level Security. With RLS switched on and no policy (typically by Supabase's
-- "Enable RLS" advisor), app_role sees zero rows, so ConfigurationCenterService never gets as far as the per-domain
-- permission checks.
-- Idempotent: DISABLE is a no-op when RLS is already off; the GRANT only restores the original 0032 grant.
-- ROLLBACK: none needed (restores the intended state). Do not re-enable RLS on this table.
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);
ALTER TABLE configuration_registry DISABLE ROW LEVEL SECURITY;
GRANT SELECT ON configuration_registry TO app_role;
