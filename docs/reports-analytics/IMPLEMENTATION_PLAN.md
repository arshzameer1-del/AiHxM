# Reports & Analytics Intelligence Center: implementation plan and status

## 1. What the audit found (Phase 0)

- **Stack:** NestJS and PostgreSQL with row-level security on `company_id` in the API; React, Vite and Tailwind in the web app; shared types in `@aihxm/shared-types`.
- **Reusable:** the session guard, `RbacService` (permissions, `.all` / `.team` / `.scoped` data scope), `EntitlementsService` (module licences), `AuditService` (append-only audit log), `DatabaseService.withClaims` (tenant context per transaction), the background job runner, the portal layout and sidebar.
- **Existing analytics:** one Workforce Analytics page (`/app/employees/analytics`) with six counts, and ten report-like endpoints. They are left as they are.
- **No chart library** in the web app, so charts are built by hand (VISUALIZATION_GUIDE.md).
- **Gaps that shaped the design:** several operational tables are readable only by the platform (sign-in state, sessions, tenant settings, usage, exports, health); attendance has no permission of its own; the legacy `department` and `manager_id` text columns are being replaced by org units and reporting lines, so new code uses the new model only (a test guards this).

## 2. Design decisions

1. **Reports are code, the catalog is code.** 220 stable ids live in `apps/api/src/reports/catalog`, versioned with the queries they describe. A report moves from blocked to available only in the change that adds its query and tests; a spec fails if the two disagree.
2. **A declarative framework, not 220 hand-written endpoints.** `sqlReport`, `groupedReport` and `listReport` take columns, a query built from scope helpers, chart and KPI helpers and calculation text. The framework applies tenant limit, team or area scope and the chosen filters, and refuses a query that skips any of them.
3. **Reuse permissions.** Four new `reports.*` keys; data access comes from the permissions the product already has.
4. **No estimates.** A report whose data does not exist is blocked, with the reason on screen and a plan to unlock it.
5. **Live, not cached.** Each run shows its "as of" time; caching waits for a measured need.
6. **Narrow functions for platform-held data** instead of widening row-level security.

## 3. Phases against the contract

| Phase | Scope | Status |
|---|---|---|
| 0 Audit and plan | Inventory, plan, risks | Done (this document) |
| 1 Catalog and security foundation | 220 ids, permissions, access decision, scope, audit, telemetry, migration 0164 | Done |
| 2 Core report execution | Query framework, filters, 193 reports, export (CSV, XLSX, PDF) | Done. 27 blocked with reasons. |
| 3 Visual analytics | Library, report page, KPI cards, bar, stacked bar, donut, line, table alternative, empty, error and blocked states | Done. No heatmap or funnel (none needed yet). |
| 4 Saved reports and report builder | Saved definitions, sharing, builder | Done (migration 0167). Calculated fields not built. |
| 5 Dashboard builder | Widgets and composition | Done (migration 0167). |
| 6 Export and scheduling | XLSX, PDF, export history, schedules, delivery | Done. Background jobs for very large exports not built. |
| 7 AI analytics | Optional | **Not built** |
| 8 Hardening and release | Full regression, docs, release report | Done for the built scope. Overview page, period presets, comparison and drill-down added in v2. |

## 4. How the work was staged

1. Catalog, access and migration 0164.
2. Framework and the first reports (workforce, planning, recruitment, attendance, leave, payroll, performance).
3. Workflow, self-service, audit, learning, governance and operations reports, with migrations 0165 and 0166 for platform-held data.
4. Frontend: client methods, library, report page, charts, navigation, tests.
5. Reference docs generated from the code, and the plan to unlock the blocked reports.

## 5. Risks and how they are held

| Risk | Control |
|---|---|
| A new report leaks across companies | The framework refuses an unscoped query; cross-company isolation is tested; RLS is the second line. |
| A manager widens scope by passing ids | Filter values are checked against the caller's scope; tested. |
| Pay or personal data exposed through a "simple" report | Fields are listed per report; sensitive classes need a separate grant; B01 is tested for forbidden fields; small groups are suppressed. |
| Slow query on a large tenant | 15 s timeout, five-year cap, row caps, throttling, `report_run_log` timing. |
| Docs drift from code | REPORT_CATALOG.md and DATA_DICTIONARY.md are generated (`npm run docs:reports`). |
| Claiming more than is built | FEATURE-COVERAGE.md states every gap; the counts come from the catalog. |

## 6. Next steps

BLOCKED_REPORTS_DEVELOPMENT_PLAN.md gives the sequence for the 27 reports still waiting on data: the rest of Wave 1 (M09, M05, A02, I11, E07, K06, F09), then the Wave 2 and 3 modules. Optional later: AI analytics and calculated fields.
