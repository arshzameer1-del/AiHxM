-- Onboarding & Offboarding — Part 2's gap matrix row #21, flagged High
-- ("real customer-facing gap") ever since the audit in
-- claude/aihxm-master-audit-and-roadmap.md was written, and independently
-- named as the most customer-visible Core HR gap remaining once the
-- Foundation phase's engines (Effective-Dating, Rules Engine, real SMTP)
-- closed out.
--
-- Deliberate module-entitlement reuse, not a new sellable module: this
-- codebase's `module_catalog` has carried two placeholder rows with ZERO
-- backend behind them since Phase 5 (0006_module_entitlement.sql) —
-- `recruitment` ("Recruitment & Onboarding") and `exit` ("Exit &
-- Offboarding"). Onboarding is gated on the existing `recruitment`
-- module_key (its own seeded name already names this exact feature);
-- Offboarding is gated on the existing `exit` module_key, closing that
-- module's own placeholder-to-real-implementation gap the same way the
-- Configuration Center increment closed part of the equivalent "bi" gap.
-- No new module_catalog row, no package_tier_modules change — every
-- tier that already licenses `recruitment`/`exit` gets the real feature
-- for free the moment this migration runs.
--
-- Shape: a company-configurable list of checklist item TEMPLATES per
-- side (title/category/who's responsible), cloned into real item rows
-- on every new onboarding/offboarding instance — so editing the
-- template list later never rewrites an in-flight checklist's history,
-- the same "definition vs. instance" split Shift Management (shift
-- definitions vs. shift assignments) already established. `responsible_role`
-- deliberately reuses this codebase's existing self/team/all RBAC scope
-- vocabulary rather than inventing a parallel one — "self" = the
-- employee completes it themselves, "team" = their manager, "all" = HR.
--
-- Deliberately NOT routed through the Workflow Engine for a multi-step
-- approval chain, unlike Leave/Recruitment's own use of it — same
-- reasoning Attendance Corrections (0028) used for its own single-decider
-- action: a checklist item has exactly one responsible party, not a
-- chain of approvers to route through. A real Workflow-Engine clearance
-- chain (e.g. IT then Finance then HR sign-off before an offboarding can
-- finalize) is a deliberate, named follow-on for real demand, not guessed
-- at now — the same "rule of three, not upfront" discipline every prior
-- engine extraction this session has followed.
--
-- Offboarding's `completeOffboarding()` (see offboarding.service.ts)
-- deliberately reuses `EmployeesService.update()` to flip
-- `employment_status` to `terminated` at finalize time, rather than
-- writing a second, parallel termination code path — that method
-- already validates `terminationDate`, already auto-records
-- `employee_job_history`, and is the one and only place in this
-- codebase that mutates an employee's termination fields.

-- ---------------------------------------------------------------------
-- Onboarding
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS onboarding_item_templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title            text NOT NULL,
  category         text NOT NULL CHECK (category IN ('it', 'hr', 'finance', 'facilities', 'general')),
  responsible_role text NOT NULL CHECK (responsible_role IN ('self', 'team', 'all')),
  sort_order       int NOT NULL DEFAULT 0,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_onboarding_item_templates_company
  ON onboarding_item_templates (company_id, sort_order);

GRANT SELECT, INSERT, UPDATE, DELETE ON onboarding_item_templates TO app_role;

ALTER TABLE onboarding_item_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_item_templates FORCE ROW LEVEL SECURITY;

CREATE POLICY onboarding_item_templates_all ON onboarding_item_templates FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE TABLE IF NOT EXISTS employee_onboarding (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  status                        text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  started_at                    timestamptz NOT NULL DEFAULT now(),
  completed_at                  timestamptz,
  initiated_by_user_account_id  uuid REFERENCES user_accounts(id)
);
-- At most one IN-PROGRESS onboarding per employee at a time — a
-- completed onboarding never blocks a later rehire's fresh one, the
-- same "scope the uniqueness to the open state" pattern the Effective-
-- Dating Engine's own hardening (0034) uses for `effective_to IS NULL`.
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_onboarding_one_open
  ON employee_onboarding (employee_id) WHERE status = 'in_progress';
CREATE INDEX IF NOT EXISTS idx_employee_onboarding_company
  ON employee_onboarding (company_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON employee_onboarding TO app_role;

ALTER TABLE employee_onboarding ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_onboarding FORCE ROW LEVEL SECURITY;

CREATE POLICY employee_onboarding_all ON employee_onboarding FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE TABLE IF NOT EXISTS employee_onboarding_items (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_id                 uuid NOT NULL REFERENCES employee_onboarding(id) ON DELETE CASCADE,
  company_id                    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE: deleting/deactivating a template later must
  -- never delete or orphan-fail an already-cloned item on someone's
  -- real, possibly in-progress checklist.
  template_item_id              uuid REFERENCES onboarding_item_templates(id) ON DELETE SET NULL,
  title                         text NOT NULL,
  category                      text NOT NULL CHECK (category IN ('it', 'hr', 'finance', 'facilities', 'general')),
  responsible_role              text NOT NULL CHECK (responsible_role IN ('self', 'team', 'all')),
  sort_order                    int NOT NULL DEFAULT 0,
  status                        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'skipped')),
  notes                         text,
  completed_at                  timestamptz,
  completed_by_user_account_id  uuid REFERENCES user_accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_employee_onboarding_items_onboarding
  ON employee_onboarding_items (onboarding_id, sort_order);

GRANT SELECT, INSERT, UPDATE, DELETE ON employee_onboarding_items TO app_role;

ALTER TABLE employee_onboarding_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_onboarding_items FORCE ROW LEVEL SECURITY;

CREATE POLICY employee_onboarding_items_all ON employee_onboarding_items FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

-- ---------------------------------------------------------------------
-- Offboarding — same shape as onboarding above, plus the reason and
-- last-working-day fields an exit specifically needs.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS offboarding_item_templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title            text NOT NULL,
  category         text NOT NULL CHECK (category IN ('it', 'hr', 'finance', 'facilities', 'general')),
  responsible_role text NOT NULL CHECK (responsible_role IN ('self', 'team', 'all')),
  sort_order       int NOT NULL DEFAULT 0,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_offboarding_item_templates_company
  ON offboarding_item_templates (company_id, sort_order);

GRANT SELECT, INSERT, UPDATE, DELETE ON offboarding_item_templates TO app_role;

ALTER TABLE offboarding_item_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE offboarding_item_templates FORCE ROW LEVEL SECURITY;

CREATE POLICY offboarding_item_templates_all ON offboarding_item_templates FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE TABLE IF NOT EXISTS employee_offboarding (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  reason                        text NOT NULL CHECK (reason IN ('resignation', 'termination', 'retirement', 'end_of_contract', 'other')),
  last_working_day              date NOT NULL,
  notes                         text,
  status                        text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  initiated_by_user_account_id  uuid REFERENCES user_accounts(id),
  started_at                    timestamptz NOT NULL DEFAULT now(),
  completed_at                  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_offboarding_one_open
  ON employee_offboarding (employee_id) WHERE status = 'in_progress';
CREATE INDEX IF NOT EXISTS idx_employee_offboarding_company
  ON employee_offboarding (company_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON employee_offboarding TO app_role;

ALTER TABLE employee_offboarding ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_offboarding FORCE ROW LEVEL SECURITY;

CREATE POLICY employee_offboarding_all ON employee_offboarding FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE TABLE IF NOT EXISTS employee_offboarding_items (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offboarding_id                uuid NOT NULL REFERENCES employee_offboarding(id) ON DELETE CASCADE,
  company_id                    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  template_item_id              uuid REFERENCES offboarding_item_templates(id) ON DELETE SET NULL,
  title                         text NOT NULL,
  category                      text NOT NULL CHECK (category IN ('it', 'hr', 'finance', 'facilities', 'general')),
  responsible_role              text NOT NULL CHECK (responsible_role IN ('self', 'team', 'all')),
  sort_order                    int NOT NULL DEFAULT 0,
  status                        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'skipped')),
  notes                         text,
  completed_at                  timestamptz,
  completed_by_user_account_id  uuid REFERENCES user_accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_employee_offboarding_items_offboarding
  ON employee_offboarding_items (offboarding_id, sort_order);

GRANT SELECT, INSERT, UPDATE, DELETE ON employee_offboarding_items TO app_role;

ALTER TABLE employee_offboarding_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_offboarding_items FORCE ROW LEVEL SECURITY;

CREATE POLICY employee_offboarding_items_all ON employee_offboarding_items FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
