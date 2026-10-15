-- Gap Register INT-04 (Step 0): DB-level overlap prevention for
-- effective-dated tables.
--
-- WHAT EXISTED: every table below already had a partial unique "one open
-- row" index (effective_to IS NULL). That stops two OPEN rows but does
-- nothing for CLOSED history: a backdated edit could still leave two
-- closed rows covering the same day, silently double-counting (e.g. two
-- salaries for one payroll day). This adds a real EXCLUDE constraint per
-- table over daterange(effective_from, effective_to, '[]') — effective_to
-- is INCLUSIVE here (EffectiveDatingEngine closes a row at
-- new_from - 1 day), NULL = open-ended.
--
-- SAFETY: additive and defensive. For each table the migration first
-- counts rows that already overlap; if any exist it does NOT fail the
-- deploy — it RAISEs a NOTICE naming the table and skips that constraint
-- so HR/engineering can clean the data and re-run (the block is
-- idempotent: re-running adds only what is still missing). Nothing is
-- rewritten or deleted.
--
-- ROLLBACK: ALTER TABLE <t> DROP CONSTRAINT <t>_no_overlap; for each
-- table below (btree_gist may stay installed; it is harmless).

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
DECLARE
  spec record;
  overlap_count bigint;
  cname text;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('employee_compensation',            'employee_id'),
      ('employee_compensation_components', 'employee_id, component_id'),
      ('shift_assignments',                'employee_id'),
      ('leave_policy_versions',            'policy_id'),
      ('tax_slabs',                        'company_id, min_annual_income'),
      ('payroll_settings',                 'company_id'),
      ('overtime_policies',                'company_id'),
      ('payroll_formulas',                 'company_id, formula_key')
    ) AS t(tbl, keycols)
  LOOP
    cname := spec.tbl || '_no_overlap';
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = cname) THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'SELECT count(*) FROM %1$I a JOIN %1$I b
         ON a.id < b.id
        AND (%2$s)
        AND daterange(a.effective_from, a.effective_to, ''[]'') && daterange(b.effective_from, b.effective_to, ''[]'')',
      spec.tbl,
      (SELECT string_agg(format('a.%1$I = b.%1$I', trim(c)), ' AND ') FROM unnest(string_to_array(spec.keycols, ',')) AS c)
    ) INTO overlap_count;

    IF overlap_count > 0 THEN
      RAISE NOTICE 'INT-04: % has % overlapping effective-dated row pair(s); constraint % NOT added — clean the data and re-run migrations', spec.tbl, overlap_count, cname;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I EXCLUDE USING gist (%s, daterange(effective_from, effective_to, ''[]'') WITH &&)',
      spec.tbl, cname,
      (SELECT string_agg(trim(c) || ' WITH =', ', ') FROM unnest(string_to_array(spec.keycols, ',')) AS c)
    );
  END LOOP;
END $$;
