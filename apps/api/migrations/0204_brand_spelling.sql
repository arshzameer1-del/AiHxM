-- Brand spelling: the product name is written "AiHxM" everywhere people can read it.
--
-- 0043_rebrand_aihxm.sql wrote the seeded package description with the spelling "AIHXM". Migrations are never edited after they ship,
-- so this one corrects the row. Scoped with a WHERE clause (and a case-sensitive match) so it is a no-op on a database that already
-- has the right spelling. package_tier has FORCE ROW LEVEL SECURITY, so the service claim is set first, as in 0043.
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

UPDATE package_tier
SET description = replace(replace(description, 'AIHXM', 'AiHxM'), 'AI HXM', 'AiHxM')
WHERE description LIKE '%AIHXM%' OR description LIKE '%AI HXM%';
