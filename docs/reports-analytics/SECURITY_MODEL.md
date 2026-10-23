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
- CSV only in this release. 10,000 rows at most; a partial file says so in its header lines. Screen runs are capped at 500 rows and say so.
- Formula injection is closed: a text cell starting with `=`, `+`, `-`, `@`, tab or carriage return is prefixed with a quote (`csv.ts`, tested in `report-engine.spec.ts`).
- The file is built from the same run the screen shows, so scope, suppression and filters cannot differ between screen and file.
- `Cache-Control: no-store`; throttled to 10 exports a minute per user.
- Every export is written to `audit_log` (`report.export`) with report id, version, row count, scope and filters, and never the rows. A refused export is recorded in `report_run_log` as denied.

## 6. Audit and telemetry

- `audit_log` (append only): `report.export` for every export and `report.run` for every Sensitive or Restricted run. Metadata carries the report id, version, sensitivity, row count, scope and filter values; never row data.
- `report_run_log`: one row per run, export, refusal or failure with timing, row count and an error category. It never stores filter values or rows. It feeds O01 to O05, O10, O11 and O15, so administrators can see usage and refusals.
- Favourites and recent views are per user and per company.

## 7. Resource limits

A statement timeout of 15 seconds applies to every report transaction, a date range may not exceed five years, runs are throttled to 60 a minute and exports to 10 a minute per user, and a timed-out report answers with a plain instruction to narrow the range. Failures are logged by category, never with the SQL.

## 8. Known limits, stated plainly

- Attendance reports borrow the leave-request permissions because attendance has no permission of its own yet. When one is added, change the `attendance` domain in `catalog/categories.ts`.
- Reports read live data; there are no snapshots. History-only reports are blocked until capture exists (see the blocked-reports plan).
- Saved reports, sharing, scheduling, dashboards and the report builder are not in this release. When they are built, each needs its own access rules and tests before the O-series reports on them unlock.
