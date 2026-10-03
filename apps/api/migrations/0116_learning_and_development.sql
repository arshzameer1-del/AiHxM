-- Learning & Development — new ESS module (Part 2 category 7, UI re-skin
-- master doc's own gap list, §3 of
-- claude/ui-reskin-design-system-and-migration-plan-2026-10.md). Unlike
-- Expense Management (migration 0115), the `learning` module KEY already
-- existed — seeded into module_catalog and licensed to the 'enterprise'
-- tier back in 0006_module_entitlement.sql ("Learning & development
-- (Phase 13)") — but nothing was ever built behind it. This migration is
-- purely schema + permissions; no module_catalog/package_tier_modules
-- work is needed, and every enterprise-tier company that existed at
-- 0006's own backfill already has `tenant_module_entitlement` enabled for
-- 'learning' today.
--
-- Two real objects, same split Leave uses for leave_requests vs
-- leave_balances: `courses` is the company's own catalog (HR-authored,
-- broadly readable — same "non-sensitive, company-wide" posture Holiday
-- Management's calendar already has), `course_enrollments` is the
-- per-employee lifecycle object. Deliberately NOT routed through
-- WorkflowService — Part 2's spec for this category describes no
-- approval step at all ("Resume/enroll should preserve course context.
-- Completion updates learning records through the learning service"),
-- unlike Leave/Expense Management which are explicitly approval-gated.
-- Self-enrollment and HR-assignment are both just inserts; there is
-- nothing here for an approver to decide on.
--
-- `category` is a fixed CHECK-constrained set, same documented tradeoff
-- as `leave_type`/expense_claims.category — a tenant-configurable
-- catalog is a reasonable future addition, not built here since nothing
-- asked for it yet.
--
-- `status` on course_enrollments stores only the three states a write
-- actually produces ('assigned' | 'in_progress' | 'completed'); 'overdue'
-- (Part 2's fourth status chip) is DERIVED at read time from
-- `due_date < today AND status != 'completed'` — never stored — the same
-- "derive it, don't store it twice" discipline
-- WorkScheduleResolutionService's attendance-status derivation already
-- uses, so there is no cron/sweep needed to keep an `overdue` column
-- truthful.

-- ---------------------------------------------------------------------
-- courses — the company's own learning catalog.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS courses (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title                       text NOT NULL,
  description                 text,
  category                    text NOT NULL
                                CHECK (category IN ('compliance', 'technical', 'soft_skills', 'leadership', 'other')),
  duration_minutes            integer NOT NULL CHECK (duration_minutes > 0),
  is_active                   boolean NOT NULL DEFAULT true,
  created_by_user_account_id  uuid REFERENCES user_accounts(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_courses_company_active ON courses (company_id, is_active);

-- ---------------------------------------------------------------------
-- course_enrollments — one row per employee per course. A UNIQUE
-- constraint rather than allowing re-enrollment after completion — a
-- reasonable future addition (e.g. annual compliance refreshers) if real
-- usage asks for it; not built here (Section 10's own "don't over-build
-- ahead of actual demand" guardrail, same call leave_balances/
-- expense_claims made). `assigned_by_user_account_id` is null for a
-- genuine self-enrollment (Browse Courses -> Enroll) and set to the
-- HR Admin's id for an On-Behalf assignment — same derive-On-Behalf-from-
-- who-actually-wrote-it pattern leave_requests/expense_claims use via
-- their own submitted_by_user_account_id vs the employee's user_account_id.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS course_enrollments (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  course_id                    uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  status                       text NOT NULL DEFAULT 'assigned'
                                 CHECK (status IN ('assigned', 'in_progress', 'completed')),
  progress_percent             smallint NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  due_date                     date,
  assigned_by_user_account_id  uuid REFERENCES user_accounts(id),
  started_at                   timestamptz,
  completed_at                 timestamptz,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, course_id),
  CHECK (status != 'completed' OR completed_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_course_enrollments_employee ON course_enrollments (employee_id);
CREATE INDEX IF NOT EXISTS idx_course_enrollments_company_status ON course_enrollments (company_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON courses, course_enrollments TO app_role;

ALTER TABLE courses             ENABLE ROW LEVEL SECURITY;
ALTER TABLE courses             FORCE ROW LEVEL SECURITY;
ALTER TABLE course_enrollments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_enrollments  FORCE ROW LEVEL SECURITY;

CREATE POLICY courses_all ON courses FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY course_enrollments_all ON course_enrollments FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

-- ---------------------------------------------------------------------
-- Permissions — same three-role pattern as every module since Phase 4.
-- `course.view.all` is granted broadly (hr_admin/line_manager/
-- employee_self_service), same "non-sensitive, company-wide" reasoning
-- as `holiday.view.all` — Browse Courses needs every employee to see the
-- catalog, not just their own enrollments.
-- ---------------------------------------------------------------------
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('course.view.all',               'View the company''s learning catalog'),
  ('course.manage.all',             'Create, edit and deactivate courses in the catalog'),
  ('course_enrollment.view.self',   'View your own course enrollments and progress'),
  ('course_enrollment.view.team',   'View course enrollments of your direct reports'),
  ('course_enrollment.view.all',    'View any course enrollment in your company'),
  ('course_enrollment.manage.self', 'Enroll yourself in a course and update your own progress'),
  ('course_enrollment.manage.all',  'Assign a course to any employee (On-Behalf), and cancel any enrollment')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin'
  AND p.key IN ('course.view.all', 'course.manage.all', 'course_enrollment.view.all', 'course_enrollment.manage.all')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'line_manager' AND p.key IN ('course.view.all', 'course_enrollment.view.team')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'employee_self_service'
  AND p.key IN ('course.view.all', 'course_enrollment.view.self', 'course_enrollment.manage.self')
ON CONFLICT DO NOTHING;
