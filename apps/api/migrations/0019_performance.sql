-- Phase 11 — Performance & Goals
--
-- Plan doc Section 7's Phase 11 row: "Review cycles, calibration." Three
-- real objects — `review_cycles`, `goals`, `performance_reviews` —
-- licensed under the `performance` module key already seeded in
-- 0006_module_entitlement.sql's catalog (the same "the module_key was
-- provisioned ahead of the phase that builds it" pattern Phase 10's
-- `recruitment` key already followed). Reuses the same three real roles
-- Phase 7 introduced (hr_admin/line_manager/employee_self_service)
-- rather than inventing new ones — a review cycle, a goal, and a
-- performance review are all just more facts about the same Employee
-- object those roles already govern, the same reasoning Phase 8's and
-- Phase 9's own seeds already used.
--
-- Deliberately does NOT route anything through the Phase 6 workflow
-- engine — unlike Phase 9 (which genuinely needed a new
-- `manager_of_submitter` approver type) and unlike Phase 10 (which
-- reused the engine's existing `role` approver type as-is for
-- requisition approval), nothing in this phase's exit criterion asks for
-- a multi-step, tenant-configurable APPROVAL CHAIN anywhere in this
-- object graph. A review cycle is launched by one HR Admin action;
-- calibration is one HR Admin action adjusting ratings before release.
-- Section 10's "don't over-generalize the engine" guardrail gets a third
-- distinct data point here, after Phase 9 (add a real new capability) and
-- Phase 10 (reuse an existing one as-is): sometimes the right answer is
-- no engine involvement at all. See Decision #11 for the full writeup,
-- including why a future "route calibration adjustments through an
-- approval step" ask would be a real, deliberate addition rather than a
-- gap being silently left.
--
-- The self/manager-assessment-then-calibration visibility rule (an
-- employee never sees their manager's rating, the calibration
-- adjustment, or the final rating until HR releases the review) reuses
-- Phase 4's field-permission engine's CONDITIONAL rule mechanism exactly
-- as Phase 7 first used it for Termination Reason ("show field X only
-- when sibling field Y has value Z") — except the sibling field here
-- (`performance_reviews.status = 'released'`) is a status the object
-- itself transitions through over its own lifecycle, not a fixed
-- classification like employment status. Proves the same `{field,
-- equals}` JSONB condition shape generalizes to any field on the record,
-- not just the one case that motivated it. See 0020_performance_seed.sql
-- for the actual seeded rules.

-- ---------------------------------------------------------------------
-- review_cycles — a tenant-defined period ("H2 2026 Annual Review") with
-- an optional participant population. `participant_group_id` reuses
-- Phase 8's `employee_groups` mechanism for defining that population
-- (NULL means "all active employees" — resolved at launch time, not
-- stored as a frozen list, so an employee hired mid-cycle after launch
-- still shows up if they match). Deliberately ON DELETE SET NULL, not
-- CASCADE: deleting an employee group a cycle happens to reference
-- should not delete the cycle itself.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_cycles (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                        text NOT NULL,
  period_start                date NOT NULL,
  period_end                  date NOT NULL,
  participant_group_id        uuid REFERENCES employee_groups(id) ON DELETE SET NULL,
  status                      text NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft', 'active', 'calibration', 'closed')),
  created_by_user_account_id  uuid NOT NULL REFERENCES user_accounts(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);
CREATE INDEX IF NOT EXISTS idx_review_cycles_company ON review_cycles (company_id);

-- ---------------------------------------------------------------------
-- goals — one employee's objectives for a cycle. `parent_goal_id` is a
-- self-reference (a company- or department-level goal an individual
-- goal cascades from) rather than a separate "goal hierarchy" object —
-- the same one-self-referencing-column choice Section 5 already made for
-- the org chart (`employees.manager_id`) rather than a dedicated
-- hierarchy table.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS goals (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  review_cycle_id             uuid NOT NULL REFERENCES review_cycles(id) ON DELETE CASCADE,
  employee_id                 uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  parent_goal_id              uuid REFERENCES goals(id) ON DELETE SET NULL,
  title                       text NOT NULL,
  description                 text,
  weight                      numeric(5,2) CHECK (weight IS NULL OR (weight >= 0 AND weight <= 100)),
  status                      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  created_by_user_account_id  uuid NOT NULL REFERENCES user_accounts(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_goals_cycle ON goals (review_cycle_id);
CREATE INDEX IF NOT EXISTS idx_goals_employee ON goals (employee_id);
CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals (parent_goal_id);

-- ---------------------------------------------------------------------
-- performance_reviews — one row per employee per cycle (the exit
-- criterion's "final rating" object). `status` is this object's own
-- lifecycle, walked forward by `PerformanceService` rather than any
-- workflow instance: pending -> in_progress (either assessment
-- submitted) -> completed (both submitted) -> calibrated (HR adjusted,
-- still not visible to employee/manager) -> released (calibration_rating
-- or manager_rating copied into final_rating, now visible per
-- 0020_performance_seed.sql's field rules). `manager_rating`/
-- `calibration_rating`/`final_rating` are a 1-5 integer scale — the
-- simplest scale that supports "calibrate a distribution," not a
-- tenant-configurable rating scale (a real, documented Phase 17-territory
-- refinement if a client ever asks for one, per Section 10's guardrail
-- against building ahead of actual demand).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS performance_reviews (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  review_cycle_id                 uuid NOT NULL REFERENCES review_cycles(id) ON DELETE CASCADE,
  employee_id                     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  status                          text NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending', 'in_progress', 'completed', 'calibrated', 'released')),
  self_assessment                 text,
  self_assessment_submitted_at    timestamptz,
  manager_assessment              text,
  manager_rating                  integer CHECK (manager_rating BETWEEN 1 AND 5),
  manager_assessment_submitted_at timestamptz,
  calibration_rating              integer CHECK (calibration_rating BETWEEN 1 AND 5),
  calibration_comment             text,
  calibrated_by_user_account_id   uuid REFERENCES user_accounts(id),
  calibrated_at                   timestamptz,
  final_rating                    integer CHECK (final_rating BETWEEN 1 AND 5),
  released_at                     timestamptz,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (review_cycle_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_performance_reviews_cycle ON performance_reviews (review_cycle_id);
CREATE INDEX IF NOT EXISTS idx_performance_reviews_employee ON performance_reviews (employee_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON review_cycles, goals, performance_reviews TO app_role;

-- Same genuine tenant-scoped-write RLS shape as every real end-user
-- object since Phase 7 — HR Admins, managers, and employees themselves
-- write these tables directly.
ALTER TABLE review_cycles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_cycles        FORCE ROW LEVEL SECURITY;
ALTER TABLE goals                ENABLE ROW LEVEL SECURITY;
ALTER TABLE goals                FORCE ROW LEVEL SECURITY;
ALTER TABLE performance_reviews  ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_reviews  FORCE ROW LEVEL SECURITY;

CREATE POLICY review_cycles_all ON review_cycles FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY goals_all ON goals FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY performance_reviews_all ON performance_reviews FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
