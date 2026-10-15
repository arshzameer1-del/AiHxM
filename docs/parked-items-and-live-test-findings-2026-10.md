# AiHxM: parked items and live test findings (2026-10-15)

Status: working document. Created after Steps 0-11 were delivered, migrated (0116-0153) and deployed (commit 2e2f64c). Everything here is to be added to the gap register when development resumes. Sections: A live process-test results, B gaps found, C parked improvements, D open actions for Kumail, E test data left in the live tenant, F still to test.

## A. Live process test results (tenant "Qatar Solutions", user "qsts test", roles system_admin, hr_admin, payroll_approver, employee_self_service)

Read-only sweep (all API calls 200, no UI errors): Recruitment (8 tabs), Performance (7 tabs), Admin Center (Leave Types, Attendance Devices, Overtime, Shifts, Holidays, Employee Groups), Payroll (13 sections), Employees list and detail, Learning, Expenses, Organization, Configuration Center, System Admin, HR Administration.

Recruitment write flow, all behaving as designed:
- Requisition: create, validation errors (no title, headcount 0 -> 400), open while draft refused, submit, resubmit refused, approve -> approved.
- Candidate: validation errors (bad email, missing name -> 400), duplicate check, duplicate create refused (409, matched on email).
- Application: create, second application to same requisition refused (409), skip to hired refused, reject without reason refused, forward-only stage moves enforced.
- Interview: end-before-start refused, no interviewer refused, schedule OK, feedback OK, rating 9 refused, second feedback by same interviewer refused (409), complete OK.
- Pre-employment check: create and pass OK.
- Offer: extend OK (moves the application to the offer stage), zero salary refused, second open offer refused (409), rescind OK, new offer OK, three letter versions generated, accept OK and it created employee record d2d88399 (hiredEmployeeId).

## B. Gaps found (new register rows)

| ID | Severity | Finding | Proposed fix |
|----|----------|---------|--------------|
| LIVE-01 | Medium | Malformed UUID in a URL path (for example /offers/undefined/rescind) returns 500 Internal server error instead of 400. Seen on offers rescind, letters and decision. Likely the same on every :id route. | Global ParseUUIDPipe or a validation guard on all :id params; add a test that walks every route with a bad id. |
| LIVE-01 status | - | Fix written and tested in the sandbox: apps/api/src/common/database-input-error.filter.ts (global filter mapping Postgres 22P02/22007/22008/22003/22001 to 400), registered in app.module.ts, spec database-input-error.filter.spec.ts (4 tests). tsc clean, full jest 184 suites / 2304 tests pass. Delivered as live-01-fix.patch. NOT yet pushed or deployed (Kumail applies the patch, pushes, Render redeploys). | - |
| LIVE-02 | High (UX) | API latency is very high on the live stack: simple writes take 4-7 s, offer accept about 15 s, employee detail needs 11 sequential calls and about 10 s to render. Render free plan (cold start, small CPU) plus Supabase in ap-southeast-2 reached through a transaction pooler. | Put API and database in the same region, batch or parallelise queries per request, add request timing logs (p50/p95), keep-alive or paid instance, load the employee detail calls in parallel. |
| LIVE-03 | Medium | The same user created, submitted and approved a requisition (system_admin acts as approver of own request). | Decide the policy; if segregation of duties is wanted, block self-approval in the workflow engine unless a tenant setting allows it. |
| LIVE-04 | Medium | Accepting an offer silently creates an employee record in the live tenant (hiredEmployeeId). Confirm what status it gets, whether onboarding starts, and whether the hire goes through the guided hire workflow (Step 5/6 rules: numbering, payment account, etc.). | Verify and document; if it bypasses the hire workflow, route it through it. |
| LIVE-05 | Low | UI feedback: tabs show "Loading..." for several seconds with no skeleton or timeout message (follows from LIVE-02). | Skeletons and a "taking longer than usual" hint. |
| LIVE-07 | Low | Performance Phases dialog opens with empty date fields for a few seconds and fills with the saved dates after the slow API answers; typing made in that window is overwritten, and a save in that window produced the confusing error "Give both a start and an end date for every phase you use". | Disable the form until the saved phases have loaded (or show a skeleton). |
| LIVE-08 | Low | Employee pickers (Performance Goals, Development, Feedback, Reviews) list 124 people with 17+ identical "Ayesha Khan" names and two "Kumail Sherazi" entries, so a manager cannot tell people apart. | Show employee number next to the name everywhere (Goals and Reviews already do; Feedback and Development do not); clean duplicates (item C6). |
| LIVE-09 | Low | Payroll "My payslips" shows the period as raw ISO timestamps ("2026-09-01T00:00:00.000Z – 2026-09-30T00:00:00.000Z") while the dashboard below formats the same dates correctly. | Format the payslip period with the shared date formatter. |
| LIVE-10 | Medium | Payroll Calculate: the browser got "Request failed (504)" after about 25 s (proxy timeout) and the run still showed Draft, but the calculation did finish in the background (1 employee calculated, 121 could not be calculated). The user is told it failed while it worked, and the page does not refresh itself. | Make Calculate return immediately with a job id (202), show "Calculating..." and poll; raise the proxy timeout or remove the long request. |
| LIVE-11 | Medium | Payroll data readiness: pre-validation on a company-wide Oct 2026 simulation reports 121 employees with no compensation record covering the period and 122 with no active primary payment account. Only EMP-0001 calculates (net 79,241). The imported EMP1002..EMP1100 and EMP-0003..0019 records cannot be paid. | Compensation and payment-account load for real employees before the first real run; bulk pay inputs import. |
| LIVE-12 | Low | Existing runs look odd: run for 2026-10-29 to 2026-11-28 shows "Finalized 9/28/2026" (finalised before its period began) and periods 09-01..09-28, 09-01..09-30 and 09-29..10-28 overlap. Check that the engine blocks finalising a future period and overlapping regular runs for the same payroll area, or whether this is old test data. | Verify rules; add a test; clean the test runs. |
| LIVE-13 | Low | The logged-in test user has been "clocked in" since 10/13/2026 7:39 PM (two days) with no automatic close or warning; annual, casual and sick balances are all 0/0 (no entitlements assigned to the test user). | Auto-close open clock-ins at day end (tenant-defined rule), flag them in the correction queue; entitlement setup is a tenant decision. |
| LIVE-14 | Medium | Leave: an employee created by an accepted offer has no user account, so leave cannot be requested or routed ("This employee has no user account ... assign them a login first"). Self-approval also applies to leave (the same user requested and approved an unpaid leave). | Create the login (or at least prompt for it) in the hire flow; apply the segregation-of-duties decision from LIVE-03 to leave. |
| LIVE-15 | Medium | LIVE-04 answered: the employee created by an accepted offer (EMP-0023) is immediately Status "Active" with a future joining date (2026-11-14), no department, location, bank account or salary band, no login, and onboarding is NOT started automatically (the page offers "Create login", "Start onboarding", "Start offboarding" as manual steps). Numbering follows the sequence (EMP-0023). | Hire from offer should create the employee as pre-hire/pending until the joining date, start onboarding from the tenant template, and prompt for login, department and payment account. |
| LIVE-16 | Low | "Start onboarding" with no onboarding template configured creates an empty "In Progress" process ("No checklist items on this one") instead of asking for a template. | Block or warn when the tenant has no onboarding/offboarding checklist template (tenant decision, none shipped). |
| LIVE-17 | Medium | Offboarding accepts a last working day (2026-10-15) that is before the date of joining (2026-11-14). | Validate last working day against the joining date (and against the hire status). |
| LIVE-06 | High | No tested staging environment: testing the live tenant leaves records in real company data (see E). | Create a separate Supabase project plus Render service and Netlify site for staging; run write-flow tests only there. |

## C. Parked improvements (carry into the register)

1. Deploy: migrations are run by hand (npm run migrate). Add a release step or CI job and a documented rollback order. Direct Supabase host is IPv6-only, so migrations from an IPv4 network must use the session pooler (port 5432).
2. Backups: the free Supabase plan has no backups. pg_dump could not run on the developer machine (missing DLL). A Node data snapshot script exists (backup-data.js). Before real payroll goes live: paid plan with daily backups and point-in-time recovery, and a tested restore.
3. Remove local dev helper scripts from GitHub (get-totp-adhoc.ts, get-totp-kumail-test.ts, seed-kumail-test.ts); they hold local-only credentials. Also keep dump.rdb out of the repo (.gitignore).
4. Password reuse: the database password and the platform admin bootstrap password were the same value. Use distinct secrets.
5. Org Command Center reports 361 data-quality warnings (119 employees without primary assignment, 121 without a valid reporting line, 119 legacy records not mapped, 2 conflicting assignments). Run the legacy reconciliation (ORG-05 tool) and clean.
6. More than 17 duplicate "Ayesha Khan" employees and the "QA E2E Test Dept" unit are old test pollution in the live tenant; the cleanup Kumail approved earlier is still pending (read-only diagnostic script exists, no delete script yet).
7. Recruitment settings are empty in the live tenant (retention months, consent required, offer validity, offer letter template). Tenant decisions; no values are shipped.
8. Per-route 500 audit: confirm that no other known client error returns 500.

## D. Open actions for Kumail (unchanged, repeated so they are not lost)

1. SEC-01 and secret rotation: every value pasted into chat (database passwords, JWT, MFA, export keys, Supabase anon and service role keys, admin password) is exposed. Rotate and update Render.
2. Confirm FIELD_ENCRYPTION_KEY is set on Render (a value only Kumail knows, saved outside Render). Then, only after a backup, run the encryption backfill.
3. Send the 10 missing register rows for Step 12 (PLT-01, 02, 05, 06, 07, 11, 12) and Step 13 (TAL-08, 09, 10). Step 14 only on explicit request.
4. PAY-08: sources for Pakistani statutory figures; also gratuity, provident fund and bank file formats (tenant-defined, nothing is typed from memory).
5. Part D question 4: Pakistan leave types.
6. dummy_records table drop needs an explicit OK.
7. Tenant-defined, none shipped: recruitment retention months, consent, offer validity, offer letter template, performance minimum raters for anonymity.

## E. Test data created in the live tenant (all named "QA-PARK 352760")

- Requisition 583c077d-3289-4384-bbaf-dd060ba579df ("QA-PARK 352760 Engineer"), status approved/open.
- Candidate 666966f3-f642-4d7d-8d22-7e8f8e790c4f (email on the example.invalid domain, so no real mail can go out).
- Application 797d78e5-a297-4aaa-8a75-6c97a9046440, now hired.
- Interview 2a560346-93e3-4df5-8430-249febd3bf4d with one feedback, completed.
- Pre-employment check aede12fc..., passed.
- Offers 7bcf19b9-c89e-4563-a82d-cee7420ef909 (rescinded) and ead3dbf0-dfbc-40c6-ada5-69d7de586345 (accepted), three letter versions.
- Employee d2d88399-e027-42b4-a1ce-650cc5f54e21 (EMP-0023) created by the accepted offer.
- EMP-0023: onboarding In Progress (empty) and offboarding In Progress (last day 2026-10-15), not finalised.
- Leave: one unpaid leave request (2026-10-19..20, reason QA-PARK) for the test user, now Cancelled. Payroll: one simulation run 2026-10-01..10-31, Cancelled.
- Performance on EMP-0023: two goals (QA-PARK 352760 goal A and B, plan finalised), one development plan with one action, one feedback message.
Cleanup is not done; deleting needs Kumail's approval and, for several of these (audit, append-only), may not be possible without a documented admin procedure.

## A2. Performance live test (UI driven, visible cursor, QA-PARK data only)

- Review Cycles: list shows the single "annual review" cycle; Phases dialog works. Validation works ("self assessment cannot start or end before goal setting does"); a start without an end is refused. Phase dates I saved during the test were cleared again (cycle shows "No deadlines set" as before).
- Goals: EMP-0023 (the employee created by the accepted offer, so the numbering EMP-0023 follows the normal sequence, which answers part of LIVE-04). Empty title refused, weight 150 refused client side, weight 110 total refused by the server ("Goal weights cannot add up to more than 100 (this would make 110)"), goals A (60) and B (40) saved, plan shows 100/100, goal update 5 of 10 gave 50% and the status moved to "In progress", History shows created and status change with the note, Finalise plan worked and the button turned into "Reopen plan".
- Development: new plan created, action added, status control present.
- Feedback: feedback sent to EMP-0023 and shown under "Feedback I have given"; visibility choices offered: employee+manager+HR, manager+HR only, HR only.
- Latency: each save took 10 to 16 seconds on the live stack (LIVE-02 confirmed in the UI).
- Not yet exercised: review ratings and scorecard, calibration, anonymity of 360 with the minimum raters, reopen plan, adding a goal after finalise.

## A3. Leave and payroll live test (UI driven)

- Leave: annual leave with 0 balance refused ("requested 2 day(s), 0 remaining for 2026"); submit on behalf for EMP-0023 refused (no user account); unpaid leave for the test user: Pending, Approve (with optional comment step), Approved, Request cancellation, Approve cancellation, Cancelled. Balance cards stayed 0/0. Attendance correction form opens; the date-time typing in the test tool was not reliable so server-side correction rules are not re-tested here (covered by the e2e specs).
- Payroll (simulation only, nothing consumed or finalised): New run form has a "Simulation (what-if)" option, run created as Draft, Pre-validate gave 121 problems and 122 warnings, Calculate gave a 504 in the browser but completed in the background, run cancelled with a reason (reason of at least 5 characters is required). No approval, finalisation or payment was touched; the real "Pending approval" run for 2026-09-01 to 2026-09-30 is untouched.

## A4. Overtime and employee lifecycle (UI driven)

- Admin Center, Overtime: a company-wide policy exists (1.5x weekday, 2x rest day, 2x holiday, minimum extra minutes 0, no daily or monthly cap, comp-off 480 minutes per day, overtime prior approval off). The editor opens and cancels cleanly; I did not save any change to the real policy. End-to-end overtime could not be exercised because the test user has no shift assigned ("No shift assigned") and no processed attendance days.
- Employee EMP-0023: Start onboarding worked (empty process, see LIVE-16); Start offboarding worked with last day 2026-10-15 although joining is 2026-11-14 (LIVE-17). "Finalize offboarding (terminates employee)" was NOT clicked: the environment blocked it as a change to shared data. EMP-0023 is therefore left with onboarding In Progress and offboarding In Progress; finalising or cleaning needs Kumail's decision.

## F. Still to test

Performance remainder (review ratings and scorecard, calibration, 360 anonymity, reopen plan), termination finalise on EMP-0023 (needs Kumail's OK), overtime with a shift-assigned employee, permission checks as a plain employee and tenant isolation checks (both need a second test login that Kumail creates; no accounts or passwords are created on production by Claude). This file will be updated as each area is finished.

---

## Update 2026-10-15 (v4): leave balances, dummy config, SAP reference

**LIVE-18 - an existing zero balance row is never refreshed by policy.** `LeaveLedgerService.ensureBalance` returns an existing row untouched, so assigning a policy afterwards does not change a balance that was already created at 0. The QA-PARK dummy policy therefore left EMP-0001 at 0 days until a manual adjustment was posted. Decision needed: re-run opening-balance posting when a policy is (re)assigned, or document that HR must post an adjustment.

**LIVE-19 - no admin screen for balance adjustment.** `POST /leave-balances/adjustments` exists (employeeId, leaveType, year?, days, reason) but nothing in the web app calls it for HR. Needed for LIVE-18 workarounds.

**Dummy configuration created for end-to-end tests (Kumail allowed dummy data):** QA-PARK dummy leave policy, QA-PARK employee group, 5-day dummy annual-leave balance for EMP-0001, one pending annual-leave request 2026-10-19..20. Clean up together with the other QA-PARK data (section E).

**SAP Fiori "My Leave Request" reference, performed by hand (dummy SAP system):** Entitlement table (Quota Type / Validity / Available / Planned / Used / Entitlement, "Show From" date), Request Overview with Calendar and Items tabs (Sat-first week, week numbers, Fri/Sat non-working, 9-item legend, click two dates to create), Items rows with edit pencil, delete x ("Do you really want to delete this request?") and a detail page (header, Team calendar). Create/Edit form: leave type with "N Days available", "More than 1 day / One day or less" toggle, "N Days will be consumed", 1st/2nd level approver (read-only), note, relief number (required) and name, working/absence days, return date (required), employee number, exit permit and exit date. "Create Request" has a second icon that opens Select Employee (Direct Reports first) and an "acting on behalf of" banner.

**Built in our app (patch sap-style-leave-ui.patch):** entitlement table, calendar + items tabs, form toggle with available/consumed/return-date preview and relief person, Select Employee on-behalf flow with banner and stop icon. **Not built (no backend field):** approver display, exit permit/exit date, employee-number field, edit request, team calendar, "Show From" filters. Display weekend is hard-coded Sat/Sun; should come from the company work schedule.

**SAP on-behalf icon, full run (2026-10-15, dummy SAP):** icon beside Create Request -> Select Employee dialog (Direct Reports group, photo, name, Employee Number; search box filters live, e.g. "Sajid" -> one hit, with clear x) -> pick employee -> yellow banner "You are acting on behalf of employee "Md Sajid Ali (10001494)"", page reloads with that employee's own entitlements (40/7/10), items (0), and own approvers on the form -> pick 26.-27.10. on the calendar -> Create form prefilled (leave type Annual Leave (Regular), "40 Days available", "2 Days will be consumed", relief number and return date empty and required) -> Save -> toast "Request sent successfully", calendar shows an orange "Sent" underline on both days, Items (1) -> revert icon -> toast "You are acting for your own employee number", banner gone, own data back. Test record left in the dummy SAP: one Sent annual-leave request for 10001494, 26.-27.10.2026, relief 10001496 (clean up there if wanted). Observations: Relief name does not fill in while typing the number; Planned on the entitlement table stayed 0 right after Save; our form auto-fills the return date, SAP leaves it empty.

---

## v5 — LV-UP: My Leave Request now matches the SAP Fiori leave app (2026-10-15)

Scope: only the Leave request app. The whole-app Fiori re-skin / shell / launchpad was postponed by Kumail ("filhal sirf hamari leave request app ko upgrade kro").

### What was built (on top of the earlier `sap-style-leave-ui.patch`)

New endpoints (all behind the existing leave module guard and RLS; no migration, so no rollback needed):

- `PATCH /leave-requests/:id` — edit a request while it is still pending and no approver has acted (leave type, dates, reason, day part, relief person). Re-prices and re-validates (balance, overlap excluding itself, policy) through the same `priceAndValidate()` used by submit. Not allowed after any approval/decision (409), and only by the owner or someone who may submit on behalf.
- `GET /leave-requests/team-calendar?from&to[&employeeId]` — pending/approved leave of the employee and the colleagues under the same manager, max ~93 days, visibility checked per subject (404 otherwise).
- `GET /leave-requests/colleagues[?employeeId]` — the people who can be named as relief person (same manager, not the employee). Exists because an ordinary employee cannot list other employees.
- `LeaveRequestView` now carries `employeeName`, `employeeNumber`, `leaveTypeName`, `delegateEmployeeName`, `absenceDays` and `approvals[]` (approval chain: step, approver name, status, decided at).

UI (Leave request app): Entitlement table, Calendar / Items tabs, Approver column, pencil (edit) / x (cancel) / chevron (detail) icons, Show From filter, request detail page with approval chain and Team calendar (week view), create-from-calendar (pick two days), request form with availability and "N days will be consumed" preview, read-only Working/Absence days and Return date, approvers shown when editing, relief picker from the colleagues endpoint, HR "Select Employee" dialog with search, on-behalf banner and stop icon.

### Tests
- `leave-requests.lvup.spec.ts` (17 incl. colleagues), `leave.e2e.spec.ts` LV-UP block, web helper tests `leaveCalendar` (16) + `leaveApprovals` (5).
- `LeaveRequestSap.e2e.spec.ts`: 6 real-browser flows (login, entitlement/items/detail, edit with pencil incl. relief picker for an ordinary employee, edit blocked after approval, Show From, calendar-to-create, HR on-behalf). Run together with the older `LeavePage.e2e.spec.ts`: 17/17.
- Backend regression: full jest 2324 passed; the one `auth.e2e` failure was a flake (passes alone, 15/15).
- Old `LeavePage.e2e` accessibility test updated: it asserted the leave-type label by two fixed `for` names; the form now pairs label and select (`htmlFor`/`id`), and the test checks that pairing.
- RBAC / tenant isolation / audit: edit and colleagues respect `isVisible` (other tenant and non-visible staff get 404; outsider rejected); edit is audited like submit; tenant B staff sees none of tenant A.

### Deferred (with reasons)
- Exit permit / exit date, Employee No. field, editable return date: Gulf-specific in SAP, no backend field.
- Entitlement "Show From" for balances: balances exist for the current year only.
- Workflow record context is not refreshed on edit (stale `leaveType`/`days` only affect start conditions evaluated at submit).
- Weekend display is hard-coded Sat/Sun; should follow the work schedule.
- Team calendar lists only colleagues who actually have leave in the window.
- SAP quirk observed: "Planned" stays 0 right after save.

### VERIFY on live
1. Apply the three patches in order, deploy API then web. 2. As an employee with a manager: create a request, press the pencil, change end date, save; relief picker lists teammates. 3. Approve it as manager, confirm the pencil disappears. 4. Open detail: approval chain + team calendar show. 5. HR: Select Employee, create on behalf.

---

## v6 — Release 2: tiles launchpads, page navigation, workflow template editing (2026-10-15)

Kumail's feedback on release 1: too much on one page, half the screen empty; use page-to-page navigation and tiles; Time & Attendance and Leave Management are different things and must not be mixed.

### Built (patch `leave-ui-tiles-pages-workflow-edit.patch`, no migration, so no rollback needed; revert the commit to undo)
- Two modules, two sidebar entries and two home cards: **Leave Management** (`/app/leave`) and **Time & Attendance** (`/app/attendance`). Each opens on tiles; each tile is its own page.
- Leave Management tiles: My Leave Request (shows days available), Create Leave Request, Holidays, Leave Approvals (waiting count), Request on Behalf (HR). Pages: `/my-requests`, `/new`, `/:id`, `/:id/edit`, `/approvals`, `/holidays`, `/on-behalf`, `/on-behalf/:employeeId`.
- Time & Attendance tiles: Clock In / Out, My Attendance (14 days), Timesheet, Attendance Corrections, Correction Approvals (waiting count). Pages: `/clock`, `/days`, `/timesheet`, `/corrections`, `/approvals`.
- Tiles only appear for roles that may use the page; the server still decides what each page may do.
- `GET /leave-requests/approver-preview[?employeeId]`: the approval chain shown on the create form (manager of submitter, specific person or role name). Display only.
- **Workflow template bug (reported by Kumail: approvers could not be configured).** Once a template was Configured, System Admin > Workflow Templates offered no way to change it (only "Configure" when none existed), although `PUT /workflow/templates/:key` and `POST .../active` already existed. Now: **Edit approvers** (publishes a new version; steps/approvers it does not show, such as conditions, quorum, position/group approvers, are kept), **Switch off / Switch on**, version note, real names in the step summary, and the screen no longer fails completely when the people list cannot load.

### Tests
- `leave-requests.lvup.spec.ts` now 20 (3 new for approverPreview: own manager, tenant isolation, visibility, follows an edited template, empty while switched off). `src/leave` + `src/workflow` jest: 13 suites, 207 tests passed.
- Playwright: Leave + Attendance 18/18 (tile launchpads, separation of the two modules, nav entries, create/edit/on-behalf flows); System Admin 6/6 incl. new "edit approvers and switch off/on".
- Web `tsc` clean, lint 0 errors, helper tests 21/21, vite build OK.

### VERIFY on live
1. Sidebar shows Leave Management and Time & Attendance (no "Leave & Attendance"). 2. Each opens tiles; a tile opens its page; the Back link returns to the tiles. 3. System Admin > Workflow Templates > Edit approvers on Leave approval: change an approver, Save changes, "Version" goes up. 4. Create a leave request: the approver row on the form shows the new approver.

### Still open
- Workflow editing UI covers role / specific person / submitter's manager; position, group, org-unit-head and dotted-line approvers are kept as stored but cannot be chosen there yet (parked WFL UI item).
- Gap items still to do: LIVE-02/03/05/07/08/09/10/12/13/14/15/16/17/18/19 and parked C-list. Backend for LIVE-15/16/17 is written locally but untested and not in this patch.

---

## v7 — Repo cleanup and folder alignment (2026-10-15), no behaviour change

Patch `repo-cleanup-align-layout.patch` (applies after release 2). Verified: api and web `tsc` clean, `turbo run build` 3/3, web lint 0 errors, Playwright Leave + Attendance + System Admin 19/19, api jest for database and the legacy-field guard.

- **Root:** `DECISIONS.md`, `KNOWN_ISSUES.md` and this file moved to `docs/` (with `docs/README.md`). README repo layout rewritten to match the code. `render.yaml` and `netlify.toml` stay at the root because the platforms need them there.
- **API:** the four read-only `check-*` diagnostics moved from `src/database/` to `apps/api/scripts/diagnostics/` (run instructions in `apps/api/scripts/README.md`). New `apps/api/tsconfig.build.json` makes `nest build` compile `src/` only and skip specs: `dist` 19 MB to 13 MB, `dist/main.js` unchanged. Operational tools stay in `src/database/` (migrate, seed, seed-pilot, grant-role, encrypt-backfill) because they have npm scripts and README references.
- **Git hygiene (closes parked C3):** `.gitignore` now covers `*.rdb`, `apps/api/scripts/local/`, the local TOTP and seed helper scripts (`get-totp-*`, `seed-kumail-test`, `check-e2e-test-data`) and Playwright output and temp configs. Deploy script untracks `apps/api/src/dump.rdb` if it was committed. Those personal scripts hold a real login email and TOTP lookups; the files themselves stay on the developer machine.
- **Web:** Time & Attendance code moved to `portal/attendance/` (launchpad, routes, panels, correction approvals, labels, its own e2e spec). Shared pieces to `portal/shared/` (Tiles, PageChrome, FormSections, ModuleContext, describeError). `LeavePage.tsx` split into `LeaveApprovalsList`, `CorrectionApprovals`, `UpcomingHolidaysCard`. `pages/` split into `auth/` (Login, Signup, SSO) and `platform-admin/` (companies, audit log, platform admins, branding, Layout). Dead `ComingSoonPage` removed.
- Workflow template card renamed "Leave request approval" (it routes leave requests only).

Deliberately not moved: the flat `apps/api/src/<feature>/` modules (standard Nest layout, moving them would touch hundreds of imports with no gain), SQL migrations (already ordered and applied in production), `README.md` at the root.

---

## v8 — Organization hierarchy as "Staff assignments (structure)" tree-table (2026-10-15)

Request: use the SAP "Staff assignments (structure)" layout for the organization hierarchy UI. Patch `org-structure-sap-layout.patch` (applies after release 2 and the cleanup patch). No migration.

- **API:** `GET /organization/structure` (new `OrgStructureService` + controller, registered in `OrganizationModule`). One nested read model: unit > chief position first > other positions > holders. Per node: code, SAP-style object id (`O|S|P` + 8 hex), relationship text (unit "Is line supervisor of", position "Incorporates", holder "Holder"), chief (holder of the unit's head position), valid from / valid to (`null` = Unlimited). Scope is the same as the existing org-unit and position lists (data-scope, tenant isolation); people and chief are hidden for users who cannot list employees. Rollback: remove the controller and service registration; nothing else depends on it.
- **Web:** `/app/organization` is now the tree-table: columns Name | Code | ID | Relationship text | Chief | Valid from | Valid to; unit rows blue-tinted, chief position orange / other positions dark red, person icon for holders; selected row amber with red outline; expand/collapse triangles; toolbar (expand all, collapse all, open every unit, refresh, open, find, key date, Positions / People / Show ended). Keyboard: arrows, Home/End, Enter; double-click opens the unit, position or employee. The previous editing page (drag and drop, move, head position) is kept at `/app/organization/manage` and linked as "Edit structure" for HR.
- **Tests:** `org-structure.service.spec.ts` 5 (nesting and order, chief, validity, ESS sees units and positions but no holders, tenant isolation); `orgStructure.test.ts` 7; Playwright `OrgStructure.e2e.spec.ts` 2 (columns, chief, expand/collapse, find, selection, Edit structure link, double-click). Api and web `tsc` clean, web lint 0 errors.
- **VERIFY on live:** Organization opens the tree-table; the root unit shows Unlimited; the unit with a head position shows the holder under Chief; "Edit structure" opens the old page; an employee login sees units and positions without people.
- **Open:** key-date filter hides rows by validity only; reorganisation-dated future versions are shown by their own valid-from date.

### v8a — Structure icons redrawn after the SAP originals
`OrgIcons.tsx`: unit = pale rounded box, position = seated figure (orange with a cap for the chief position, dark red otherwise), holder = two people (blue and green). Replaces the generic armchair and user icons. Patch `org-structure-icons.patch` (applies after `org-structure-sap-layout.patch`). VERIFY: Organization tree shows the three icon types; hovering shows "Organizational unit", "Position (chief)", "Position" or "Holder".
