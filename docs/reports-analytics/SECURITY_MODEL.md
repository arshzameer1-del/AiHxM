# Reports & Analytics: security model

Status: first release. This is the contract the code is held to; each rule below names the test that proves it.

## 1. What a report is allowed to do

A report is a typed definition in code (`apps/api/src/reports`), never free text from a user. The browser sends only a report id and a small set of validated filters. It never sends SQL, column names, table names or sort expressions, so there is nothing to inject into. Every value reaches the database as a bound parameter.

## 2. Who can see what

Access is decided on the server for every call, by one pure function (`decideAccess`, `report-access.ts`). It is deny by default and needs all of:

1. `reports.view` (opens the area; on its own it opens no data).
2. The module licence for the report's domain is on for the company.
3. A data permission for the domain the report reads. The product's existing permission is reused; no report invents access (domain table at the end of REPORT_CATALOG.md).
4. For Sensitive and Restricted reports, `reports.view.sensitive` as well.
5. Any extra permission the report names.

The result is a scope, which the query framework enforces, not the screen:

| Scope | Who | What the query is limited to |
|---|---|---|
| tenant | holds the `.all` permission | every record of the caller's company |
| team | holds only the `.team` permission | the caller's direct reports, through the active reporting line |
| scoped | payroll `.scoped` permission | the payroll areas the caller is assigned (directly, or through org unit, location or cost centre links) |

A manager with no employee record sees nobody. A company-wide payroll run (no area) is never visible to an area-scoped user. Filter values are checked against the caller's own scope, so passing another department's id returns nothing (tested in `reports.service.spec.ts` and `report-core.spec.ts`).

Role grants (migration 0164): HR Admin gets all four report permissions; Line Manager gets `reports.view` only; Employee Self Service gets none. The Reports & Analytics link is shown to HR Admin and Line Manager; it is a convenience, the API is the gate.

## 3. Tenant isolation

- Every table the reports read has row-level security on `company_id`, and report transactions run with the caller's own claims, never a service role.
- The framework refuses to run a query that is not limited to the company (`company_id = $n`) or that does not read through an `app.report_company_*()` function. Declaring a filter the query does not apply is also an error. These are checked on every run, so a mistake in a new report fails loudly in tests instead of widening data.
- Platform-only facts (sign-in state, sessions, tenant settings, usage, exports, health) reach a company through seven narrow SECURITY DEFINER functions that return only the current company's rows and never secrets (migrations 0165 and 0166; list in DATA_DICTIONARY.md). Execute is revoked from PUBLIC.
- Cross-company reports (N02, N03, N13, N14) are deliberately blocked in a company's area. They belong in the Platform Admin console.
- A Platform Admin session with no company is refused: it is not a tenant role.

## 4. Sensitive data

| Class | Examples | Rule |
|---|---|---|
| Standard / Internal | headcount, leave counts, request status | `reports.view` and the domain permission |
| Sensitive | demographics, ratings, pay aggregates, finance cost | also `reports.view.sensitive`; every run is written to the audit log |
| Restricted | the payroll register (F02) | same, and the page says every open is recorded |

Small groups are withheld or combined (fewer than 5 people) in demographic, rating and pay reports, with a note saying so. Fields that no report ever returns (national ID, date of birth, bank numbers, contact details, secrets, IP addresses, free-text comments) are listed in DATA_DICTIONARY.md. B01 (the directory) is tested to carry none of them.

## 5. Export

- Needs `reports.export`, plus `reports.export.sensitive` for Sensitive and Restricted reports. A catalog entry says whether the caller may export (`canExport`); the button is disabled otherwise and the API refuses anyway.
- CSV, XLSX and PDF. 10,000 rows at most for CSV and XLSX (a partial file says so); PDF stops at 2,000 rows and says so. Screen runs are capped at 500 rows and say so.
- Formula injection is closed: in CSV a text cell starting with `=`, `+`, `-`, `@`, tab or carriage return is prefixed with a quote (`csv.ts`, tested in `report-engine.spec.ts`); in XLSX text is stored as a plain string, never a formula (`export/formats.ts`, tested in `reports-v2.spec.ts`).
- The file is built from the same run the screen shows, so scope, suppression and filters cannot differ between screen and file.
- `Cache-Control: no-store`; throttled to 10 exports a minute per user.
- Every export is written to `audit_log` (`report.export`) with report id, version, row count, scope and filters, and never the rows. A refused export is recorded in `report_run_log` as denied.

## 6. Audit and telemetry

- `audit_log` (append only): `report.export` for every export and `report.run` for every Sensitive or Restricted run. Metadata carries the report id, version, sensitivity, row count, scope and filter values; never row data.
- `report_run_log`: one row per run, export, refusal or failure with timing, row count and an error category. It never stores filter values or rows. It feeds O01 to O05, O10, O11 and O15, so administrators can see usage and refusals.
- Favourites and recent views are per user and per company.

## 7. Resource limits

A statement timeout of 15 seconds applies to every report transaction, a date range may not exceed five years, runs are throttled to 60 a minute and exports to 10 a minute per user, and a timed-out report answers with a plain instruction to narrow the range. Failures are logged by category, never with the SQL.

## 8. Saved reports, sharing, builder, dashboards, schedules (Reports v2, migration 0167)

New permissions: `reports.build`, `reports.share`, `reports.schedule`, `reports.dashboard`. HR Admin holds all four; Line Manager holds build, schedule and dashboard. Everything here is additional to `reports.view` and the data permissions of the report: holding a new permission never opens data by itself.

- **Sharing never widens access.** A shared saved report or dashboard stores a definition, not data. Every viewer runs it with their own claims, so a manager sees only their team and a person without the data permission gets 403 (“shared with you, but you do not have access to the data in it”). A report that was not shared with the caller answers 404, so its existence is not revealed. Targets are people and roles of the same company; the list of people who can be picked needs `reports.share` or `reports.schedule`. Changing shares is audited (`report.share`).
- **Report Builder** compiles a definition to SQL from an allow-list of datasets and fields (`builder/datasets.ts`): employees, leave requests, leave balances, attendance days, performance reviews (sensitive), payslips (sensitive, payroll-area scoped) and applications (company-wide only). It offers no free text, contact, ID-number or bank fields. All values are bound parameters, ORDER BY uses output positions, and the compiler enforces the same invariants the framework does: company limit, team limit through the reporting line, payroll-area limit. Limits: 20 columns, 3 groupings, 6 measures, 20 filters. Custom runs are logged under the id X00 and counted in O13.
- **Dashboards** hold at most 12 widgets, each a library or saved report. Each widget runs separately with the viewer's access; a widget the viewer may not see shows as unavailable, not as an error for the whole page.
- **Schedules** run in the company time zone, with the owner's access at run time. If the owner has lost access the run fails with the category `forbidden` and nothing is generated; it is retried at the next time and stops after three failures. Recipients who may not receive it are skipped, and a run where no one could receive it is recorded as skipped. A recipient receives the file only if they could export that report themselves (the owner needs export rights; any other recipient also needs company-wide scope, so a scoped file is never forwarded to someone with a wider or different view). Files are kept 14 days in `report_deliveries.file_bytes` and then removed by a nightly job. After three failures in a row a schedule stops (status `failed`). Email is sent only if SMTP is configured; otherwise the run is stored and downloadable in the app. `REPORT_SCHEDULER_DISABLED=true` pauses scheduling and the nightly snapshot on one instance.
- **Export history** (`report_export_history`) stores the report name, format, row count and size, never the data. It is visible only to the person who exported.
- **Reports about reports** (O06 O07 O08 O09 O13 O14 N06) need administration rights. They never show the name of a private saved report, only that one exists, and they never show data or filter values.
- **Payslip access log** (`payslip_access_log`, migration 0168) records that an employee opened their own payslip or published payslip document: who, which, when. Never amounts. Opening it again within ten minutes counts once. Payroll staff and managers viewing a payslip are not recorded. A logging failure never blocks the employee.
- **Data quality snapshots** (`data_quality_snapshots`, migration 0168) store per day and per field only how many employees there are and how many have the field filled in. No values.
- All new tables have row-level security on `company_id` and are granted to the application role.

## 9. Known limits, stated plainly

- Attendance reports borrow the leave-request permissions because attendance has no permission of its own yet. When one is added, change the `attendance` domain in `catalog/categories.ts`.
- Reports read live data. The only history is what is captured on purpose: payslip opens and the nightly data quality snapshot (both start on the day they shipped and are never back-filled) and the report run log. Other history-only reports stay blocked until capture exists (see the blocked-reports plan).
- Scheduled files and data are held in the database for 14 days. There is no separate file store.
- The builder cannot add calculated fields, and joins across datasets are not offered.
- AI-assisted analytics is not built.
