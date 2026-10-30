# Marketing capability inventory

The source of truth for what the marketing sites (apps/marketing and apps/site) may say. Derived from the platform capability document
(2026-10-23) and checked against the code. A claim on the site must match a row here, with the same status.

Status: **Available** works today. **Needs setup** works once the company enters its own data or configures a service.
**Partly built** some of it works. **Not built** on the list, not in the product. **Unverified** exists in code, never
proven live; the site does not claim it.

| Claim on the site | Status | Evidence (where to look) |
| --- | --- | --- |
| Employee records, lifecycle, effective dating | Available | `apps/api/src/employees`, `effective-dating` |
| Org units, positions, jobs, locations, cost and profit centres, reorganisations | Available | `apps/api/src/organization` |
| Employee groups drive leave policy | Available | `apps/api/src/employee-groups`, `leave` |
| Custom fields, document templates, bulk import | Available | `custom-fields`, `document-templates`, `import-export` |
| Six-step payroll run, variance check (20% net, 50% tax, min Rs 1,000) | Available | `apps/api/src/payroll` (variance thresholds fixed in code) |
| Tax slabs and statutory settings entered by the company | Needs setup | `payroll` setup tables; no rates fixed in code |
| Cumulative tax July to June, retroactive calculation | Available | `payroll` |
| Payslips, year-end tax and salary certificates, settlements | Available | `payroll`, payslip designer |
| Income tax, EOBI, social security reports (CSV) | Partly built | No FBR upload, annual statement or challan layout; EOBI wage base unconfirmed |
| Bank payment batches | Partly built | Company-defined generic layout; no named-bank or Raast layout |
| Accounting journal CSV with GL mapping | Available | `payroll` |
| Payroll register or summary by department/cost centre | Not built | Gap register |
| Scheduled or auto-prepared payroll run | Not built | Gap register |
| Clock in/out, GPS, manual entry, auto-close of one-sided punches | Available | `apps/api/src/shifts`, attendance modules, scheduler |
| Device ingest (biometric) | Needs setup | Rotating device keys; devices on the customer side |
| Shifts, work profiles, timesheets, corrections, overtime, on-duty | Available | attendance modules |
| Leave policies, balances, accrual, team calendar, approver preview | Available | `apps/api/src/leave`, `holidays` |
| Pakistani fixed-date public holidays 2026 and 2027 in starter setup | Needs setup | `starter-setup`; moon-sighting holidays added by HR |
| Recruitment pipeline, offers, onboarding and offboarding | Available | `recruitment`, `onboarding-offboarding` |
| Performance cycles, goals, assessments, feedback, development plans | Available | `performance` |
| Learning catalogue and enrolments; expense claims | Available | `learning`, `expenses` |
| 15 workflow templates, versioning, comment rules per step, delegations, one inbox | Available | `apps/api/src/workflow` (migration 0162 added comment on approve) |
| Role-based home pages, personal data, org chart | Available | `apps/web` portal |
| Installable on Android and iPhone (PWA) | Available | `apps/web/public/manifest.webmanifest`, `sw.js` |
| In-app notifications | Available | `notifications` |
| Email notifications | Needs setup | `mailer` (SMTP); not verified in production |
| WhatsApp and push | Not built | Recorded only; no provider |
| Row-level tenant isolation | Available | `rls-coverage.spec.ts`, `cross-tenant-isolation.e2e.spec.ts` |
| MFA, step-up, SSO (SAML, OIDC), SCIM 2.0 | Available | `auth`, `sso`, `scim` |
| Field-level permissions, per-company encryption | Available | `rbac`, `crypto` |
| Audit trail, data-subject request workflow | Available | `audit`, `data-subject-requests` |
| Webhooks with history and replay | Available | `webhooks` |
| Company sign-in address and branded login | Available | `public-branding`, login routes |
| Urdu interface | Not built | English only |
| Third-party certifications (ISO 27001, SOC 2), uptime figure | Not claimed | None held or stated |
| Demo request form storing to a database | Available | `apps/api/src/demo-requests`, migration 0163, e2e test |
| Optional email to the sales inbox for new demo requests | Needs setup | `DEMO_NOTIFY_EMAIL` plus SMTP |
| Customer logos, testimonials, statistics, ratings | Not claimed | None exist to show |
| Prices | Not published | Quoted on request |
| Form designer on the Employee form (sections, order, custom fields, show-when and required-when rules, draft, publish, versions) | Available | `apps/api/src/form-settings`, `FormDesignerPage.tsx`, migrations 0196-0202 (2026-10-30) |
| Capability statuses for the brand website (apps/site) | Source of truth moved | `apps/site/src/content/flags.mjs` and the module content files; keep this table in step |
