-- PERF1: top-level tenant tables that had no index starting with company_id. Every query on them is filtered by company
-- (row security + the WHERE), so without it each lookup reads the whole table. Child tables are reached through their
-- parent's id and already have that index. Additive only; IF NOT EXISTS makes it safe to run twice.
CREATE INDEX IF NOT EXISTS comp_cycles_company ON comp_cycles (company_id);
CREATE INDEX IF NOT EXISTS headcount_plans_company ON headcount_plans (company_id);
CREATE INDEX IF NOT EXISTS talent_assessments_company ON talent_assessments (company_id, employee_id);
CREATE INDEX IF NOT EXISTS asset_events_company ON asset_events (company_id, created_at DESC);
