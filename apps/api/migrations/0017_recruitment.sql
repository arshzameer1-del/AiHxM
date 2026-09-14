-- Phase 10 — Recruitment & Onboarding (plan doc Section 7: "Requisition
-- to hire, Kanban pipeline... Employee number gets assigned here, at
-- offer acceptance"). The `recruitment` module_key already exists in
-- `module_catalog`/`package_tier_modules` (seeded back in
-- 0006_module_entitlement.sql, alongside every other not-yet-built
-- module) — nothing to add there, this phase just builds the tables.
--
-- Four real objects: `job_requisitions` (the thing that gets approved),
-- `candidates` (a person, deliberately NOT a `user_accounts` row — a
-- candidate never logs into BoostFactor, so there is no login/session
-- concept for them at all, unlike every other object built so far),
-- `applications` (one candidate applying to one requisition — the
-- Kanban card), and `offers` (an application's terminal decision point).
--
-- Requisition approval deliberately REUSES the Phase 6 workflow engine
-- exactly as-is — no new approver type, no new engine capability, unlike
-- Phase 9's `manager_of_submitter` addition. `submitForApproval()`
-- already supports a plain `role` approver, which is all a requisition
-- approval chain needs (e.g., "HR Admin approves any new requisition,"
-- or a future higher-headcount-needs-a-second-approver rule via a
-- conditional step) — Section 10's own "don't let the workflow engine
-- become over-general" guardrail cuts the other way here: the engine
-- already does everything this phase needs, so nothing about it changes.

CREATE TABLE IF NOT EXISTS job_requisitions (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title                        text NOT NULL,
  department                   text,
  headcount                    int NOT NULL DEFAULT 1 CHECK (headcount > 0),
  salary_band                  text,
  justification                text,
  -- The employee who will manage the new hire, if already known — an
  -- existing Employee Core row (Phase 7). Nullable: plenty of real
  -- requisitions get raised before a hiring manager is finalized.
  hiring_manager_id            uuid REFERENCES employees(id),
  status                       text NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected', 'closed')),
  workflow_instance_id         uuid REFERENCES workflow_instances(id),
  created_by_user_account_id   uuid NOT NULL REFERENCES user_accounts(id),
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_requisitions_company ON job_requisitions (company_id);

-- A candidate is a person, not a login — no user_accounts row, no
-- session, no RBAC scope of their own. Every RBAC check on this whole
-- object graph is therefore always the RECRUITER's permission
-- (`recruitment.manage.all`), never a `.self` scope — there is no
-- "candidate views their own application" self-service portal in this
-- phase (a real product would eventually want one; not built now, see
-- KNOWN_ISSUES.md).
CREATE TABLE IF NOT EXISTS candidates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  first_name   text NOT NULL,
  last_name    text NOT NULL,
  email        text,
  phone        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_candidates_company ON candidates (company_id);

-- The Kanban card: one candidate applying to one requisition.
-- `UNIQUE (requisition_id, candidate_id)` — the same candidate applying
-- to the same requisition twice is a data-entry mistake to prevent
-- structurally, not a real second application to track. A genuinely
-- different application (a different requisition, or a rehire scenario)
-- is a new row, never a re-application in place.
CREATE TABLE IF NOT EXISTS applications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  requisition_id  uuid NOT NULL REFERENCES job_requisitions(id) ON DELETE CASCADE,
  candidate_id    uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  stage           text NOT NULL DEFAULT 'applied'
                    CHECK (stage IN ('applied', 'screening', 'interview', 'offer', 'hired', 'rejected')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (requisition_id, candidate_id)
);
CREATE INDEX IF NOT EXISTS idx_applications_requisition ON applications (requisition_id);
CREATE INDEX IF NOT EXISTS idx_applications_candidate ON applications (candidate_id);

-- An application's terminal decision point. `status` tracks the
-- CANDIDATE's decision (accepted/declined the offer as extended) —
-- `rescinded` is the employer withdrawing it instead, a genuinely
-- different event worth its own status rather than overloading
-- `declined`. Accepting an offer is this phase's own exit criterion:
-- the moment a real Employee record gets created with a freshly
-- assigned Employee Number (RecruitmentService.decideOffer(), not this
-- migration — nothing here creates that row automatically).
CREATE TABLE IF NOT EXISTS offers (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  application_id              uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  salary                      numeric(12,2) NOT NULL CHECK (salary > 0),
  start_date                  date NOT NULL,
  status                      text NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'accepted', 'declined', 'rescinded')),
  extended_by_user_account_id uuid NOT NULL REFERENCES user_accounts(id),
  -- Set once the employee this offer created exists — lets a later
  -- reader go straight from an accepted offer to the resulting Employee
  -- record without re-deriving it from the application/candidate.
  hired_employee_id           uuid REFERENCES employees(id),
  decided_at                  timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_offers_application ON offers (application_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON job_requisitions, candidates, applications, offers TO app_role;

-- Same genuine tenant-scoped-write RLS shape as every real object since
-- Phase 7 — real HR Admins/recruiters write these tables directly.
ALTER TABLE job_requisitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_requisitions FORCE ROW LEVEL SECURITY;
ALTER TABLE candidates       ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidates       FORCE ROW LEVEL SECURITY;
ALTER TABLE applications     ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications     FORCE ROW LEVEL SECURITY;
ALTER TABLE offers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE offers           FORCE ROW LEVEL SECURITY;

CREATE POLICY job_requisitions_all ON job_requisitions FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY candidates_all ON candidates FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY applications_all ON applications FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY offers_all ON offers FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
