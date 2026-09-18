-- Effective-dating framework, second Foundation increment of the
-- "continue and complete all" pass (claude/aihxm-master-audit-and-roadmap.md,
-- Part 3): generalizes the effective_from/effective_to + history pattern
-- `employee_compensation` (0022_payroll.sql) and `shift_assignments`
-- (0026_shift_management.sql) already use, applied next to the two
-- configs Part 3 named specifically -- "the two configs a payroll/leave
-- dispute would actually need to reconstruct historically": Leave
-- Policies and Tax Slabs.
--
-- Scope, stated up front: this ships real, effective-dated STORAGE and a
-- read/history endpoint for both. It deliberately does NOT wire
-- historical lookups into either LIVE decision path (leave balance
-- entitlement checks still resolve the CURRENT policy version; payroll
-- calculation still uses the CURRENT tax slab set) -- both of those
-- already read "current" today and continue to after this migration,
-- so this is additive, not a behavior change to either module's live
-- logic. Making a payroll run resolve tax slabs as-of its OWN period
-- (rather than "whatever is current right now") is a real, separately
-- named follow-on, not bundled in here -- the same "don't over-build
-- ahead of demand" discipline this schema has followed all session.
--
-- Both leave_policies and tax_slabs carry FORCE ROW LEVEL SECURITY (per
-- their own migrations, 0012 and 0022), which applies even to the table
-- owner running this migration -- without bypassing it, the backfill
-- reads/writes below would silently match zero rows (no
-- request.jwt.claims is set on this connection otherwise) rather than
-- error, quietly leaving every tenant's data un-migrated. Same bypass
-- every other migration with a real backfill already uses (e.g. 0012's
-- own header comment).
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);
--
-- ---------------------------------------------------------------------
-- leave_policy_versions -- entitlement figures move OUT of `leave_policies`
-- (which becomes pure identity: id/company_id/name/is_default) and into
-- versioned rows here, mirroring `employee_compensation`'s own shape.
-- `leave_policies.id` stays the stable thing every other table already
-- references by FK (employee_group_policy_assignments.policy_id) --
-- only the entitlement NUMBERS are versioned, not the policy's identity,
-- so nothing that already points at a policy by id needs to change.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leave_policy_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id          uuid NOT NULL REFERENCES leave_policies(id) ON DELETE CASCADE,
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  annual_leave_days  integer NOT NULL DEFAULT 0 CHECK (annual_leave_days >= 0),
  casual_leave_days  integer NOT NULL DEFAULT 0 CHECK (casual_leave_days >= 0),
  sick_leave_days    integer NOT NULL DEFAULT 0 CHECK (sick_leave_days >= 0),
  effective_from     date NOT NULL,
  effective_to       date,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS idx_leave_policy_versions_policy
  ON leave_policy_versions (policy_id, effective_from);
-- At most one OPEN version per policy at a time -- the same invariant
-- `shift_assignments` relies on application code (not a DB constraint)
-- to hold; here it's enforced at the database level since a policy has
-- exactly one identity to guard, unlike an employee's shift history
-- which the app already serializes through one transaction per change.
CREATE UNIQUE INDEX IF NOT EXISTS idx_leave_policy_versions_one_open
  ON leave_policy_versions (policy_id) WHERE effective_to IS NULL;

-- Backfill: every existing leave policy's current row becomes v1,
-- effective from its own created_at -- exactly the migration strategy
-- Part 3 named ("each becomes v1, effective from its created_at").
INSERT INTO leave_policy_versions (policy_id, company_id, annual_leave_days, casual_leave_days, sick_leave_days, effective_from, effective_to)
SELECT id, company_id, annual_leave_days, casual_leave_days, sick_leave_days, created_at::date, NULL
FROM leave_policies;

ALTER TABLE leave_policies DROP COLUMN annual_leave_days;
ALTER TABLE leave_policies DROP COLUMN casual_leave_days;
ALTER TABLE leave_policies DROP COLUMN sick_leave_days;

GRANT SELECT, INSERT, UPDATE, DELETE ON leave_policy_versions TO app_role;
ALTER TABLE leave_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_policy_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY leave_policy_versions_all ON leave_policy_versions FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

-- ---------------------------------------------------------------------
-- tax_slabs -- unlike leave_policies, nothing references a tax_slabs row
-- by id (grepped: no FK anywhere), and there's no separate "identity"
-- concept to preserve -- the effective-dated SET of bracket rows sharing
-- one (company_id, effective_from) pair IS the version, so the columns
-- are added directly to the existing table rather than splitting into a
-- second table.
-- ---------------------------------------------------------------------
ALTER TABLE tax_slabs ADD COLUMN IF NOT EXISTS effective_from date;
ALTER TABLE tax_slabs ADD COLUMN IF NOT EXISTS effective_to date;

-- Backfill: every existing bracket becomes part of the v1 set, effective
-- from this row's own created_at (same convention as leave policies
-- above -- each tenant's brackets were all inserted together by
-- setTaxSlabs's original delete-then-insert-all, so they already share
-- effectively the same created_at).
UPDATE tax_slabs SET effective_from = created_at::date WHERE effective_from IS NULL;

ALTER TABLE tax_slabs ALTER COLUMN effective_from SET NOT NULL;
ALTER TABLE tax_slabs ADD CONSTRAINT tax_slabs_effective_range_check
  CHECK (effective_to IS NULL OR effective_to >= effective_from);

-- The old plain UNIQUE (company_id, min_annual_income) can no longer
-- hold -- a bracket's min_annual_income legitimately repeats across two
-- different eras once slabs are ever changed. Replaced with a partial
-- unique index scoped to only the currently-open set, which is the
-- actual invariant that matters (no two concurrently-active brackets
-- with the same floor).
ALTER TABLE tax_slabs DROP CONSTRAINT IF EXISTS tax_slabs_company_id_min_annual_income_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tax_slabs_one_open_per_floor
  ON tax_slabs (company_id, min_annual_income) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_tax_slabs_company_effective
  ON tax_slabs (company_id, effective_from);
