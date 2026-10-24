# Data dictionary

Generated from the code by `npm run docs:reports` (apps/api). Do not edit by hand.

Which source tables the 193 available reports read. Every table is protected by row-level security on the company, and every report query is limited to the caller's company by the framework (a query that is not is refused at run time).

| Table | Read by |
|---|---|
| `application_stage_history` | C03, C05 |
| `applications` | C03, C04, C05, C06, C07, C08, C09, C11, C12, C13 |
| `attendance_correction_requests` | D07, I03 |
| `attendance_daily_results` | D01, D02, D03, D04, D05, D06, D10, D11, D12, D13, E06 |
| `attendance_records` | D06 |
| `audit_log` | J03, J04, J05, J07, J08, J09, J11, J12, O10 |
| `background_jobs` | H11, N05, N07 |
| `candidate_documents` | N08 |
| `candidates` | C04, C13 |
| `companies` | N01, N12 |
| `company_config` | J13, N12 |
| `competencies` | G13 |
| `cost_centers` | B10, F07, K03, K13, N12 |
| `course_enrollments` | L01, L02, L03, L04, L05, L06 |
| `courses` | L01, L02, L03, L04, L05, L06 |
| `dashboard_widgets` | O14 |
| `dashboards` | O07, O14 |
| `data_quality_snapshots` | M14 |
| `data_subject_requests` | J12 |
| `delegations` | H06 |
| `development_plan_items` | G14, L10, L15 |
| `development_plans` | G14, L10, L15 |
| `employee_addresses` | A14, B03, I10 |
| `employee_contacts` | I10 |
| `employee_cost_allocations` | B10, K03, K13 |
| `employee_documents` | N08 |
| `employee_education` | I10 |
| `employee_family_members` | I10 |
| `employee_important_dates` | A13, B11, B12, B14, M08 |
| `employee_job_history` | L13, M06 |
| `employee_lifecycle_events` | A12, A13 |
| `employee_offboarding` | A13, I14 |
| `employee_offboarding_items` | I14 |
| `employee_onboarding` | A13, C14, C15, I14 |
| `employee_onboarding_items` | C14, C15, I14 |
| `employee_payment_accounts` | I10 |
| `employee_qualifications` | B14, L09 |
| `employee_versions` | B02, J09 |
| `employee_work_profiles` | M02, M03, M12 |
| `employees` | A01, A03, A04, A05, A06, A07, A08, A09, A10, A11, A12, A14, A15, B01, B02, B03, B04, B07, B08, B09, B10, B11, B12, B13, B14, B15, C02, C11, C12, C14, C15, D01, D02, D03, D04, D05, D06, D07, D08, D09, D10, D11, D12, D13, D14, D15, E01, E02, E03, E04, E05, E06, E08, E09, E10, E11, E12, E13, E14, E15, F02, F08, G01, G02, G03, G04, G05, G06, G07, G08, G09, G10, G11, G13, G14, G15, H09, H10, H14, I01, I02, I04, I06, I10, I14, J01, K02, K03, K04, K05, K12, K13, L01, L02, L03, L04, L05, L06, L09, L10, L13, L15, M02, M03, M06, M07, M08, M10, M12, M13 |
| `expense_claim_receipts` | N08 |
| `expense_claims` | I03 |
| `feedback_requests` | G11 |
| `goal_updates` | G05 |
| `goals` | G04, G05, G06 |
| `holiday_calendars` | N12 |
| `holidays` | E14 |
| `hr_reference_catalog_items` | B09 |
| `import_batches` | N11 |
| `interviews` | C11 |
| `job_requisitions` | C01, C02, C03, C04, C05, C06, C07, C08, C09, C10, C11, C12, C13 |
| `leave_balances` | E01, E09, E10 |
| `leave_ledger` | E08, E10 |
| `leave_requests` | E02, E03, E04, E05, E06, E11, E12, E13, E14, E15, I03, I06 |
| `leave_types` | E01, E02, E03, E08, E15, N12 |
| `locations` | A01, A03, A04, A05, A06, A07, A08, A09, A15, B01, D11, D12, E12, E13, K04, M02, M03, M12, N12 |
| `notification_log` | I12, I13, N09 |
| `offers` | C06, C07, C08, C09, C13 |
| `on_duty_requests` | I03 |
| `org_change_items` | M11 |
| `org_changes` | A13, M11 |
| `org_relationships` | A10, A14, B03, B08, G09, I04, M10 |
| `org_units` | A01, A03, A04, A05, A06, A07, A08, A09, A15, B01, B04, B05, B06, B07, C02, D03, D04, D05, D10, D11, D12, E05, E09, E12, E13, F08, G02, G05, H09, K02, K05, L05, M02, M03, M04, M06, M12, N12 |
| `overtime_records` | D08, D09, I03 |
| `payroll_areas` | F03, N12 |
| `payroll_component_results` | F01, F04, F08, K07, K08, K09, K10, K11 |
| `payroll_costing_results` | F07 |
| `payroll_exceptions` | F10 |
| `payroll_journals` | K14, K15 |
| `payroll_overrides` | J10 |
| `payroll_reconciliations` | F06, K15 |
| `payroll_run_events` | J10 |
| `payroll_run_partitions` | F10 |
| `payroll_runs` | F01, F02, F03, F04, F05, F06, F07, F08, F10, I05, J10, K01, K02, K03, K04, K05, K07, K08, K09, K10, K11, K12, K14, K15 |
| `payslip_access_log` | I05 |
| `payslips` | F01, F02, F05, I05, K02, K03, K04, K05, K12 |
| `performance_reviews` | G01, G02, G03, G07, G08, G09, G10, G13, G15 |
| `permissions` | J02 |
| `persons` | B14, I10 |
| `position_incumbents` | B05, B06, M04 |
| `positions` | B01, B04, B05, B06, M04, N12 |
| `report catalog (defined in code)` | O12 |
| `report_deliveries` | N06, O08, O09 |
| `report_recent_views` | O02 |
| `report_run_log` | O01, O02, O03, O04, O05, O10, O11, O15 |
| `report_schedules` | N06, O06, O08, O09 |
| `report_shares` | O06, O07 |
| `review_cycle_phases` | G01, G03, G09, G15 |
| `review_cycles` | G01, G02, G03, G07, G08, G10, G13, G15 |
| `review_ratings` | G13 |
| `role_permissions` | J02 |
| `roles` | J01, J02, J06 |
| `saved_reports` | O06, O07, O13, O14 |
| `shift_assignments` | D10 |
| `shifts` | N12 |
| `tax_profiles` | N12 |
| `tenant_configuration` | J13 |
| `tenant_daily_usage_counter` | N01 |
| `tenant_data_exports` | N07, N11 |
| `tenant_health_check_log` | N10 |
| `tenant_integrations` | J13, N10 |
| `timesheets` | D14, D15, I03 |
| `user_accounts` | C11, I01, I04, J01, J06, J07 |
| `user_role_assignments` | J01, J02, J06, J08 |
| `user_sessions` | I02, J05 |
| `work_schedule_assignment_rules` | D13 |
| `workflow_attachments` | N08 |
| `workflow_instances` | C10, D15, E04, H01, H02, H03, H04, H05, H06, H07, H08, H10, H12, H13, H14, H15 |
| `workflow_step_approvals` | H01, H02, H05, H06, H07, H08, H09, H10, H12, H14, H15, I04 |
| `workflow_step_instances` | H01, H02, H05, H07, H08, H12, H15 |
| `workflow_template_steps` | H07, H13 |
| `workflow_template_versions` | J11 |
| `workflow_templates` | H03, H04, H08, H13, J11, N12 |

## Fields that reports never return

Reports return only the columns declared in the report definition. The following are never selected by any report, whatever the caller's permissions:

- National ID (CNIC), passport and other identity numbers, date of birth (stored encrypted and not aggregated), bank account numbers
- Email addresses, phone numbers and home addresses of employees and candidates
- Password hashes, MFA secrets, session tokens, API keys and integration secrets
- IP addresses and device user agents
- Free-text performance comments, interview notes and disciplinary text
- Per-person pay appears only in F02 (Restricted) and aggregates only in the Sensitive finance reports, each behind `reports.view.sensitive`

## Platform-held data shown to a company

Some operational facts live in tables that only the platform (not a company) may read directly. A company sees its own rows through narrow SECURITY DEFINER functions that return nothing but the current company's data and never secrets (migrations 0165 and 0166):

| Function | Used by | What it exposes |
|---|---|---|
| `app.report_company_accounts()` | I01, I04, J01, J06, J07 | Account status, MFA state, last sign-in, lock state (no email, no hash, no secret) |
| `app.report_company_sessions()` | I02, J05 | Session times and new-device flags (no IP, no user agent) |
| `app.report_company_configuration()` | J13 | Published tenant settings |
| `app.report_company_integrations()` | J13, N10 | Integration switches and status (no credentials) |
| `app.report_company_usage()` | N01 | Daily usage counters |
| `app.report_company_exports()` | N07, N11 | Data export jobs (no file contents) |
| `app.report_company_health()` | N10 | Health check results |

## Metric definitions that several reports share

- **Headcount**: employees whose joining date is on or before today (company time zone) and whose status is not terminated. Employees terminated without a termination date are left out of every dated figure and the report says so.
- **Attendance rate**: days attended divided by days attended plus days absent. Leave, holidays, rest days and unscheduled days are not expected attendance.
- **Approval turnaround**: from the moment a step is assigned to the moment it is decided; escalations count against the original approver.
- **Small groups**: in pay, rating and demographic reports a group with fewer than 5 people is withheld or combined, so no individual can be identified.
- **Company time**: every report runs in the company's own time zone, so "today" and month boundaries match what the user sees in the product.
