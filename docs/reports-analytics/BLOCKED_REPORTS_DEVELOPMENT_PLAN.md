# Blocked reports: what to build to unlock each one

Status: written with the first release of the Reports & Analytics Intelligence Center.
Catalog today: **225 reports, 198 available, 27 blocked, 0 planned.** (The five employee master data reports B16 to B20 were added on top of the original 220 and are all available.) Reports v2 (October 2026) unlocked 11 reports: **L03, L06, I05, M14** (Wave 1) and **O06, O07, O08, O09, O13, O14, N06** (Wave 4, because saved reports, sharing, schedules, the builder and dashboards now exist). Their rows below are kept for the record and marked *Done*. Open: Wave 1 (7), Wave 2 (7), Wave 3 (9), Wave 4 (4).
A report is *blocked* when the data it needs does not exist in AiHxM. We do not estimate, sample or invent that data. Each report below names the missing data, the module or table to build, the screen that captures it, what the report can show once it exists, and a rough effort.

Effort is engineer-days for one developer including migration, API, screen, tests and the report itself (S = 1 to 2, M = 3 to 5, L = 6 to 12, XL = more than 12). They are planning estimates, not commitments.

Important rule for every item: the report is only as good as the data capture. Where a report needs history (access logs, snapshots, usage), it starts counting on the day capture ships. It cannot be back-filled, and the report page says so.

---

## Wave 1: small additions to existing modules (about 25 days, unlocks 11 reports)

These add one column, one setting or one table to something that already exists. Do these first: highest value for least work.

| Report | Missing | Build | Screen | Effort |
|---|---|---|---|---|
| ~~**L03**~~ *Done* Mandatory training compliance | `courses` has no mandatory flag or audience | `courses.is_mandatory`, `courses.mandatory_for` (all, org unit, employee type) and `renewal_months` | Learning: course form gets "Mandatory for" and "Renew every" | S |
| ~~**L06**~~ *Done* Training cost summary | Course cost is not stored | `courses.cost_amount`, `cost_currency`; optional `course_enrollments.cost_override` | Learning: course form gets cost | S |
| **M09** Critical position vacancy watchlist | No critical flag on positions | `positions.is_critical boolean`, `criticality_reason` | Organisation: position form toggle | S |
| **M05** Internal vs external hiring | Hire source is not recorded | `applications.candidate_source` (internal employee, referral, external) set when hired; for hires from outside the product, `employments.hire_source` | Recruitment: candidate form and hire-from-offer step | S |
| **A02** Headcount by legal entity | Organisation units have no legal-entity type | Add `legal_entity` to the allowed unit types, with registration number and NTN; units roll up to an entity | Organisation: unit type picker and entity details | M |
| ~~**M14**~~ *Done* Workforce data-quality trend | A14 is computed live, never stored | `data_quality_snapshots` (company, date, check key, passed, total) written by a nightly background job reusing A14's checks | None for users; report only | M |
| **E07** Leave liability estimate | No valuation rule | `leave_valuation_rules` (basis: basic salary or gross, days per month, which leave types are liable); the report applies the rule to `leave_balances` and `employee_compensation` | Leave policy: "Valuation" tab | M |
| ~~**I05**~~ *Done* Payslip access summary | Views and downloads are not recorded | Record each payslip open and download (who, when, channel; never the amount) in `payslip_access_log` | None; instrument the two payslip endpoints | S (history starts on release) |
| **I11** Mobile/PWA usage | Installed-app use is not tracked | `client_usage_events` (day, user, mode: browser, installed app, mobile browser) sent once per session, no device ids | None; small client beacon | S (history starts on release) |
| **K06** Budget vs actual people cost | Budgets exist per position only | `people_cost_budgets` (cost centre, period, amount, version) | Finance: budget grid with CSV import | M |
| **F09** Tax withholding summary | Tax figures are not validated for reporting | A reporting reconciliation: re-compute tax for each finalised run from the published tax profile and compare to the payslip; the report shows only runs that reconcile, and lists the ones that do not | Payroll: "Tax reconciliation" result on a run | M |

What shipped from this wave: L03 and L06 (course form has "Mandatory for every employee" and "Cost per participant"; compliance is measured against every current employee), I05 (opens of a payslip or published payslip document by the employee themselves are logged; downloads are counted as opens; history starts on release) and M14 (nightly snapshot of the A14 checks, kept per day). Still to do, in this order: M09, M05 (one-column changes), then A02, I11, then E07, K06, F09 (these need a short design with Finance/Payroll first).

## Wave 2: new but self-contained modules (about 45 days, unlocks 7 reports)

| Report | Missing | Build | Screen | Effort |
|---|---|---|---|---|
| **G12** Performance improvement plan status (restricted) | No PIP records | `improvement_plans` (employee, manager, reason, start, end, status, outcome) and `improvement_plan_milestones`; strictly HR-only RBAC, audit on every read | Performance: PIP tab on the employee, HR list | L |
| **J14** Segregation-of-duties exceptions | No SoD rules | `sod_rules` (two permissions or actions that one person must not hold or approve together), a nightly evaluation job writing `sod_findings`; ties in with the self-approval work already on the backlog (LIVE-03/14) | Admin: SoD rules and findings | L |
| **J15** Compliance evidence register | No register | `compliance_controls` and `compliance_evidence` (control, document, owner, due, status) | Admin: Compliance register | M |
| **M01** Headcount plan vs actual | No planned headcount | `headcount_plans` (org unit or position, period, planned FTE, approval via workflow) | Organisation: Plan grid with approval | M |
| **I07** Personal data change requests | Employees edit or call HR; no request record | `employee_change_requests` (field group, proposed values, status) using the existing workflow engine | ESS: "Request a change" on My Personal Data | L |
| **N04** API error and latency summary | Not stored (lives in hosting logs) | Daily aggregate table `api_metrics_daily` (route group, status class, request count, p50, p95) filled by a middleware | Platform Admin only | M |
| **N15** Availability and incidents | No uptime or incident data | `incidents` (start, end, impact, note) entered by operators plus synthetic-check results | Platform Admin: Incident log | M |

N04 and N15 are platform-operator views and belong in the Platform Admin console, not in a company's own Reports area.

## Wave 3: new modules that are products in their own right (about 80 days, unlocks 9 reports)

Plan these as separate projects with their own design. The reports are a small part of the work.

| Report | Module | Contents | Effort |
|---|---|---|---|
| **I08, I09** Service request status and ageing | Employee service desk | Request types and categories, SLA, assignment, status history, ESS and HR screens | XL |
| **I15** Employee experience pulse | Surveys | Survey builder, anonymous responses, minimum-group suppression (no result under five answers), schedule | XL |
| **L07, L08** Skills inventory and gap analysis | Skills | Skills catalog and levels, employee skills (self and manager rated), required skills per position, gap calculation | XL |
| **L11, L12, L14** Succession, critical-role coverage, talent pools | Succession and talent | Succession plans per critical position, successors with readiness, talent pools; restricted RBAC. L12 also needs M09's critical flag from Wave 1 | XL |
| **M15** Scenario comparison | Workforce planning | Named scenarios with explicit assumptions over M01's plan; deliberately last | XL |

## Wave 4: platform and report-builder dependencies

| Report | Depends on | Notes |
|---|---|---|
| **N02, N03, N13, N14** Active users, module adoption, entitlement usage, platform audit by tenant | Platform Admin console reports | Cross-company by nature. Build as Platform Admin reports with platform permissions; never expose through a company's Reports area. S each once the console has a report host |
| *Done:* **O06, O07** Saved and shared report inventory | Phase 4 of the contract: saved reports and sharing | The report is one query once `saved_reports` and `report_shares` exist |
| *Done:* **N06, O08, O09** Scheduled report job status, inventory, delivery success | Phase 6: scheduling | Needs `report_schedules`, `report_deliveries` and the background-job runner |
| *Done:* **O13** Custom report field usage | Phase 4: report builder | Needs saved custom definitions that record the fields used |
| *Done:* **O14** Dashboard widget usage | Phase 5: dashboards | Needs `dashboards` and `dashboard_widgets` |

These come for free, in the sense that each report is a few hours once its feature is built, so the order follows the contract's later phases: saved reports and sharing, builder, dashboards, scheduling.

---

## Suggested sequence

1. **Sprint A (about 2 weeks):** L03, L06, M09, M05, I05, I11. Six reports, mostly one-column changes.
2. **Sprint B (about 2 weeks):** A02, M14, E07. Needs one design conversation on leave valuation.
3. **Sprint C (about 3 weeks):** K06, F09, M01. Finance and payroll input needed first.
4. **Then, in business-priority order:** G12 and J14 (risk and control), J15, I07, then the Wave 3 modules one at a time.
5. **With the report-builder phases:** the O and N06 reports.

After Sprints A to C the catalog would stand at 193 of 220 available. Wave 2 would take it to 200, Wave 3 to 209, and the last 11 (Wave 4) arrive with the platform console and the report-builder phases.

## Rules that stay true while unlocking

- A report moves from *blocked* to *available* only in the same change that adds its query, its tests with hand-computed figures, and its catalog entry; the smoke test fails if the two disagree.
- New capture tables get row-level security, an audit trail for writes and a permission, like every other table.
- Anything about performance, discipline, health, succession or survey answers is *restricted*: HR permission, sensitive-report permission, small groups suppressed, every open written to the audit log.
- History-only reports (I05, I11, M14) say on the report page when counting started, so a short history is never mistaken for low activity.
