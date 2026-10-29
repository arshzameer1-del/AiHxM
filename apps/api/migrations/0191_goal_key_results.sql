-- OKR key results: a goal (the objective) can be measured by several key results, each with a start value, a target and a current value.
-- When a goal has key results its progress is the weighted average of theirs. Weights here are relative (1, 2, 3 ...), not a share of 100.
-- A goal with no key results behaves exactly as before.
CREATE TABLE IF NOT EXISTS goal_key_results (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  goal_id        uuid NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  title          text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  start_value    numeric(14,2) NOT NULL DEFAULT 0,
  target_value   numeric(14,2) NOT NULL,
  current_value  numeric(14,2) NOT NULL DEFAULT 0,
  unit           text CHECK (unit IS NULL OR char_length(unit) <= 40),
  weight         numeric(6,2) NOT NULL DEFAULT 1 CHECK (weight > 0 AND weight <= 100),
  progress_pct   numeric(5,2) NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
  position       integer NOT NULL DEFAULT 0,
  created_by     uuid REFERENCES user_accounts(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT goal_key_results_distinct CHECK (target_value <> start_value)
);
CREATE INDEX IF NOT EXISTS idx_goal_key_results_goal ON goal_key_results (goal_id, position);

GRANT SELECT, INSERT, UPDATE, DELETE ON goal_key_results TO app_role;
ALTER TABLE goal_key_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE goal_key_results FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS goal_key_results_all ON goal_key_results;
CREATE POLICY goal_key_results_all ON goal_key_results FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
