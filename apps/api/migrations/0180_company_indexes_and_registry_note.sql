-- 0180: indexes for tenant-wide reads, and a note on configuration_registry.
--
-- Every tenant query is filtered by row-level security on company_id. 87 tables had a foreign key on company_id with no
-- index that starts with company_id (several have (employee_id, ...) style indexes, which do not help a "whole company"
-- list, report or payroll run). Add a plain (company_id) index to each. Idempotent: the loop only creates what is missing.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conrelid, c.conrelid::regclass::text AS tbl, c.conkey[1] AS attnum
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE c.contype = 'f'
      AND a.attname = 'company_id'
      AND array_length(c.conkey, 1) = 1
      AND t.relkind IN ('r', 'p')
      AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])
  LOOP
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %s (company_id)', left('idx_' || replace(r.tbl, '.', '_'), 55) || '_company', r.tbl);
  END LOOP;
END $$;

-- configuration_registry is a global, read-only catalogue (one policy: SELECT for everyone; app_role holds SELECT only).
-- Row-level security is deliberately NOT forced: migrations, which run as the table owner, add catalogue rows.
COMMENT ON TABLE configuration_registry IS 'Global read-only catalogue of configuration cards. RLS enabled (read policy), intentionally not FORCEd so migrations can seed it.';
