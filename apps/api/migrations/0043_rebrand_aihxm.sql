-- Rebrand: "BoostFactor" -> "AIHXM" in seeded data.
--
-- Migration 0006_module_entitlement.sql seeded the Professional package
-- tier's description with the old product name. That migration is never
-- edited after shipping (any database that already applied it has the old
-- text permanently, since _migrations tracking is by filename only, not
-- content hash) — so the fix is a new migration that updates the row,
-- exactly like every other post-hoc data correction in this codebase.
-- Scoped with a WHERE clause so it's a safe no-op if this ever runs
-- against a database that was seeded fresh with the new wording already.
--
-- package_tier has FORCE ROW LEVEL SECURITY (0006), which applies even to
-- the migration/owner role connecting here — the same reason
-- 0023_payroll_seed.sql and friends set a service claim before writing to
-- an already-FORCE'd table, reused here rather than inventing a second
-- way to satisfy the same RLS policy.
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

UPDATE package_tier
SET description = replace(description, 'BoostFactor', 'AIHXM')
WHERE description LIKE '%BoostFactor%';
