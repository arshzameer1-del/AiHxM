-- Phase 8 — Employee Groups & Leave Policy Config
--
-- This phase's whole job (plan doc Section 12): give Phase 9 (Leave &
-- Attendance) real, tenant-configurable policy groups to attach leave
-- entitlements to, instead of Phase 9 inventing a flat one-policy-fits-
-- all model it would later have to retrofit. The resolution mechanism is
-- explicitly required to REUSE Phase 4's own resolver pattern rather than
-- inventing a second one — see rbac.service.ts's `resolveFieldAccess()`
-- doc comment, which already named "most-specific-match-wins" as a
-- documented gap "for whenever a real module first needs it." This is
-- that module.
--
-- The three pieces of that pattern, carried over deliberately:
--   - MOST-SPECIFIC-MATCH-WINS: an employee_group is defined by one or
--     more ANDed attribute conditions (employee_group_conditions). When
--     more than one group matches the same employee for the same
--     policy_type, the group with MORE conditions wins — it is, by
--     construction, the more specific match. (Phase 4 flagged this exact
--     resolution rule as a gap for field_permission_rules; it's still
--     unbuilt there — nothing here touches that table — but the identical
--     algorithm is now real for employee groups.)
--   - ADDITIVE COMBINATION: resolution is independent per policy_type
--     (`employee_group_policy_assignments.policy_type` — only 'leave'
--     exists yet, more can be added later without touching this schema).
--     A caller resolving both 'leave' and some future 'attendance'
--     policy_type for the same employee gets each resolved on its own via
--     the same most-specific-match rule and the results combine — one
--     group's leave-policy assignment never competes with a different
--     group's (future) attendance-policy assignment the way RBAC's own
--     per-field rules never compete across different field_key values.
--   - SAFE-DENY DEFAULT: if no group matches at all (or a matching
--     group's specificity ties don't clear the ambiguity — see below), the
--     resolver falls back to the tenant's explicitly-designated default
--     policy for that policy_type (`leave_policies.is_default`), never an
--     arbitrary guess. If a tenant hasn't designated one, resolution
--     returns "no policy" rather than fabricating one — the same
--     "hidden unless something explicitly grants otherwise" posture
--     `resolveFieldAccess()` already uses for fields.
--
-- Employee attributes a group can condition on are deliberately a fixed,
-- validated set (enforced by the CHECK below, not left to typo into a
-- field that silently never matches): department, location,
-- designation, employmentType, employmentStatus — camelCase to match the
-- API-facing field keys the RBAC engine's own field_permission_rules
-- already uses (see Phase 4's "field_key values must be the API-facing
-- camelCase, not the DB column name" bug fixed in that phase).
--
-- `location` and `employmentType` are genuinely new employee attributes —
-- Phase 7 didn't need them, but the plan doc's own canonical example for
-- this phase ("Department=Engineering, Location=Karachi") names both, and
-- a multi-branch SMB or one that distinguishes permanent/contract/
-- probation/intern staff needs them for real, not just for this phase's
-- demo. Added here as a small, well-motivated ALTER rather than avoided.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE employees ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS employment_type text NOT NULL DEFAULT 'permanent'
  CHECK (employment_type IN ('permanent', 'contract', 'probation', 'intern'));

-- ---------------------------------------------------------------------
-- employee_groups — a named, tenant-defined segment of employees
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_groups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);
CREATE INDEX IF NOT EXISTS idx_employee_groups_company ON employee_groups (company_id);

-- One row per ANDed condition. A group's specificity for the
-- most-specific-match-wins rule is simply COUNT(*) of its rows here — no
-- separate "priority" column to keep in sync by hand.
CREATE TABLE IF NOT EXISTS employee_group_conditions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   uuid NOT NULL REFERENCES employee_groups(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  field      text NOT NULL
               CHECK (field IN ('department', 'location', 'designation', 'employmentType', 'employmentStatus')),
  equals     text NOT NULL,
  UNIQUE (group_id, field)
);
CREATE INDEX IF NOT EXISTS idx_employee_group_conditions_group ON employee_group_conditions (group_id);

-- ---------------------------------------------------------------------
-- leave_policies — the first real, concrete policy_type this phase's
-- generic assignment mechanism resolves. Deliberately minimal (three
-- entitlement-day counters) — Phase 9 owns actually consuming these
-- against real leave requests/balances; this phase only needs enough of
-- a real, assignable object to prove resolution end to end.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leave_policies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name               text NOT NULL,
  annual_leave_days  integer NOT NULL DEFAULT 0 CHECK (annual_leave_days >= 0),
  casual_leave_days  integer NOT NULL DEFAULT 0 CHECK (casual_leave_days >= 0),
  sick_leave_days    integer NOT NULL DEFAULT 0 CHECK (sick_leave_days >= 0),
  is_default         boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);
CREATE INDEX IF NOT EXISTS idx_leave_policies_company ON leave_policies (company_id);
-- At most one default leave policy per tenant — the safe-deny fallback
-- target must be unambiguous. Enforced at the database level (a partial
-- unique index), not only in application code, the same discipline
-- Decision #7's employee_number uniqueness already used.
CREATE UNIQUE INDEX IF NOT EXISTS idx_leave_policies_one_default
  ON leave_policies (company_id) WHERE is_default;

-- ---------------------------------------------------------------------
-- employee_group_policy_assignments — the generic join the "additive
-- combination across policy_type" property above depends on. `policy_id`
-- is deliberately NOT a foreign key: which table it points into depends
-- on `policy_type`, and only one policy_type (leave -> leave_policies)
-- exists yet. This is the same pragmatic, documented tradeoff
-- custom_fields' JSONB-over-EAV design already made (Decision #6) rather
-- than a real gap — application code validates the referenced row exists
-- and belongs to the same tenant before writing this table.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_group_policy_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  group_id    uuid NOT NULL REFERENCES employee_groups(id) ON DELETE CASCADE,
  policy_type text NOT NULL CHECK (policy_type IN ('leave')),
  policy_id   uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, policy_type)
);
CREATE INDEX IF NOT EXISTS idx_egpa_group ON employee_group_policy_assignments (group_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  employee_groups, employee_group_conditions, leave_policies, employee_group_policy_assignments
  TO app_role;

-- Same tenant-write RLS shape as Phase 7's employees table (genuine
-- tenant-scoped writes — this is real HR Admin configuration, not
-- Platform-Admin-only fixture data): app-level `employee_group.manage`/
-- `leave_policy.manage` permission checks (RbacService.can(), seeded
-- below) are the actual enforcement point; RLS is defense-in-depth behind
-- them, per Section 2's "RLS doesn't replace app checks, it backs them
-- up" division of labor.
ALTER TABLE employee_groups                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_groups                  FORCE ROW LEVEL SECURITY;
ALTER TABLE employee_group_conditions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_group_conditions        FORCE ROW LEVEL SECURITY;
ALTER TABLE leave_policies                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_policies                   FORCE ROW LEVEL SECURITY;
ALTER TABLE employee_group_policy_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_group_policy_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY employee_groups_all ON employee_groups FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY employee_group_conditions_all ON employee_group_conditions FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY leave_policies_all ON leave_policies FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY employee_group_policy_assignments_all ON employee_group_policy_assignments FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
