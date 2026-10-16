-- Keeps Row Level Security ON for `configuration_registry` and makes it work: a read-only policy for app_role.
-- Why: the table is a global product catalog (no company_id, no tenant data). RLS being ON with no policy hides every row
-- from app_role, so the Configuration Center came back empty (0115 and 0157 fixed that by switching RLS off, but Supabase's
-- advisor tends to switch it back on). With this policy the page works whether RLS is on or off, so nobody has to fight the advisor.
-- Only SELECT is allowed; nothing can write the catalog through the app role. Other roles (anon, authenticated) get no policy,
-- so they still see nothing.
-- Idempotent. ROLLBACK: DROP POLICY configuration_registry_read ON configuration_registry; (the page then needs RLS off, see 0157).
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);
GRANT SELECT ON configuration_registry TO app_role;
ALTER TABLE configuration_registry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS configuration_registry_read ON configuration_registry;
CREATE POLICY configuration_registry_read ON configuration_registry FOR SELECT TO app_role USING (true);
