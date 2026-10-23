# Reports & Analytics: coverage against the master instruction

Honest status of each requirement. *Done* means built, tested and in the product. *Partial* says what is missing. *Not built* means a later phase; nothing marked so is faked on screen.

## Catalog and reports (section 6)

| Requirement | Status |
|---|---|
| 220 report definitions with stable ids A01 to O15 | Done. All 220 are in the catalog (REPORT_CATALOG.md). |
| Reports that run against real data | **182 of 220 available**, each with a query, calculation text and tests. |
| Reports whose data does not exist | **38 blocked**, each with the reason shown to the user and a plan to unlock it (BLOCKED_REPORTS_DEVELOPMENT_PLAN.md). None is estimated. |
| "All 220 implemented" | **Not claimed.** 38 cannot be honestly produced yet. |

By category (available of total): A 14/15, B 15/15, C 15/15, D 15/15, E 14/15, F 9/10, G 14/15, H 15/15, I 9/15, J 13/15, K 14/15, L 8/15, M 10/15, N 8/15, O 9/15. (REPORT_CATALOG.md is the source of truth.)

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
| Overview landing page with role-aware KPIs and presets (Today, This month, and so on) | **Not built.** The library is the entry page; filters use plain From and To dates. |
| Comparison period on a report | Partial. Reports that define a change (growth, net change) show it; there is no general compare-to-previous-period switch. |
| My Reports, Shared Reports, Report Builder, Dashboards, Scheduled Reports, Export history, Administration | **Not built** (phases 4 to 6). |
| Save, share and schedule actions on a report | Not built; the buttons are not shown. |

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
| XLSX and PDF export, background export jobs, expiring download links | Not built. CSV is capped at 10,000 rows. |
| Report builder, calculated fields | Not built. |
| Dashboard builder | Not built. |
| Scheduling and delivery | Not built. |
| AI-assisted analytics | Not built. |

## Data model, API, tests (sections 14, 15, 18)

| Item | Status |
|---|---|
| Additive migrations with rollback notes | Done: 0164, 0165, 0166. |
| API: catalog, entry, filter options, run, export, favorite | Done (`/reports/...`). |
| Backend tests | Done: 126 against a real database (catalog parity, engine, smoke over every available report, hand-computed figures, scope, suppression, export, isolation). |
| Frontend tests | Done: unit tests for formatting and library filtering; Playwright end-to-end against the real API. |

## What to build next

In this order, from BLOCKED_REPORTS_DEVELOPMENT_PLAN.md: the small additions that unlock 11 reports (Wave 1), then saved reports and sharing (unlocks O06 and O07), then the Overview page and date presets, then XLSX export, scheduling and the builder.
