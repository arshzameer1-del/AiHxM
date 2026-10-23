# Reports & Analytics: operations

## Run it locally

```
service postgresql start
redis-server --daemonize yes --dir /tmp
cd apps/api && npm run migrate          # applies 0164 to 0166
npm run dev                              # API on :4000
cd ../web && npm run dev                 # web on :5173
```

Open `/app/reports` as an HR Admin. A fresh company shows reports with honest zeros and empty states; the demo seed (`npm run seed-demo`) gives real figures.

## Tests

```
cd apps/api && npx jest src/reports            # 126 tests, real database
cd apps/api && npx jest src/database/rls-coverage.spec.ts
cd apps/web && npx tsx --test src/portal/reports/*.test.ts
cd apps/web && npx playwright test src/portal/reports   # needs API and web running
```

What the API tests prove: the catalog and the code agree in both directions (an "available" report has a query, a query exists only for an "available" report); every available report runs on an empty and a populated company and returns what its columns declare (smoke); hand-computed figures for the workforce, recruitment, attendance, leave, payroll, performance, workflow, service, audit, learning, governance and operations reports; scope (tenant, team, payroll area); small-group suppression; sensitive refusal; export (BOM, formula defence, audit); tenant isolation.

## Migrations (all additive)

| Migration | Adds | Rollback |
|---|---|---|
| 0164 | `reports.*` permissions and role grants; `report_favorites`, `report_recent_views`, `report_run_log` | In the file header |
| 0165 | `app.report_company_accounts()`, `app.report_company_sessions()` | In the file header |
| 0166 | `app.report_company_configuration/integrations/usage/exports/health()` | In the file header |

None of them changes or removes an existing object. Rolling back drops only report objects.

## Regenerating the reference docs

`cd apps/api && npm run docs:reports` rewrites REPORT_CATALOG.md and DATA_DICTIONARY.md from the code. Run it whenever a report is added, unblocked or its tables change. Do not edit those two files by hand.

## Adding a report

1. Add its definition (id, title, domain, sensitivity) to the catalog if it is new, or change its status from blocked.
2. Write it in the matching file under `engine/executors` with `sqlReport`, `groupedReport` or `listReport`. Use the scope helpers (`q.emp()`, `q.area()`, `q.co()`); the framework refuses a query that skips scope.
3. Declare only the filters the query applies, and write the calculation sentences users see under "How is this calculated?".
4. Add a hand-computed test with fixture rows. The smoke test fails if the catalog and the executors disagree.
5. Run `npm run docs:reports`.

## Watching it in production

- `report_run_log` (company, report, kind, status, duration, rows) is the usage and failure record. O01 to O05, O10, O11 and O15 are built on it, so an administrator sees the same in the product.
- `audit_log` holds every export and every Sensitive or Restricted run.
- A report that exceeds 15 seconds is cancelled and logged with the category `timeout`. Repeated timeouts for one report mean its query or an index needs work; the SQL is never logged, so reproduce it from the report definition.
- Exports are capped at 10,000 rows. A user who needs more should narrow by date or department; larger extracts belong to the data export job (N07), not to a report.

## Known limitations

See SECURITY_MODEL.md section 8 and BLOCKED_REPORTS_DEVELOPMENT_PLAN.md. In short: no saved reports, sharing, scheduling, dashboards, report builder, XLSX/PDF export or AI analytics yet; 38 reports wait on data AiHxM does not capture; live data only, no snapshots.
