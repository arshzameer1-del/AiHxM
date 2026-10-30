# AIHXM transformation progress

Rollback point: git tag `checkpoint-before-transformation-2026-10-30` (commit 201bfab, the state after GAPC5).
Working rules: module by module, additive migrations only, nothing removed, every claim below was actually run.

## Session 1 (2026-10-30)

### Phase 1: discovery and baseline (done)
- Repository: 81 API modules, 199 migrations before this session, 278 API spec files, 64 browser (Playwright) specs, about 158k lines of API TypeScript.
- Baseline full API suite (`jest --maxWorkers=3`): 278 suites, 257 passed / 21 failed, 3007 tests passed / 111 failed.
  - The run was disturbed by my own parallel work (API restarts, Playwright, a migration, a Postgres crash earlier in the session). The 21 failed suites were rerun serially with nothing else running: 20 passed.
  - 1 real failure: `organization/legacy-field-reads.guard.spec.ts`. Cause: two files added earlier this session (`assistant/assistant.service.ts`, `headcount/headcount.service.ts`) read legacy org fields and were not in the guard's inventory. Fixed by adding both as `display` readers (the guard asks for exactly this deliberate listing). After the fix the guard passes.
  - Clean full run after all session changes (nothing else running, `--maxWorkers=2`): **279 suites passed, 3179 tests passed, 0 failed** (413 s).
- Web: `tsc --noEmit` and `eslint --quiet` clean.

### Phase 2 finding: configuration coverage (measured)
- Of 75 `*Page.tsx` screens, only the hiring wizard cards (`core_employee_card_field_definitions`) and custom fields have field-level configuration (label, required, hidden, order, validation). Leave, expense, help desk, travel, recruitment, performance, learning, attendance and others have hardcoded labels and required rules.
- Existing and solid (reused, not rebuilt): Configuration Center registry, HR reference catalogs, business policies, rule mappings, configuration change requests (maker/checker, rollback), workflow engine, custom fields, effective dating, payslip design, employee numbering.

### Phase 3 (started): reusable form settings engine (FORMCFG1) - built and verified
- Migration `0200_form_field_settings.sql`: `form_field_settings`, `form_field_setting_history` (both tenant RLS forced), registry card "Form settings".
- API `form-settings/`: catalog (`form-catalog.ts`) decides which forms and fields may change and how; service gives read, update, reset, history, restore, and `enforce()` used by the server before a request is acted on. Controller `GET/PUT/DELETE /form-settings...`. Audit entry for every change.
- Applied to forms end to end (screen and server): Leave request (note, relief person), Expense claim (description), HR help desk (about, title, question), Work away / on-duty request (where, reason), Attendance correction (reason), Travel request (destination, dates, purpose, distance, other costs, advance).
- Overtime claims have an API but NO employee screen anywhere in the web app. They were deliberately left out of form settings (a setting for a form nobody can see would be misleading). Finding: overtime claims need a screen.
- Web: `FormSettingsPage` (Configuration Center > Form settings, with change list and undo), `useFormSettings` hook, route, cache rule.
- Safe by construction: a field the business always needs (leave type, dates, amount) can be renamed but never hidden or made optional; a hidden field cannot be required; defaults equal the old hardcoded behaviour so existing tenants see no change until they configure something.
- Tests run and passing: `form-settings.spec.ts` (7), Playwright `FormSettings.e2e.spec.ts` (2), plus regression: help desk spec, expense specs, cross-tenant isolation (16), legacy-field guard, leave and expense Playwright suites (21), help desk/recognition/compliance Playwright (3).

### Files changed this session (since checkpoint)
- New: `apps/api/migrations/0200_form_field_settings.sql`, `apps/api/src/form-settings/*` (catalog, service, controller, module, spec), `apps/web/src/portal/admin/FormSettingsPage.tsx`, `apps/web/src/portal/admin/FormSettings.e2e.spec.ts`, `apps/web/src/portal/shared/useFormSettings.ts`, this file.
- Modified: `app.module.ts`, `leave/leave.controller.ts`, `expenses/expenses.controller.ts`, `helpdesk/helpdesk.controller.ts`, `organization/legacy-field-reads.guard.spec.ts`, shared-types `index.ts`, web `api/client.ts`, `api/responseCache.ts`, `App.tsx`, `LeaveRequestForm.tsx`, `ExpenseClaimForm.tsx`, `HelpdeskPage.tsx`.

### Phase 5 (security and performance) - measured, session 1
- Tenant isolation: all 304 tables with a `company_id` column have row security enabled AND forced (checked in the live schema, zero exceptions). Cross-tenant isolation suite passes (16 tests).
- Index audit: 23 tenant tables had no index starting with `company_id`; 19 are child tables reached through a parent id that already has the right index. The 4 top-level ones now have one (migration `0201_company_scope_indexes.sql`: comp_cycles, headcount_plans, talent_assessments, asset_events). The large tables (attendance_records, payslips, leave_requests, audit_log) were already well indexed.
- 390 of 995 foreign keys have no supporting index. NOT changed: blindly adding ~390 indexes slows writes; most are small tables. Needs a per-table decision once there is production data volume.
- Lists: `employees` uses `pageOf()`, which loads the whole list and then slices it. Fine for SMB sizes (hundreds), not for tens of thousands. Real database paging (LIMIT/OFFSET in SQL) is a follow-up.

## Module reports (each rating states what was actually measured)

### Module 1: Employees (core HR, hiring, profile, documents) - audited 2026-10-30
Size: 27 controllers, 132 routes, 31 API spec files, 36 screens/panels, 9 browser specs.

Measured and verified:
- Authorization (live probe of all 34 parameterless GET routes as anonymous, employee and HR): anonymous 401 everywhere; employee gets 403 on every HR-only list and sees only their own record on `/employees`. No leaks found. `field-sensitivity` (the list of which fields are sensitive) is readable by employees: names only, no values; left as is.
- Input validation: global `ValidationPipe` with `whitelist` and `forbidNonWhitelisted`; every Employees DTO has validators; no untyped bodies.
- Accessibility (axe-core, WCAG 2.0 A and AA): found colour-contrast failures on every screen (muted text token too light in all three themes; purple top bar; accent purple and pink ink on tinted backgrounds) and one unlabeled file input on bulk import. Fixed in `index.css` (tokens darkened, same hue) and `EmployeeBulkImportPage.tsx`. Result: 0 violations on 36 screens (30 HR, 6 employee), now a permanent test `a11y.e2e.spec.ts` (new dev-only dependency `axe-core`).
- Phone width (390 px): no page-level horizontal scroll on 10 Employees/hiring/config screens.
- Destructive actions: removing a language, a nine-box placement, a succession candidate and a minimum-wage entry removed the record on one click. Now ask first (shared `useConfirm`); Cancel changes nothing; covered by browser tests.
- Performance: `data-consistency` report took 1.1 s with only 3 employees (it runs every check on demand); fine for now, to be watched with real volume. Employee list loads everything then pages in memory.

Found, not fixed (belongs to later modules or needs a decision):
- Other one-click removals still exist in Attendance rules (remove group), Attendance devices (revoke), Payroll accounting rows, levy worksheet draft delete, Shift/leave rule builders. Will be handled in their own module audit.
- Employee profile edit and hire forms are only partly configurable (hiring cards and custom fields yes; most profile fields no). Form settings catalog does not cover them yet.
- The unit tests in `apps/web/src/**/*.test.ts` (53 tests, Node's test runner) could not be run in this sandbox because they need a TypeScript loader that is not installed here. They were not run and no claim is made about them.
- Business-logic correctness of each of the 26 Employees sub-areas (loans, statutory IDs, payment accounts, compensation, cost allocation...) was NOT re-verified beyond the existing 31 API spec files that pass.

Rating (evidence-based, not a certification): Security B+ to A- (verified); Validation A- (verified); Accessibility A- on contrast/labels (verified by axe, keyboard and screen-reader behaviour not tested); Configurability C (hiring cards and custom fields only); Mobile B (overflow checked only); Performance B- (in-memory paging, on-demand heavy report); Business-logic depth: not rated (not re-audited).

## Known issues / limits
- Form settings cover 7 forms (about 25 fields). Dozens of forms are still hardcoded.
- Form settings have history and undo but no draft/publish step and no effective dates yet (the older config change-request engine has those; not yet joined).
- Field order, sections, default values, conditional visibility and dependent fields (section 3A of the master prompt) are NOT built.
- Dropdown configuration (3B) exists for HR reference catalogs; not audited form by form yet.
- Page/table configuration (3C): not started.
- Mobile layout, accessibility audit, performance/index review, security review (sections 5, 7, 8): not started in this session.
- E2E data from earlier sessions still on the live tenant; migrations 0200 and 0201 must be run on production (`npm run migrate`) after deploy.
- The Postgres server in the build sandbox stopped by itself twice during the session (not an application fault); it had to be restarted before tests could run.

## Remaining tasks (priority order)
1. Extend the form catalog to: job requisition, candidate, goal, survey creation, announcement, onboarding task, employee profile edit (and add an overtime claim screen). One catalog entry plus one `enforce()` call plus the hook in the form each.
2. Add field order, default value, conditional visibility to the engine (needs a design decision on how dependent fields are expressed).
3. Table/column configuration (visibility, order, default sort) as a second reusable engine, starting with the employee directory and leave requests table.
4. Join form settings to the change-request lifecycle (draft, approve, publish, effective date).
5. Security pass: re-verify RLS on every table without `company_id` policy; look at file upload limits; rate limits on public endpoints.
6. Performance pass: list queries without pagination, missing indexes (use `EXPLAIN` on the 20 slowest list endpoints).
7. Accessibility and phone-width pass on the 15 most used screens.
8. One clean serial full-suite run and the production migration.

## Exact next step
Module 2: Leave. Same procedure as Module 1 (live authorization probe, axe is already global, destructive-action check, validation, business-rule review of the leave pipeline, configurability, then rating). Then Module 3 Attendance and so on in the order in the module list: Employees, Leave, Attendance/shifts/timesheets/overtime, Payroll, Workflow/Approvals, Organization, Recruitment, Performance/Talent, Learning, Expenses/Travel, Reports, Onboarding, Surveys/Recognition/Help desk/Announcements, Configuration Center/Admin, System admin/security.
