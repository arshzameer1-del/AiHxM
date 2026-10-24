# Reports & Analytics: coverage against the master instruction

Honest status of each requirement. *Done* means built, tested and in the product. *Partial* says what is missing. *Not built* means a later phase; nothing marked so is faked on screen.

## Catalog and reports (section 6)

| Requirement | Status |
|---|---|
| 220 report definitions with stable ids A01 to O15 | Done. All 220 are in the catalog (REPORT_CATALOG.md). |
| Reports that run against real data | **193 of 220 available**, each with a query, calculation text and tests. |
| Reports whose data does not exist | **27 blocked**, each with the reason shown to the user and a plan to unlock it (BLOCKED_REPORTS_DEVELOPMENT_PLAN.md). None is estimated. |
| "All 220 implemented" | **Not claimed.** 27 cannot be honestly produced yet. |

By category (available of total): A 14/15, B 15/15, C 15/15, D 15/15, E 14/15, F 9/10, G 14/15, H 15/15, I 10/15, J 13/15, K 14/15, L 10/15, M 11/15, N 9/15, O 15/15. (REPORT_CATALOG.md is the source of truth.)

## Rules (section 1)

| Rule | Status |
|---|---|
| Audit first, extend, do not rebuild | Done. Existing routes, RBAC, audit, RLS and layout are reused. The old Workforce Analytics page is untouched. |
| No fake functionality | Done. Blocked reports show their reason; a missing value is a dash, never zero; the smoke test fails if the catalog and queries disagree. |
| Security is a release blocker | Done for this release (SECURITY_MODEL.md): server-side tenant isolation, RBAC on every call, row and field scope, audit of exports and sensitive opens, no user-supplied SQL. |

## Experience (section 4)

| Item | Status |
|---|---|
| Report Library: search, category, status, favorites, recent | Done. Search covers id, title, description, category and tags. |
| Report detail: filters, applied chips, KPI cards, charts, table, "How is this calculated?", notes, export, favorite | Done. |
| Loading, no-data, blocked, error, denied and partial-data states | Done. |
| Overview landing page with role-aware KPIs and presets (Today, This month, and so on) | Done. `/app/reports` is the Overview: headline figures and a short list of things that need attention, each only for what the caller may see. Every report has period presets. |
| Comparison period on a report | Done. A switch compares every figure with the equal period before and shows the change; refused on reports with no date range. |
| My Reports, Shared with me, Report Builder, Dashboards, Scheduled Reports, Export history | Done (tabs on the Reports page). |
| Drill-down | Done for the headcount reports (A03, A04, A05 open the matching employees in B01). |
| Administration screen for the whole company's saved reports, shares, schedules and dashboards | Done as reports: O06, O07, O08, O09, O13, O14 and N06. |
| Save, share and schedule actions on a report | Done. Save this view, Share, and Schedule are shown to people who hold the matching permission. |

## Access (section 5)

| Item | Status |
|---|---|
| Four new permissions, role grants, deny by default | Done (migration 0164). |
| Tenant, team and payroll-area scope | Done and tested. |
| Sensitive and restricted classes, small-group suppression | Done and tested. |
| Separate export permission | Done. |

## Query engine, filters, caching (section 8)

| Item | Status |
|---|---|
| Allow-listed, parameterised queries; framework refuses unscoped queries | Done. |
| Standard filters: date range, department, location, employment type and status, leave type, request status, run status | Done, validated and checked against the caller's scope. |
| Company time zone applied to every run | Done. |
| 15 s timeout, five-year range cap, throttling | Done. |
| Caching | **Not built, by choice.** Every run is live and shows its "as of" time. A cache needs the key rules in section 8.3 and is not worth the risk until a report is proven slow. |

## Visualization (section 9)

| Item | Status |
|---|---|
| KPI card, bar, grouped bar, stacked bar, donut, line, table | Done (VISUALIZATION_GUIDE.md). |
| Accessible: summary, keyboard, table alternative, legend, tooltip | Done. |
| Heatmap, funnel, dashboard widget library | Not built; no report in this release needs them. |

## Builder, dashboards, export, scheduling, AI (sections 10 to 13)

| Item | Status |
|---|---|
| CSV export with audit and formula-injection defence | Done. |
| XLSX and PDF export | Done. XLSX keeps text as text; PDF is capped at 2,000 rows and says so. |
| Export history | Done. The last 50 files a person downloaded (name, format, size, never the data). |
| Expiring download links for scheduled files | Done. Scheduled files are kept 14 days, then removed. |
| Background export jobs for very large extracts | Not built. Exports stay at 10,000 rows; bigger extracts belong to N07. |
| Saved reports and sharing | Done. Sharing never widens access: every viewer runs with their own permissions. |
| Report builder | Done for seven datasets from an allow-list (employees, leave requests, leave balances, attendance days, performance reviews, payslips, applications). Columns, grouping, measures, filters, sort. |
| Calculated fields | Not built. Measures are count, sum, average, minimum and maximum of one field. |
| Dashboard builder | Done. Up to 12 widgets (figure, chart or table) from library or saved reports. |
| Scheduling and delivery | Done. Daily, weekly or monthly, in the company time zone. Email when SMTP is set up, always kept in the app for 14 days. |
| AI-assisted analytics | Not built (optional phase). |

## Data model, API, tests (sections 14, 15, 18)

| Item | Status |
|---|---|
| Additive migrations with rollback notes | Done: 0164 to 0168. |
| API: catalog, entry, filter options, run, export, favorite | Done (`/reports/...`). |
| Backend tests | Done: against a real database (catalog parity, engine, smoke over every available report, hand-computed figures, scope, suppression, export, isolation, plus saved reports, sharing, builder, dashboards, exports, schedules and the reports about them). |
| Frontend tests | Done: unit tests for formatting and library filtering; Playwright end-to-end against the real API. |

## What to build next

From BLOCKED_REPORTS_DEVELOPMENT_PLAN.md: the rest of Wave 1 (A02, M09, M05, I11, E07, K06, F09), then the Wave 2 and 3 modules. Optional: AI-assisted analytics, calculated fields in the builder, background jobs for very large exports.
