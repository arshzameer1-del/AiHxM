# AIHXM transformation progress

Rollback point: git tag `checkpoint-before-transformation-2026-10-30` (commit 201bfab, the state after GAPC5).
Working rules: module by module, additive migrations only, nothing removed, every claim below was actually run.

## Session 1 (2026-10-30)

### Phase 1: discovery and baseline (done)
- Repository: 81 API modules, 199 migrations before this session, 278 API spec files, 64 browser (Playwright) specs, about 158k lines of API TypeScript.
- Baseline full API suite (`jest --maxWorkers=3`): 278 suites, 257 passed / 21 failed, 3007 tests passed / 111 failed.
  - The run was disturbed by my own parallel work (API restarts, Playwright, a migration, a Postgres crash earlier in the session). The 21 failed suites were rerun serially with nothing else running: 20 passed.
  - 1 real failure: `organization/legacy-field-reads.guard.spec.ts`. Cause: two files added earlier this session (`assistant/assistant.service.ts`, `headcount/headcount.service.ts`) read legacy org fields and were not in the guard's inventory. Fixed by adding both as `display` readers (the guard asks for exactly this deliberate listing). After the fix the guard passes.
  - So the effective baseline is: all API suites pass when run without interference. A full single serial run after all changes has NOT yet been done (about 17 minutes in parallel mode).
- Web: `tsc --noEmit` and `eslint --quiet` clean.

### Phase 2 finding: configuration coverage (measured)
- Of 75 `*Page.tsx` screens, only the hiring wizard cards (`core_employee_card_field_definitions`) and custom fields have field-level configuration (label, required, hidden, order, validation). Leave, expense, help desk, travel, recruitment, performance, learning, attendance and others have hardcoded labels and required rules.
- Existing and solid (reused, not rebuilt): Configuration Center registry, HR reference catalogs, business policies, rule mappings, configuration change requests (maker/checker, rollback), workflow engine, custom fields, effective dating, payslip design, employee numbering.

### Phase 3 (started): reusable form settings engine (FORMCFG1) - built and verified
- Migration `0200_form_field_settings.sql`: `form_field_settings`, `form_field_setting_history` (both tenant RLS forced), registry card "Form settings".
- API `form-settings/`: catalog (`form-catalog.ts`) decides which forms and fields may change and how; service gives read, update, reset, history, restore, and `enforce()` used by the server before a request is acted on. Controller `GET/PUT/DELETE /form-settings...`. Audit entry for every change.
- Applied to three forms end to end (screen and server): Leave request (note, relief person), Expense claim (description), HR help desk (about, title, question).
- Web: `FormSettingsPage` (Configuration Center > Form settings, with change list and undo), `useFormSettings` hook, route, cache rule.
- Safe by construction: a field the business always needs (leave type, dates, amount) can be renamed but never hidden or made optional; a hidden field cannot be required; defaults equal the old hardcoded behaviour so existing tenants see no change until they configure something.
- Tests run and passing: `form-settings.spec.ts` (7), Playwright `FormSettings.e2e.spec.ts` (2), plus regression: help desk spec, expense specs, cross-tenant isolation (16), legacy-field guard, leave and expense Playwright suites (21), help desk/recognition/compliance Playwright (3).

### Files changed this session (since checkpoint)
- New: `apps/api/migrations/0200_form_field_settings.sql`, `apps/api/src/form-settings/*` (catalog, service, controller, module, spec), `apps/web/src/portal/admin/FormSettingsPage.tsx`, `apps/web/src/portal/admin/FormSettings.e2e.spec.ts`, `apps/web/src/portal/shared/useFormSettings.ts`, this file.
- Modified: `app.module.ts`, `leave/leave.controller.ts`, `expenses/expenses.controller.ts`, `helpdesk/helpdesk.controller.ts`, `organization/legacy-field-reads.guard.spec.ts`, shared-types `index.ts`, web `api/client.ts`, `api/responseCache.ts`, `App.tsx`, `LeaveRequestForm.tsx`, `ExpenseClaimForm.tsx`, `HelpdeskPage.tsx`.

## Known issues / limits
- Form settings cover 3 forms (10 fields). Dozens of forms are still hardcoded.
- Form settings have history and undo but no draft/publish step and no effective dates yet (the older config change-request engine has those; not yet joined).
- Field order, sections, default values, conditional visibility and dependent fields (section 3A of the master prompt) are NOT built.
- Dropdown configuration (3B) exists for HR reference catalogs; not audited form by form yet.
- Page/table configuration (3C): not started.
- Mobile layout, accessibility audit, performance/index review, security review (sections 5, 7, 8): not started in this session.
- E2E data from earlier sessions still on the live tenant; the new migration 0200 must be run on production (`npm run migrate`) after deploy.

## Remaining tasks (priority order)
1. Extend the form catalog to: travel request, on-duty request, attendance correction, overtime claim, job requisition, candidate, goal, survey creation, announcement, onboarding task. One catalog entry plus one `enforce()` call plus the hook in the form each.
2. Add field order, default value, conditional visibility to the engine (needs a design decision on how dependent fields are expressed).
3. Table/column configuration (visibility, order, default sort) as a second reusable engine, starting with the employee directory and leave requests table.
4. Join form settings to the change-request lifecycle (draft, approve, publish, effective date).
5. Security pass: re-verify RLS on every table without `company_id` policy; look at file upload limits; rate limits on public endpoints.
6. Performance pass: list queries without pagination, missing indexes (use `EXPLAIN` on the 20 slowest list endpoints).
7. Accessibility and phone-width pass on the 15 most used screens.
8. One clean serial full-suite run and the production migration.

## Exact next step
Run a single clean full serial API suite (`npx jest --runInBand`), then start item 1 above with travel request and on-duty request.
