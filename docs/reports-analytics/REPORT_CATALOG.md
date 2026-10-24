# Report catalog

Generated from the code by `npm run docs:reports` (apps/api). Do not edit by hand.

**220 reports: 193 available, 27 blocked, 0 planned, 0 unavailable.**

*Available* means the report has a query, a metric definition and tests. *Blocked* means the data it needs is not captured in AiHxM; the reason is given, and BLOCKED_REPORTS_DEVELOPMENT_PLAN.md says what to build to unlock it. Nothing here is estimated or invented.

Access: every report needs `reports.view`, a data permission for its domain (see the domain table at the end) and, for Sensitive and Restricted reports, `reports.view.sensitive`. Export additionally needs `reports.export` (and `reports.export.sensitive` for Sensitive and Restricted reports).

## A. Executive and business overview

Headcount, movement and workforce health at a glance.

| ID | Report | Status | Sensitivity | Domain | Charts | Filters |
|---|---|---|---|---|---|---|
| A01 | Workforce Executive Snapshot | Available | Internal | Employees and organisation | kpi, donut, table | none |
| A02 | Headcount by Legal Entity | Blocked: The organisation model has no legal-entity unit type yet (units are function, division, business unit and department), so there is nothing to group by. | Internal | Employees and organisation | bar, table | dateRange |
| A03 | Headcount by Department | Available | Internal | Employees and organisation | bar, table | location, employmentType |
| A04 | Headcount by Location | Available | Internal | Employees and organisation | bar, table | department, employmentType |
| A05 | Headcount by Employment Type | Available | Internal | Employees and organisation | donut, table | department, location |
| A06 | Active vs Inactive Workforce | Available | Internal | Employees and organisation | donut, table | department, location |
| A07 | Monthly Headcount Trend | Available | Internal | Employees and organisation | line, table | dateRange, department, location, employmentType |
| A08 | Joiners vs Leavers Trend | Available | Internal | Employees and organisation | stackedBar, table | dateRange, department, location, employmentType |
| A09 | Workforce Growth Rate | Available | Internal | Employees and organisation | line, kpi, table | dateRange, department, location, employmentType |
| A10 | Workforce Distribution by Manager | Available | Internal | Employees and organisation | bar, kpi, table | department, location, employmentType |
| A11 | Workforce Demographics Summary | Available | Sensitive | Employees and organisation | donut, table | department, location, employmentType |
| A12 | Employee Lifecycle Funnel | Available | Internal | Employees and organisation | bar, kpi, table | dateRange, department, location, employmentType |
| A13 | HR Operations KPI Summary | Available | Internal | Organisation structure | kpi, table | none |
| A14 | Workforce Data Completeness | Available | Internal | Employees and organisation | bar, kpi, table | department, location, employmentType |
| A15 | Executive HR KPI Scorecard | Available | Internal | Employees and organisation | kpi, table | department, location, employmentType |

## B. Employee and organisation

Who works where, in which role, and how complete the records are.

| ID | Report | Status | Sensitivity | Domain | Charts | Filters |
|---|---|---|---|---|---|---|
| B01 | Employee Directory (authorized fields only) | Available | Internal | Employees and organisation | kpi, table | department, location, employmentType |
| B02 | Employee Master Data Changes | Available | Internal | Employees and organisation | kpi, table | dateRange, department, location, employmentType |
| B03 | Employee Profile Completeness | Available | Internal | Employees and organisation | kpi, table | department, location, employmentType |
| B04 | Employees by Department and Position | Available | Internal | Employees and organisation | bar, table | department, location, employmentType |
| B05 | Position Occupancy | Available | Internal | Organisation structure | bar, table | department |
| B06 | Vacant Positions | Available | Internal | Organisation structure | kpi, table | department |
| B07 | Organisation Hierarchy Summary | Available | Internal | Organisation structure | bar, table | none |
| B08 | Manager Span of Control | Available | Internal | Employees and organisation | bar, kpi, table | department, location, employmentType |
| B09 | Employees by Grade/Band | Available | Sensitive | Employees and organisation | bar, kpi, table | department, location, employmentType |
| B10 | Employees by Cost Centre | Available | Internal | Employees and organisation | bar, table | department, location, employmentType |
| B11 | Contract Expiry Watchlist | Available | Internal | Employees and organisation | kpi, table | dateRange, department, location, employmentType |
| B12 | Probation Completion Watchlist | Available | Internal | Employees and organisation | kpi, table | dateRange, department, location, employmentType |
| B13 | Employee Anniversary List | Available | Internal | Employees and organisation | kpi, table | dateRange, department, location, employmentType |
| B14 | Employee Document Expiry Watchlist | Available | Sensitive | Employees and organisation | kpi, table | dateRange, department, location, employmentType |
| B15 | Employee Data Duplicate/Quality Exceptions | Available | Sensitive | Employees and organisation | kpi, bar, table | department, location, employmentType |

## C. Recruitment and onboarding

Requisitions, candidates, offers and new-joiner progress.

| ID | Report | Status | Sensitivity | Domain | Charts | Filters |
|---|---|---|---|---|---|---|
| C01 | Requisition Status Summary | Available | Internal | Recruitment | donut, kpi, table | dateRange, department, location |
| C02 | Open Requisitions Ageing | Available | Internal | Recruitment | kpi, table | department, location |
| C03 | Recruitment Funnel | Available | Internal | Recruitment | bar, kpi, table | dateRange, department, location |
| C04 | Candidates by Source | Available | Internal | Recruitment | bar, table | dateRange, department, location |
| C05 | Candidate Stage Conversion | Available | Internal | Recruitment | bar, table | dateRange, department, location |
| C06 | Time to Fill | Available | Internal | Recruitment | kpi, table | dateRange, department, location |
| C07 | Time to Hire | Available | Internal | Recruitment | kpi, table | dateRange, department, location |
| C08 | Offer Acceptance Rate | Available | Internal | Recruitment | donut, kpi, table | dateRange, department, location |
| C09 | Offer Decline Reasons | Available | Internal | Recruitment | bar, table | dateRange, department, location |
| C10 | Requisition Approval Turnaround | Available | Internal | Recruitment | kpi, table | dateRange, department, location |
| C11 | Recruiter Workload | Available | Internal | Recruitment | bar, table | department, location |
| C12 | Hiring Manager Pipeline | Available | Internal | Recruitment | bar, table | department, location |
| C13 | Upcoming Joiners | Available | Internal | Recruitment | kpi, table | dateRange, department, location |
| C14 | Onboarding Task Completion | Available | Internal | Employees and organisation | bar, kpi, table | dateRange, department, location, employmentType |
| C15 | New-Hire Onboarding Experience/Checklist Status | Available | Internal | Employees and organisation | kpi, table | dateRange, department, location, employmentType |

## D. Attendance and time management

Presence, lateness, overtime and timesheets.

| ID | Report | Status | Sensitivity | Domain | Charts | Filters |
|---|---|---|---|---|---|---|
| D01 | Daily Attendance Summary | Available | Internal | Attendance and time | stackedBar, kpi, table | dateRange, department, location, employmentType |
| D02 | Monthly Attendance Summary | Available | Internal | Attendance and time | line, kpi, table | dateRange, department, location, employmentType |
| D03 | Late Arrival Analysis | Available | Internal | Attendance and time | bar, kpi, table | dateRange, department, location, employmentType |
| D04 | Early Departure Analysis | Available | Internal | Attendance and time | bar, kpi, table | dateRange, department, location, employmentType |
| D05 | Absence and No-Show Analysis | Available | Internal | Attendance and time | bar, kpi, table | dateRange, department, location, employmentType |
| D06 | Missing Punch Exceptions | Available | Internal | Attendance and time | kpi, table | dateRange, department, location, employmentType |
| D07 | Attendance Regularization Requests | Available | Internal | Attendance and time | donut, kpi, table | dateRange, department, location, employmentType |
| D08 | Overtime Hours Summary | Available | Internal | Attendance and time | bar, kpi, table | dateRange, department, location, employmentType |
| D09 | Overtime Cost Summary (requires authorized pay rates) | Available | Sensitive | Attendance and time | line, kpi, table | dateRange, department, location, employmentType |
| D10 | Shift Adherence | Available | Internal | Attendance and time | bar, table | dateRange, department, location, employmentType |
| D11 | Attendance by Department | Available | Internal | Attendance and time | bar, table | dateRange, department, location, employmentType |
| D12 | Attendance by Location | Available | Internal | Attendance and time | bar, table | dateRange, department, location, employmentType |
| D13 | Work Schedule Compliance | Available | Internal | Attendance and time | bar, table | dateRange, department, location, employmentType |
| D14 | Timesheet Submission Status | Available | Internal | Attendance and time | donut, kpi, table | dateRange, department, location, employmentType |
| D15 | Timesheet Approval Ageing | Available | Internal | Attendance and time | kpi, table | department, location, employmentType |

## E. Leave and absence

Balances, requests, approvals and absence patterns.

| ID | Report | Status | Sensitivity | Domain | Charts | Filters |
|---|---|---|---|---|---|---|
| E01 | Leave Balance Summary | Available | Internal | Leave | bar, kpi, table | department, location, employmentType, leaveType |
| E02 | Leave Taken by Type | Available | Internal | Leave | bar, table | dateRange, department, location, leaveType |
| E03 | Leave Requests by Status | Available | Internal | Leave | donut, table | dateRange, department, location, leaveType |
| E04 | Leave Approval Turnaround | Available | Internal | Leave | bar, kpi, table | dateRange, department, location, employmentType, leaveType |
| E05 | Upcoming Approved Leave | Available | Internal | Leave | kpi, table | dateRange, department, location, employmentType, leaveType |
| E06 | Unplanned Absence Trend | Available | Internal | Leave | stackedBar, table | dateRange, department, location, employmentType |
| E07 | Leave Liability/Accrual Estimate (only if rules/data support it) | Blocked: Needs a leave valuation rule (rate per day, accrual basis) that is not defined yet, so any figure would be a guess. | Sensitive | Leave | table | dateRange |
| E08 | Leave Carry-Forward Exceptions | Available | Internal | Leave | kpi, table | dateRange, department, location, employmentType |
| E09 | Leave Quota Utilization | Available | Internal | Leave | bar, table | department, location, employmentType, leaveType |
| E10 | Leave Balance Reconciliation | Available | Internal | Leave | kpi, table | department, location, employmentType |
| E11 | Leave Overlap/Conflict Exceptions | Available | Internal | Leave | kpi, table | dateRange, department, location, employmentType |
| E12 | Leave by Department | Available | Internal | Leave | bar, table | dateRange, department, location, employmentType, leaveType |
| E13 | Leave by Location | Available | Internal | Leave | bar, table | dateRange, department, location, employmentType, leaveType |
| E14 | Leave Calendar Utilization | Available | Internal | Leave | line, kpi, table | dateRange, department, location, employmentType |
| E15 | Leave Policy Compliance Exceptions | Available | Internal | Leave | kpi, table | dateRange, department, location, employmentType |

## F. Payroll and compensation

Payroll runs, registers, variances and exceptions.

| ID | Report | Status | Sensitivity | Domain | Charts | Filters |
|---|---|---|---|---|---|---|
| F01 | Payroll Run Status | Available | Internal | Payroll | kpi, bar, table | dateRange, runStatus |
| F02 | Payroll Register | Available | Restricted | Payroll | kpi, table | dateRange, department, location, runStatus |
| F03 | Payroll Variance Between Periods | Available | Sensitive | Payroll | line, table | dateRange |
| F04 | Earnings and Deductions Breakdown | Available | Sensitive | Payroll | bar, kpi, table | dateRange |
| F05 | Net Pay Summary | Available | Sensitive | Payroll | line, table | dateRange |
| F06 | Payroll Reconciliation | Available | Sensitive | Payroll | kpi, table | dateRange, runStatus |
| F07 | Payroll Cost by Department/Cost Centre | Available | Sensitive | Payroll | bar, kpi, table | dateRange |
| F08 | Overtime Pay Analysis | Available | Sensitive | Payroll | bar, table | dateRange, department, location |
| F09 | Tax Withholding Summary (only validated against current rules) | Blocked: Tax figures can be offered only after they are validated against the statutory rules in force for each period. That validation has not been done for reporting. | Restricted | Payroll | kpi, table | dateRange |
| F10 | Payroll Exceptions and Failed Calculations | Available | Internal | Payroll | bar, kpi, table | dateRange, runStatus |

## G. Performance and goals

Review cycles, goals, ratings and completion.

| ID | Report | Status | Sensitivity | Domain | Charts | Filters |
|---|---|---|---|---|---|---|
| G01 | Performance Review Cycle Status | Available | Internal | Performance | kpi, table | dateRange, department, location, employmentType |
| G02 | Review Completion Rate | Available | Internal | Performance | bar, kpi, table | dateRange, department, location, employmentType |
| G03 | Overdue Performance Reviews | Available | Internal | Performance | kpi, table | department, location, employmentType |
| G04 | Goal Completion Summary | Available | Internal | Performance | donut, kpi, table | dateRange, department, location, employmentType |
| G05 | Goal Progress by Department | Available | Internal | Performance | bar, table | dateRange, department, location, employmentType |
| G06 | Goal Progress by Employee (authorized scope) | Available | Sensitive | Performance | kpi, table | dateRange, department, location, employmentType |
| G07 | Rating Distribution | Available | Sensitive | Performance | bar, kpi, table | dateRange, department, location, employmentType |
| G08 | Rating Calibration Exceptions | Available | Sensitive | Performance | kpi, table | dateRange, department, location, employmentType |
| G09 | Manager Review Completion | Available | Internal | Performance | bar, table | dateRange, department, location, employmentType |
| G10 | Self-Assessment Completion | Available | Internal | Performance | bar, table | dateRange, department, location, employmentType |
| G11 | Peer Feedback Completion | Available | Internal | Performance | bar, kpi, table | dateRange, department, location, employmentType |
| G12 | Performance Improvement Plan Status (highly restricted) | Blocked: The product has no improvement-plan records. | Restricted | Performance | table | dateRange |
| G13 | Competency/Gaps Summary | Available | Sensitive | Performance | bar, table | dateRange, department, location, employmentType |
| G14 | Learning/Development Plan Progress | Available | Internal | Performance | bar, kpi, table | dateRange, department, location, employmentType |
| G15 | Performance Cycle Timeline/Turnaround | Available | Internal | Performance | table | dateRange, department, location, employmentType |

## H. Workflow and approvals

Pending work, turnaround and bottlenecks.

| ID | Report | Status | Sensitivity | Domain | Charts | Filters |
|---|---|---|---|---|---|---|
| H01 | Pending Approvals Inbox Summary | Available | Internal | Workflow | kpi, bar, table | none |
| H02 | Approval Ageing | Available | Internal | Workflow | bar, kpi, table | none |
| H03 | Approval Turnaround by Workflow | Available | Internal | Workflow | bar, kpi, table | dateRange |
| H04 | Workflow Completion Rate | Available | Internal | Workflow | bar, kpi, table | dateRange |
| H05 | Rejected Requests and Reasons | Available | Sensitive | Workflow | kpi, table | dateRange |
| H06 | Reassigned/Delegated Approvals | Available | Internal | Workflow | kpi, table | dateRange |
| H07 | SLA Breach Summary | Available | Internal | Workflow | bar, kpi, table | dateRange |
| H08 | Workflow Bottleneck Analysis | Available | Internal | Workflow | bar, table | dateRange |
| H09 | Approvals by Department | Available | Internal | Workflow | bar, table | dateRange, department |
| H10 | Approvals by Manager | Available | Internal | Workflow | bar, table | dateRange |
| H11 | Workflow Error/Failure Log (admin-restricted) | Available | Sensitive | Administration | kpi, table | dateRange |
| H12 | Escalation History | Available | Internal | Workflow | kpi, table | dateRange |
| H13 | Workflow Configuration Usage | Available | Internal | Workflow | bar, table | dateRange |
| H14 | Approval Load Distribution | Available | Internal | Workflow | bar, kpi, table | none |
| H15 | Requests Stuck in Intermediate State | Available | Internal | Workflow | kpi, table | none |

## I. ESS/MSS and employee service

Self-service adoption and service requests.

| ID | Report | Status | Sensitivity | Domain | Charts | Filters |
|---|---|---|---|---|---|---|
| I01 | ESS Adoption | Available | Internal | Administration | bar, kpi, table | department, location, employmentType |
| I02 | ESS Login/Usage Trend (only if tracked) | Available | Internal | Administration | line, kpi, table | dateRange, department, location, employmentType |
| I03 | Employee Self-Service Transaction Volume | Available | Internal | Administration | stackedBar, kpi, table | dateRange, department, location, employmentType |
| I04 | Manager Self-Service Adoption | Available | Internal | Administration | bar, table | dateRange, department, location, employmentType |
| I05 | Payslip Access Summary (metadata, not salary exposure) | Available | Internal | Payroll | line, kpi, table | dateRange |
| I06 | Leave Request Self-Service Usage | Available | Internal | Administration | stackedBar, kpi, table | dateRange, department, location, employmentType |
| I07 | Personal Data Change Requests | Blocked: Employees cannot raise personal data change requests as a separate record, so there is no source. | Internal | Administration | table | dateRange |
| I08 | Employee Service Request Status | Blocked: There is no employee service-request module in the product. | Internal | Administration | table | dateRange |
| I09 | Service Request Ageing | Blocked: There is no employee service-request module in the product. | Internal | Administration | table | dateRange |
| I10 | Employee Portal Data Completeness | Available | Internal | Administration | bar, kpi, table | department, location, employmentType |
| I11 | Mobile/PWA Usage Summary (only if tracked) | Blocked: Mobile and installed-app usage is not tracked. | Internal | Administration | kpi, table | dateRange |
| I12 | Notification Delivery Status | Available | Internal | Administration | donut, kpi, table | dateRange |
| I13 | Failed Notifications | Available | Internal | Administration | kpi, table | dateRange |
| I14 | Employee Task Completion | Available | Internal | Administration | bar, table | dateRange, department, location, employmentType |
| I15 | Employee Experience Pulse (only if survey data exists) | Blocked: The product has no survey data. | Internal | Administration | table | dateRange |

## J. Audit, compliance and security

Access, authentication and change evidence.

| ID | Report | Status | Sensitivity | Domain | Charts | Filters |
|---|---|---|---|---|---|---|
| J01 | User Access Review | Available | Sensitive | Administration | kpi, table | none |
| J02 | Role and Permission Assignment | Available | Sensitive | Administration | bar, kpi, table | none |
| J03 | Sensitive Report Access Audit | Available | Sensitive | Administration | kpi, table | dateRange |
| J04 | Export Audit Log | Available | Sensitive | Administration | kpi, table | dateRange |
| J05 | Login and Authentication Events | Available | Sensitive | Administration | bar, kpi, table | dateRange |
| J06 | MFA Enrollment/Status (metadata only) | Available | Sensitive | Administration | bar, kpi, table | none |
| J07 | Failed Authentication Summary | Available | Sensitive | Administration | kpi, table | dateRange |
| J08 | Privileged Access Changes | Available | Sensitive | Administration | kpi, table | dateRange |
| J09 | Employee Master Change Audit | Available | Sensitive | Administration | bar, table | dateRange |
| J10 | Payroll Change Audit | Available | Restricted | Payroll | kpi, table | dateRange |
| J11 | Workflow Configuration Change Audit | Available | Sensitive | Administration | kpi, table | dateRange |
| J12 | Data Retention/Deletion Activity | Available | Sensitive | Administration | donut, kpi, table | dateRange |
| J13 | Tenant Security Configuration Review | Available | Sensitive | Administration | kpi, table | none |
| J14 | Segregation-of-Duties Exceptions (if rules are configured) | Blocked: No segregation-of-duties rules are configured or modelled. | Sensitive | Administration | table | dateRange |
| J15 | Compliance Evidence Register | Blocked: There is no compliance evidence register to report from. | Sensitive | Administration | table | dateRange |

## K. Finance and cost analytics

People cost by department, cost centre and period.

| ID | Report | Status | Sensitivity | Domain | Charts | Filters |
|---|---|---|---|---|---|---|
| K01 | Payroll Cost Trend | Available | Sensitive | Payroll | line, kpi, table | dateRange |
| K02 | Personnel Cost by Department | Available | Sensitive | Payroll | bar, kpi, table | dateRange, department, location |
| K03 | Personnel Cost by Cost Centre | Available | Sensitive | Payroll | bar, kpi, table | dateRange, department, location |
| K04 | Personnel Cost by Location | Available | Sensitive | Payroll | bar, kpi, table | dateRange, department, location |
| K05 | Personnel Cost per Employee (authorized aggregates) | Available | Sensitive | Payroll | bar, table | dateRange, department, location |
| K06 | Budget vs Actual People Cost (requires budget source) | Blocked: Budgets exist per position only. There is no people-cost budget by cost centre and period to compare payroll against. | Sensitive | Payroll | table | dateRange |
| K07 | Overtime Cost Trend | Available | Sensitive | Payroll | line, table | dateRange |
| K08 | Employer Contribution Summary (if configured) | Available | Sensitive | Payroll | bar, kpi, table | dateRange |
| K09 | Allowance and Benefit Cost | Available | Sensitive | Payroll | bar, kpi, table | dateRange |
| K10 | Deduction Summary | Available | Sensitive | Payroll | bar, kpi, table | dateRange |
| K11 | Payroll Cost Variance Drivers | Available | Sensitive | Payroll | bar, table | dateRange |
| K12 | Headcount vs Personnel Cost | Available | Sensitive | Payroll | line, table | dateRange |
| K13 | Cost Allocation Exceptions | Available | Internal | Payroll | kpi, table | department, location |
| K14 | Payroll Posting/Journal Status (if implemented) | Available | Sensitive | Payroll | kpi, table | dateRange, runStatus |
| K15 | Finance Reconciliation Exceptions | Available | Sensitive | Payroll | kpi, table | dateRange |

## L. Learning, skills and talent

Training, skills, certifications and succession.

| ID | Report | Status | Sensitivity | Domain | Charts | Filters |
|---|---|---|---|---|---|---|
| L01 | Training Enrollment Summary | Available | Internal | Learning | bar, kpi, table | dateRange, department, location, employmentType |
| L02 | Training Completion Rate | Available | Internal | Learning | bar, kpi, table | dateRange, department, location, employmentType |
| L03 | Mandatory Training Compliance | Available | Internal | Learning | bar, kpi, table | department, location, employmentType |
| L04 | Training Overdue List | Available | Internal | Learning | kpi, table | department, location, employmentType |
| L05 | Training Hours by Department | Available | Internal | Learning | bar, kpi, table | dateRange, department, location, employmentType |
| L06 | Training Cost Summary | Available | Internal | Learning | bar, kpi, table | dateRange, department, location, employmentType |
| L07 | Skills Inventory | Blocked: Employee skills are not captured. Qualifications and a competency list exist, skills do not. | Internal | Learning | table | dateRange |
| L08 | Skills Gap Analysis | Blocked: Employee skills and required skills per role are not captured. | Internal | Learning | table | dateRange |
| L09 | Certification Expiry Watchlist | Available | Internal | Learning | kpi, table | dateRange, department, location, employmentType |
| L10 | Learning Plan Progress | Available | Internal | Learning | kpi, table | dateRange, department, location, employmentType |
| L11 | Succession Coverage (restricted, if configured) | Blocked: Succession planning has a module licence but no succession data tables exist. | Restricted | Learning | table | dateRange |
| L12 | Critical Role Coverage (if configured) | Blocked: Positions carry no critical-role flag and no succession data exists. | Restricted | Learning | table | dateRange |
| L13 | Internal Mobility Summary | Available | Internal | Employees and organisation | bar, kpi, table | dateRange, department, location, employmentType |
| L14 | Talent Pool Status | Blocked: There are no talent pool records. | Restricted | Learning | table | dateRange |
| L15 | Development Plan Exceptions | Available | Internal | Learning | kpi, table | department, location, employmentType |

## M. Organisation planning and workforce analytics

Capacity, vacancies, tenure and movement.

| ID | Report | Status | Sensitivity | Domain | Charts | Filters |
|---|---|---|---|---|---|---|
| M01 | Headcount Plan vs Actual (requires planning data) | Blocked: No planned headcount by period is stored. Positions carry FTE and budgets but no plan to compare against. | Internal | Employees and organisation | table | dateRange |
| M02 | Workforce Capacity by Department | Available | Internal | Employees and organisation | bar, kpi, table | department, location, employmentType |
| M03 | FTE Summary (requires reliable working-hours data) | Available | Internal | Employees and organisation | bar, kpi, table | department, location, employmentType |
| M04 | Vacancy Rate | Available | Internal | Organisation structure | bar, kpi, table | department |
| M05 | Internal vs External Hiring | Blocked: Hires and candidates are not marked as internal or external. | Internal | Employees and organisation | table | dateRange |
| M06 | Workforce Movement Matrix | Available | Internal | Employees and organisation | bar, table | dateRange, department, location, employmentType |
| M07 | Tenure Distribution | Available | Internal | Employees and organisation | bar, kpi, table | department, location, employmentType |
| M08 | Retirement/Contract End Forecast (only where lawful and data-supported) | Available | Sensitive | Employees and organisation | bar, table | dateRange, department, location, employmentType |
| M09 | Critical Position Vacancy Watchlist | Blocked: Positions carry no critical flag, so critical vacancies cannot be picked out. | Internal | Employees and organisation | table | dateRange |
| M10 | Manager Span/Layer Analysis | Available | Internal | Organisation structure | bar, kpi, table | none |
| M11 | Organisation Change Impact | Available | Internal | Organisation structure | kpi, table | dateRange |
| M12 | Location Distribution and Capacity | Available | Internal | Employees and organisation | bar, kpi, table | department, location, employmentType |
| M13 | Employee Type Mix Trend | Available | Internal | Employees and organisation | stackedBar, table | dateRange, department, location |
| M14 | Workforce Data Quality Trend | Available | Internal | Organisation structure | line, kpi, table | dateRange |
| M15 | Scenario Comparison (only with explicit assumptions and source data) | Blocked: No scenario or assumption model exists to compare. | Internal | Employees and organisation | table | dateRange |

## N. Platform operations and tenant administration

Jobs, exports, integrations and configuration health.

| ID | Report | Status | Sensitivity | Domain | Charts | Filters |
|---|---|---|---|---|---|---|
| N01 | Tenant Usage Summary | Available | Internal | Administration | line, kpi, table | dateRange |
| N02 | Active Users by Tenant (platform metadata only) | Blocked: Platform-operator view. It reports across companies, so it belongs in the Platform Admin console and is never shown to a company's own users. | Internal | Platform operations | bar, table | dateRange |
| N03 | Module Adoption by Tenant | Blocked: Platform-operator view. It reports across companies, so it belongs in the Platform Admin console and is never shown to a company's own users. | Internal | Platform operations | bar, table | dateRange |
| N04 | API Error/Latency Summary | Blocked: API errors and latency are not stored; they live in the hosting provider's logs. | Internal | Platform operations | kpi, table | dateRange |
| N05 | Background Job Status | Available | Internal | Administration | bar, kpi, table | dateRange |
| N06 | Scheduled Report Job Status | Available | Internal | Administration | kpi, table | none |
| N07 | Export Job Status | Available | Internal | Administration | donut, kpi, table | dateRange |
| N08 | Storage Usage (if measured) | Available | Internal | Administration | donut, kpi, table | none |
| N09 | Notification Queue Health | Available | Internal | Administration | kpi, table | dateRange |
| N10 | Integration Health (if integrations exist) | Available | Internal | Administration | kpi, table | none |
| N11 | Failed Import/Export Jobs | Available | Internal | Administration | kpi, table | dateRange |
| N12 | Tenant Configuration Completeness | Available | Internal | Administration | kpi, table | none |
| N13 | Feature Entitlement Usage | Blocked: Platform-operator view. It reports across companies, so it belongs in the Platform Admin console and is never shown to a company's own users. | Internal | Platform operations | table | dateRange |
| N14 | Platform Audit Events | Blocked: Platform-operator view. It reports across companies, so it belongs in the Platform Admin console and is never shown to a company's own users. | Internal | Platform operations | table | dateRange |
| N15 | System Availability/Incident Summary (if monitoring exists) | Blocked: No uptime or incident data is stored in the product. | Internal | Platform operations | kpi, table | dateRange |

## O. Report builder, data quality and governance

How reports are used, and how reliable the data behind them is.

| ID | Report | Status | Sensitivity | Domain | Charts | Filters |
|---|---|---|---|---|---|---|
| O01 | Report Catalog Usage | Available | Internal | Administration | bar, kpi, table | dateRange |
| O02 | Most Viewed Reports | Available | Internal | Administration | bar, table | dateRange |
| O03 | Unused/Low-Usage Reports | Available | Internal | Administration | kpi, table | dateRange |
| O04 | Report Execution Duration | Available | Internal | Administration | bar, table | dateRange |
| O05 | Query/Report Failure Rate | Available | Internal | Administration | bar, kpi, table | dateRange |
| O06 | Saved Report Inventory | Available | Internal | Administration | kpi, table | none |
| O07 | Shared Report Inventory | Available | Internal | Administration | kpi, table | none |
| O08 | Scheduled Report Inventory | Available | Internal | Administration | kpi, table | none |
| O09 | Schedule Delivery Success Rate | Available | Internal | Administration | bar, kpi, table | dateRange |
| O10 | Export Volume and Format Mix | Available | Internal | Administration | line, kpi, table | dateRange |
| O11 | Report Access Denials | Available | Internal | Administration | kpi, table | dateRange |
| O12 | Data Source/Field Availability | Available | Internal | Administration | donut, kpi, table | none |
| O13 | Custom Report Field Usage | Available | Internal | Administration | bar, table | none |
| O14 | Dashboard Widget Usage | Available | Internal | Administration | bar, table | none |
| O15 | Analytics Governance Exceptions | Available | Internal | Administration | kpi, table | dateRange |

## Domains and the permissions that open them

| Domain | Licence needed | Whole company | Direct reports only |
|---|---|---|---|
| Employees and organisation | employee | employee.view.all | employee.view.team |
| Organisation structure | employee | employee.view.all | none |
| Recruitment | recruitment | recruitment.manage.all | none |
| Attendance and time | leave | leave_request.view.all | leave_request.view.team |
| Leave | leave | leave_request.view.all | leave_request.view.team |
| Payroll | payroll | payroll.calculate.all, payroll.finalize.all, payroll.disburse.all, payroll.calculate.scoped, payroll.finalize.scoped, payroll.disburse.scoped | none |
| Performance | performance | performance_review.view.all | performance_review.view.team |
| Workflow | none (core) | workflow_template.manage.all | none |
| Learning | learning | employee.manage.all | none |
| Administration | none (core) | employee.manage.all | none |
| Platform operations | none (core) | none | none |
