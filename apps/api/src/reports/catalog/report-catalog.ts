import type { ReportCategoryKey, ReportFilterKey, ReportSensitivity, ReportStatus, ReportVisualization } from "@aihxm/shared-types";
import type { ReportDefinition, ReportDomain } from "./report-catalog.types";
import { REPORT_META } from "../engine/executors";

/**
 * The authoritative catalog: 220 stable ids (A01 to O15), each mapped to the tables it would read, the permission domain
 * that opens its data, a sensitivity class and an honest status.
 *
 *   available - has a query in report-executors.ts, is authorised, tested, and returns real data.
 *   planned   - the source tables exist; the report is not built yet.
 *   blocked   - the data the report needs is not captured by the product (the reason says exactly what is missing).
 *
 * Ids are permanent. Titles may be improved. report-catalog.spec.ts fails if an id is duplicated or missing, if a report
 * is "available" without an executor, or if an executor exists for a report that is not marked available.
 */
type Opts = {
  domain?: ReportDomain;
  sens?: ReportSensitivity;
  status?: ReportStatus;
  reason?: string;
  tables?: string[];
  filters?: ReportFilterKey[];
  viz?: ReportVisualization[];
  desc?: string;
  tags?: string[];
  needs?: string[];
};

type CategoryDefaults = { domain: ReportDomain; sens: ReportSensitivity; tables: string[] };

const DEFAULTS: Record<ReportCategoryKey, CategoryDefaults> = {
  A: { domain: "workforce", sens: "internal", tables: ["employees", "org_units", "locations"] },
  B: { domain: "workforce", sens: "internal", tables: ["employees", "org_units", "positions"] },
  C: { domain: "recruitment", sens: "internal", tables: ["job_requisitions", "candidates", "applications"] },
  D: { domain: "attendance", sens: "internal", tables: ["attendance_daily_results", "attendance_records", "employees"] },
  E: { domain: "leave", sens: "internal", tables: ["leave_requests", "leave_types", "employees"] },
  F: { domain: "payroll", sens: "sensitive", tables: ["payroll_runs", "payslips", "payroll_component_results"] },
  G: { domain: "performance", sens: "internal", tables: ["review_cycles", "performance_reviews", "goals"] },
  H: { domain: "workflow", sens: "internal", tables: ["workflow_instances", "workflow_step_instances", "workflow_step_approvals"] },
  I: { domain: "governance", sens: "internal", tables: ["user_accounts", "user_role_assignments"] },
  J: { domain: "governance", sens: "sensitive", tables: ["audit_log", "user_accounts", "user_role_assignments"] },
  K: { domain: "payroll", sens: "sensitive", tables: ["payroll_runs", "payslips", "employee_cost_allocations"] },
  L: { domain: "learning", sens: "internal", tables: ["courses", "course_enrollments", "employees"] },
  M: { domain: "workforce", sens: "internal", tables: ["employees", "positions", "employee_job_history"] },
  N: { domain: "governance", sens: "internal", tables: ["background_jobs", "tenant_data_exports"] },
  O: { domain: "governance", sens: "internal", tables: ["report_run_log", "report_favorites"] },
};

const PLANNED_REASON = "The source tables exist in AiHxM. The report's query, metric definition and tests are not built yet.";

function viewsFor(title: string): ReportVisualization[] {
  const t = title.toLowerCase();
  if (/trend|over time/.test(t)) return ["line", "table"];
  if (/funnel|conversion/.test(t)) return ["bar", "table"];
  if (/\bby\b|distribution|mix|breakdown/.test(t)) return ["bar", "table"];
  if (/summary|snapshot|scorecard|kpi|rate/.test(t)) return ["kpi", "table"];
  return ["table"];
}

const defs: ReportDefinition[] = [];
function cat(key: ReportCategoryKey, rows: Array<[string, string, Opts?]>) {
  const d = DEFAULTS[key];
  for (const [id, title, o = {}] of rows) {
    const status = o.status ?? "planned";
    defs.push({
      id,
      version: 1,
      title,
      description: o.desc ?? `${title}.`,
      categoryKey: key,
      domain: o.domain ?? d.domain,
      tags: o.tags ?? [],
      sourceTables: o.tables ?? d.tables,
      status,
      statusReason: status === "available" ? null : (o.reason ?? PLANNED_REASON),
      sensitivity: o.sens ?? d.sens,
      visualizations: o.viz ?? viewsFor(title),
      filters: o.filters ?? ["dateRange"],
      extraPermissions: o.needs ?? [],
      lifecycle: status === "available" ? "published" : "draft",
    });
  }
}

const blocked = (reason: string, o: Opts = {}): Opts => ({ ...o, status: "blocked", reason });

// ---------------------------------------------------------------- A. Executive and business overview
cat("A", [
  ["A01", "Workforce Executive Snapshot", { status: "available", filters: [], viz: ["kpi", "donut", "table"], desc: "Today's headcount, joiners and leavers in the last 30 days, and the split by employment type, in one view.", tags: ["headcount", "executive"] }],
  ["A02", "Headcount by Legal Entity", blocked("The organisation model has no legal-entity unit type yet (units are function, division, business unit and department), so there is nothing to group by.", { filters: ["dateRange"] })],
  ["A03", "Headcount by Department", { status: "available", filters: ["location", "employmentType"], viz: ["bar", "table"], desc: "Current headcount for each department or organisation unit.", tags: ["headcount", "department"] }],
  ["A04", "Headcount by Location", { status: "available", filters: ["department", "employmentType"], viz: ["bar", "table"], desc: "Current headcount for each work location.", tags: ["headcount", "location"] }],
  ["A05", "Headcount by Employment Type", { status: "available", filters: ["department", "location"], viz: ["donut", "table"], desc: "Current headcount split by employment type (permanent, contract, intern and so on).", tags: ["headcount", "employment type"] }],
  ["A06", "Active vs Inactive Workforce", { status: "available", filters: ["department", "location"], viz: ["donut", "table"], desc: "Employees who are working now compared with those who have left, by employment status.", tags: ["headcount", "status"] }],
  ["A07", "Monthly Headcount Trend", { status: "available", filters: ["dateRange", "department", "location", "employmentType"], viz: ["line", "table"], desc: "Headcount at the end of each month: everyone joined on or before that day and not yet gone.", tags: ["headcount", "trend"] }],
  ["A08", "Joiners vs Leavers Trend", { status: "available", filters: ["dateRange", "department", "location", "employmentType"], viz: ["stackedBar", "table"], desc: "People who joined and people who left, month by month.", tags: ["joiners", "leavers", "attrition", "trend"] }],
  ["A09", "Workforce Growth Rate"],
  ["A10", "Workforce Distribution by Manager", { tables: ["employees", "org_relationships"] }],
  ["A11", "Workforce Demographics Summary", { sens: "sensitive", reason: "Only lawful, approved fields may be reported. The approved field list and the field-security rules for it must be agreed first.", tables: ["employees", "persons"] }],
  ["A12", "Employee Lifecycle Funnel", { tables: ["employee_lifecycle_events", "employees"] }],
  ["A13", "HR Operations KPI Summary"],
  ["A14", "Workforce Data Completeness", { tables: ["employees", "persons", "employee_contacts"] }],
  ["A15", "Executive HR KPI Scorecard"],
]);

// ---------------------------------------------------------------- B. Employee and organisation
cat("B", [
  ["B01", "Employee Directory (authorized fields only)", { viz: ["table"] }],
  ["B02", "Employee Master Data Changes", { tables: ["employee_versions", "audit_log"] }],
  ["B03", "Employee Profile Completeness", { tables: ["employees", "persons", "employee_contacts", "employee_addresses"] }],
  ["B04", "Employees by Department and Position", { tables: ["employees", "org_units", "positions"] }],
  ["B05", "Position Occupancy", { tables: ["positions", "position_incumbents"] }],
  ["B06", "Vacant Positions", { tables: ["positions", "position_incumbents"] }],
  ["B07", "Organisation Hierarchy Summary", { tables: ["org_units"] }],
  ["B08", "Manager Span of Control", { tables: ["org_relationships", "employees"] }],
  ["B09", "Employees by Grade/Band", { sens: "sensitive", tables: ["employees", "hr_reference_catalog_items"] }],
  ["B10", "Employees by Cost Centre", { tables: ["employee_cost_allocations", "cost_centers"] }],
  ["B11", "Contract Expiry Watchlist", { tables: ["employments", "employees"] }],
  ["B12", "Probation Completion Watchlist", { tables: ["employee_important_dates", "employees"] }],
  ["B13", "Employee Anniversary List", { tables: ["employees"] }],
  ["B14", "Employee Document Expiry Watchlist", { tables: ["persons", "employee_qualifications"], reason: "Passport and qualification expiry dates exist. Documents in the vault carry no expiry date, so the report would cover those two only." }],
  ["B15", "Employee Data Duplicate/Quality Exceptions", { tables: ["employees", "persons"] }],
]);

// ---------------------------------------------------------------- C. Recruitment and onboarding
cat("C", [
  ["C01", "Requisition Status Summary", { tables: ["job_requisitions"] }],
  ["C02", "Open Requisitions Ageing", { tables: ["job_requisitions"] }],
  ["C03", "Recruitment Funnel", { tables: ["applications", "application_stage_history"] }],
  ["C04", "Candidates by Source", { tables: ["candidates", "applications"], reason: "Verify first that a source field is captured on candidates; the other tables exist." }],
  ["C05", "Candidate Stage Conversion", { tables: ["applications", "application_stage_history"] }],
  ["C06", "Time to Fill", { tables: ["job_requisitions", "offers"] }],
  ["C07", "Time to Hire", { tables: ["applications", "offers"] }],
  ["C08", "Offer Acceptance Rate", { tables: ["offers"] }],
  ["C09", "Offer Decline Reasons", { tables: ["offers"] }],
  ["C10", "Requisition Approval Turnaround", { tables: ["job_requisitions", "workflow_instances"] }],
  ["C11", "Recruiter Workload", { tables: ["applications", "interviews"] }],
  ["C12", "Hiring Manager Pipeline", { tables: ["job_requisitions", "applications"] }],
  ["C13", "Upcoming Joiners", { tables: ["hire_processes", "offers"] }],
  ["C14", "Onboarding Task Completion", { domain: "workforce", tables: ["employee_onboarding", "employee_onboarding_items"] }],
  ["C15", "New-Hire Onboarding Experience/Checklist Status", { domain: "workforce", tables: ["employee_onboarding", "employee_onboarding_items"] }],
]);

// ---------------------------------------------------------------- D. Attendance and time management
cat("D", [
  ["D01", "Daily Attendance Summary"],
  ["D02", "Monthly Attendance Summary"],
  ["D03", "Late Arrival Analysis"],
  ["D04", "Early Departure Analysis"],
  ["D05", "Absence and No-Show Analysis"],
  ["D06", "Missing Punch Exceptions", { tables: ["raw_punches", "attendance_daily_results"] }],
  ["D07", "Attendance Regularization Requests", { tables: ["attendance_correction_requests"] }],
  ["D08", "Overtime Hours Summary", { tables: ["overtime_records", "overtime_authorizations"] }],
  ["D09", "Overtime Cost Summary (requires authorized pay rates)", { sens: "sensitive", tables: ["overtime_records", "employee_compensation"] }],
  ["D10", "Shift Adherence", { tables: ["shift_assignments", "attendance_daily_results"] }],
  ["D11", "Attendance by Department"],
  ["D12", "Attendance by Location"],
  ["D13", "Work Schedule Compliance", { tables: ["work_schedule_assignment_rules", "attendance_daily_results"] }],
  ["D14", "Timesheet Submission Status", { tables: ["timesheets"] }],
  ["D15", "Timesheet Approval Ageing", { tables: ["timesheets", "workflow_instances"] }],
]);

// ---------------------------------------------------------------- E. Leave and absence
cat("E", [
  ["E01", "Leave Balance Summary", { tables: ["leave_balances", "leave_types"] }],
  ["E02", "Leave Taken by Type", { status: "available", filters: ["dateRange", "department", "location", "leaveType"], viz: ["bar", "table"], desc: "Approved leave days in the period, for each leave type, counted over the days that fall inside the period.", tags: ["leave", "absence"] }],
  ["E03", "Leave Requests by Status", { status: "available", filters: ["dateRange", "department", "location", "leaveType"], viz: ["donut", "table"], desc: "How many leave requests are pending, approved, rejected or cancelled, for requests that start in the period.", tags: ["leave", "requests"] }],
  ["E04", "Leave Approval Turnaround", { tables: ["leave_requests", "workflow_instances", "workflow_step_approvals"] }],
  ["E05", "Upcoming Approved Leave", { tables: ["leave_requests"] }],
  ["E06", "Unplanned Absence Trend", { tables: ["leave_requests", "attendance_daily_results"] }],
  ["E07", "Leave Liability/Accrual Estimate (only if rules/data support it)", blocked("Needs a leave valuation rule (rate per day, accrual basis) that is not defined yet, so any figure would be a guess.", { tables: ["leave_balances", "leave_ledger", "employee_compensation"], sens: "sensitive" })],
  ["E08", "Leave Carry-Forward Exceptions", { tables: ["leave_ledger", "leave_types"] }],
  ["E09", "Leave Quota Utilization", { tables: ["leave_balances", "leave_policy_entitlements"] }],
  ["E10", "Leave Balance Reconciliation", { tables: ["leave_balances", "leave_ledger"] }],
  ["E11", "Leave Overlap/Conflict Exceptions", { tables: ["leave_requests"] }],
  ["E12", "Leave by Department"],
  ["E13", "Leave by Location"],
  ["E14", "Leave Calendar Utilization", { tables: ["leave_requests", "holidays"] }],
  ["E15", "Leave Policy Compliance Exceptions", { tables: ["leave_requests", "leave_policies", "leave_types"] }],
]);

// ---------------------------------------------------------------- F. Payroll and compensation
cat("F", [
  ["F01", "Payroll Run Status", { status: "available", sens: "internal", filters: ["dateRange", "runStatus"], viz: ["kpi", "bar", "table"], desc: "How many payroll runs sit in each stage, and the run list with population and exception counts. No pay amounts are shown.", tags: ["payroll", "runs"] }],
  ["F02", "Payroll Register", { sens: "restricted" }],
  ["F03", "Payroll Variance Between Periods"],
  ["F04", "Earnings and Deductions Breakdown"],
  ["F05", "Net Pay Summary"],
  ["F06", "Payroll Reconciliation", { tables: ["payroll_reconciliations", "payroll_runs"] }],
  ["F07", "Payroll Cost by Department/Cost Centre", { tables: ["payroll_costing_results", "payroll_runs"] }],
  ["F08", "Overtime Pay Analysis", { tables: ["payroll_component_results", "overtime_records"] }],
  ["F09", "Tax Withholding Summary (only validated against current rules)", blocked("Tax figures can be offered only after they are validated against the statutory rules in force for each period. That validation has not been done for reporting.", { sens: "restricted", tables: ["payroll_component_results", "tax_profiles"] })],
  ["F10", "Payroll Exceptions and Failed Calculations", { tables: ["payroll_exceptions", "payroll_run_partitions"] }],
]);

// ---------------------------------------------------------------- G. Performance and goals
cat("G", [
  ["G01", "Performance Review Cycle Status", { tables: ["review_cycles", "review_cycle_phases", "performance_reviews"] }],
  ["G02", "Review Completion Rate", { tables: ["review_cycles", "performance_reviews"] }],
  ["G03", "Overdue Performance Reviews", { tables: ["performance_reviews", "review_cycle_phases"] }],
  ["G04", "Goal Completion Summary", { tables: ["goals", "goal_plans"] }],
  ["G05", "Goal Progress by Department", { tables: ["goals", "goal_updates", "employees"] }],
  ["G06", "Goal Progress by Employee (authorized scope)", { sens: "sensitive", tables: ["goals", "goal_updates", "employees"] }],
  ["G07", "Rating Distribution", { sens: "sensitive", tables: ["performance_reviews", "review_ratings"] }],
  ["G08", "Rating Calibration Exceptions", blocked("No calibration sessions or calibrated ratings are stored.", { sens: "sensitive" })],
  ["G09", "Manager Review Completion", { tables: ["performance_reviews"] }],
  ["G10", "Self-Assessment Completion", { tables: ["performance_reviews", "review_ratings"] }],
  ["G11", "Peer Feedback Completion", { tables: ["feedback_requests", "feedback"] }],
  ["G12", "Performance Improvement Plan Status (highly restricted)", blocked("The product has no improvement-plan records.", { sens: "restricted" })],
  ["G13", "Competency/Gaps Summary", { tables: ["review_ratings", "competencies"] }],
  ["G14", "Learning/Development Plan Progress", { tables: ["development_plans", "development_plan_items"] }],
  ["G15", "Performance Cycle Timeline/Turnaround", { tables: ["review_cycles", "review_cycle_phases"] }],
]);

// ---------------------------------------------------------------- H. Workflow and approvals
cat("H", [
  ["H01", "Pending Approvals Inbox Summary"],
  ["H02", "Approval Ageing"],
  ["H03", "Approval Turnaround by Workflow"],
  ["H04", "Workflow Completion Rate"],
  ["H05", "Rejected Requests and Reasons"],
  ["H06", "Reassigned/Delegated Approvals", { tables: ["delegations", "workflow_step_approvals"] }],
  ["H07", "SLA Breach Summary", { tables: ["workflow_template_steps", "workflow_step_instances"] }],
  ["H08", "Workflow Bottleneck Analysis"],
  ["H09", "Approvals by Department", { tables: ["workflow_step_approvals", "employees", "org_units"] }],
  ["H10", "Approvals by Manager"],
  ["H11", "Workflow Error/Failure Log (admin-restricted)", { domain: "governance", tables: ["background_jobs", "domain_events"] }],
  ["H12", "Escalation History", { tables: ["workflow_step_approvals"] }],
  ["H13", "Workflow Configuration Usage", { tables: ["workflow_templates", "workflow_instances"] }],
  ["H14", "Approval Load Distribution"],
  ["H15", "Requests Stuck in Intermediate State"],
]);

// ---------------------------------------------------------------- I. ESS/MSS and employee service
cat("I", [
  ["I01", "ESS Adoption", { tables: ["user_accounts", "employees"] }],
  ["I02", "ESS Login/Usage Trend (only if tracked)", { tables: ["user_accounts", "user_sessions"] }],
  ["I03", "Employee Self-Service Transaction Volume", { tables: ["leave_requests", "attendance_correction_requests", "expense_claims"] }],
  ["I04", "Manager Self-Service Adoption", { tables: ["user_accounts", "workflow_step_approvals"] }],
  ["I05", "Payslip Access Summary (metadata, not salary exposure)", blocked("Payslip views and downloads are not recorded anywhere, so there is nothing to count.")],
  ["I06", "Leave Request Self-Service Usage", { tables: ["leave_requests"] }],
  ["I07", "Personal Data Change Requests", blocked("Employees cannot raise personal data change requests as a separate record, so there is no source.")],
  ["I08", "Employee Service Request Status", blocked("There is no employee service-request module in the product.")],
  ["I09", "Service Request Ageing", blocked("There is no employee service-request module in the product.")],
  ["I10", "Employee Portal Data Completeness", { tables: ["employees", "persons", "employee_contacts"] }],
  ["I11", "Mobile/PWA Usage Summary (only if tracked)", blocked("Mobile and installed-app usage is not tracked.")],
  ["I12", "Notification Delivery Status", { tables: ["notification_log"] }],
  ["I13", "Failed Notifications", { tables: ["notification_log"] }],
  ["I14", "Employee Task Completion", { tables: ["employee_onboarding_items", "employee_offboarding_items"] }],
  ["I15", "Employee Experience Pulse (only if survey data exists)", blocked("The product has no survey data.")],
]);

// ---------------------------------------------------------------- J. Audit, compliance and security
cat("J", [
  ["J01", "User Access Review", { tables: ["user_accounts", "user_role_assignments", "roles"] }],
  ["J02", "Role and Permission Assignment", { tables: ["user_role_assignments", "role_permissions", "roles"] }],
  ["J03", "Sensitive Report Access Audit", { tables: ["audit_log"], reason: "Sensitive report opens and exports are already written to the audit log by this module. The report over them is not built yet." }],
  ["J04", "Export Audit Log", { tables: ["audit_log"], reason: "Report exports are already written to the audit log by this module. The report over them is not built yet." }],
  ["J05", "Login and Authentication Events", { tables: ["audit_log", "user_sessions"] }],
  ["J06", "MFA Enrollment/Status (metadata only)", { tables: ["user_accounts"] }],
  ["J07", "Failed Authentication Summary", { tables: ["user_accounts", "audit_log"] }],
  ["J08", "Privileged Access Changes", { tables: ["audit_log", "user_role_assignments"] }],
  ["J09", "Employee Master Change Audit", { tables: ["audit_log", "employee_versions"] }],
  ["J10", "Payroll Change Audit", { sens: "restricted", tables: ["audit_log", "payroll_overrides", "payroll_run_events"] }],
  ["J11", "Workflow Configuration Change Audit", { tables: ["audit_log", "workflow_template_versions"] }],
  ["J12", "Data Retention/Deletion Activity", { tables: ["data_subject_requests", "audit_log"] }],
  ["J13", "Tenant Security Configuration Review", { tables: ["tenant_configuration", "company_config"] }],
  ["J14", "Segregation-of-Duties Exceptions (if rules are configured)", blocked("No segregation-of-duties rules are configured or modelled.")],
  ["J15", "Compliance Evidence Register", blocked("There is no compliance evidence register to report from.")],
]);

// ---------------------------------------------------------------- K. Finance and cost analytics
cat("K", [
  ["K01", "Payroll Cost Trend"],
  ["K02", "Personnel Cost by Department"],
  ["K03", "Personnel Cost by Cost Centre"],
  ["K04", "Personnel Cost by Location"],
  ["K05", "Personnel Cost per Employee (authorized aggregates)"],
  ["K06", "Budget vs Actual People Cost (requires budget source)", blocked("Budgets exist per position only. There is no people-cost budget by cost centre and period to compare payroll against.", { tables: ["position_budgets", "payroll_costing_results"] })],
  ["K07", "Overtime Cost Trend", { tables: ["payroll_component_results", "overtime_records"] }],
  ["K08", "Employer Contribution Summary (if configured)", { tables: ["payroll_component_results", "payslips"] }],
  ["K09", "Allowance and Benefit Cost", { tables: ["payroll_component_results", "benefit_enrolments"] }],
  ["K10", "Deduction Summary", { tables: ["payroll_component_results"] }],
  ["K11", "Payroll Cost Variance Drivers"],
  ["K12", "Headcount vs Personnel Cost", { tables: ["payroll_runs", "employees"] }],
  ["K13", "Cost Allocation Exceptions", { tables: ["employee_cost_allocations", "cost_centers"] }],
  ["K14", "Payroll Posting/Journal Status (if implemented)", { tables: ["payroll_journals", "payroll_journal_lines"] }],
  ["K15", "Finance Reconciliation Exceptions", { tables: ["payroll_reconciliations", "payroll_journals"] }],
]);

// ---------------------------------------------------------------- L. Learning, skills and talent
cat("L", [
  ["L01", "Training Enrollment Summary"],
  ["L02", "Training Completion Rate"],
  ["L03", "Mandatory Training Compliance", blocked("Courses carry no mandatory flag, so required training cannot be told apart from optional.")],
  ["L04", "Training Overdue List"],
  ["L05", "Training Hours by Department", { tables: ["course_enrollments", "courses", "employees"] }],
  ["L06", "Training Cost Summary", blocked("Course cost is not stored (courses hold title, category and duration only).")],
  ["L07", "Skills Inventory", blocked("Employee skills are not captured. Qualifications and a competency list exist, skills do not.")],
  ["L08", "Skills Gap Analysis", blocked("Employee skills and required skills per role are not captured.")],
  ["L09", "Certification Expiry Watchlist", { tables: ["employee_qualifications"] }],
  ["L10", "Learning Plan Progress", { tables: ["development_plans", "development_plan_items"] }],
  ["L11", "Succession Coverage (restricted, if configured)", blocked("Succession planning has a module licence but no succession data tables exist.", { sens: "restricted" })],
  ["L12", "Critical Role Coverage (if configured)", blocked("Positions carry no critical-role flag and no succession data exists.", { sens: "restricted" })],
  ["L13", "Internal Mobility Summary", { domain: "workforce", tables: ["employee_job_history", "employees"] }],
  ["L14", "Talent Pool Status", blocked("There are no talent pool records.", { sens: "restricted" })],
  ["L15", "Development Plan Exceptions", { tables: ["development_plans", "development_plan_items"] }],
]);

// ---------------------------------------------------------------- M. Organisation planning and workforce analytics
cat("M", [
  ["M01", "Headcount Plan vs Actual (requires planning data)", blocked("No planned headcount by period is stored. Positions carry FTE and budgets but no plan to compare against.", { tables: ["positions", "position_budgets", "employees"] })],
  ["M02", "Workforce Capacity by Department", { tables: ["employees", "work_schedule_assignment_rules"] }],
  ["M03", "FTE Summary (requires reliable working-hours data)", { tables: ["employees", "employee_work_profiles", "positions"] }],
  ["M04", "Vacancy Rate", { tables: ["positions", "position_incumbents"] }],
  ["M05", "Internal vs External Hiring", blocked("Hires and candidates are not marked as internal or external.")],
  ["M06", "Workforce Movement Matrix", { tables: ["employee_job_history"] }],
  ["M07", "Tenure Distribution"],
  ["M08", "Retirement/Contract End Forecast (only where lawful and data-supported)", { sens: "sensitive", tables: ["employees", "employments"] }],
  ["M09", "Critical Position Vacancy Watchlist", blocked("Positions carry no critical flag, so critical vacancies cannot be picked out.", { tables: ["positions", "position_incumbents"] })],
  ["M10", "Manager Span/Layer Analysis", { tables: ["org_relationships", "employees"] }],
  ["M11", "Organisation Change Impact", { tables: ["org_changes", "org_change_items"] }],
  ["M12", "Location Distribution and Capacity", { tables: ["employees", "locations"] }],
  ["M13", "Employee Type Mix Trend"],
  ["M14", "Workforce Data Quality Trend", blocked("Quality is not measured over time yet. This needs A14 first, with dated snapshots of its results.")],
  ["M15", "Scenario Comparison (only with explicit assumptions and source data)", blocked("No scenario or assumption model exists to compare.")],
]);

// ---------------------------------------------------------------- N. Platform operations and tenant administration
const PLATFORM = "Platform-operator view. It reports across companies, so it belongs in the Platform Admin console and is never shown to a company's own users.";
cat("N", [
  ["N01", "Tenant Usage Summary", { tables: ["tenant_daily_usage_counter"] }],
  ["N02", "Active Users by Tenant (platform metadata only)", blocked(PLATFORM, { domain: "platform" })],
  ["N03", "Module Adoption by Tenant", blocked(PLATFORM, { domain: "platform" })],
  ["N04", "API Error/Latency Summary", blocked("API errors and latency are not stored; they live in the hosting provider's logs.", { domain: "platform" })],
  ["N05", "Background Job Status", { tables: ["background_jobs"] }],
  ["N06", "Scheduled Report Job Status", blocked("Report scheduling is not built yet, so there are no scheduled report jobs.")],
  ["N07", "Export Job Status", { tables: ["tenant_data_exports", "background_jobs"] }],
  ["N08", "Storage Usage (if measured)", { tables: ["tenant_daily_usage_counter"] }],
  ["N09", "Notification Queue Health", { tables: ["notification_log"] }],
  ["N10", "Integration Health (if integrations exist)", { tables: ["tenant_integrations", "tenant_health_check_log"] }],
  ["N11", "Failed Import/Export Jobs", { tables: ["import_batches", "tenant_data_exports"] }],
  ["N12", "Tenant Configuration Completeness", { tables: ["tenant_configuration", "company_config"] }],
  ["N13", "Feature Entitlement Usage", blocked(PLATFORM, { domain: "platform" })],
  ["N14", "Platform Audit Events", blocked(PLATFORM, { domain: "platform" })],
  ["N15", "System Availability/Incident Summary (if monitoring exists)", blocked("No uptime or incident data is stored in the product.", { domain: "platform" })],
]);

// ---------------------------------------------------------------- O. Report builder, data quality and analytics governance
const NEEDS_USAGE = "This module records report runs in report_run_log, but the report over it is not built yet.";
cat("O", [
  ["O01", "Report Catalog Usage", { reason: NEEDS_USAGE }],
  ["O02", "Most Viewed Reports", { tables: ["report_recent_views", "report_run_log"], reason: NEEDS_USAGE }],
  ["O03", "Unused/Low-Usage Reports", { reason: NEEDS_USAGE }],
  ["O04", "Report Execution Duration", { reason: NEEDS_USAGE }],
  ["O05", "Query/Report Failure Rate", { reason: NEEDS_USAGE }],
  ["O06", "Saved Report Inventory", blocked("Saved reports are not built yet, so there is nothing to inventory.")],
  ["O07", "Shared Report Inventory", blocked("Sharing is not built yet, so there is nothing to inventory.")],
  ["O08", "Scheduled Report Inventory", blocked("Scheduling is not built yet, so there is nothing to inventory.")],
  ["O09", "Schedule Delivery Success Rate", blocked("Scheduling is not built yet, so there are no deliveries.")],
  ["O10", "Export Volume and Format Mix", { tables: ["report_run_log", "audit_log"], reason: NEEDS_USAGE }],
  ["O11", "Report Access Denials", { reason: NEEDS_USAGE }],
  ["O12", "Data Source/Field Availability", { tables: ["report_run_log"], reason: "Derived from this catalog's own source mapping. The report over it is not built yet." }],
  ["O13", "Custom Report Field Usage", blocked("The report builder is not built yet, so there are no custom reports.")],
  ["O14", "Dashboard Widget Usage", blocked("The dashboard builder is not built yet, so there are no widgets.")],
  ["O15", "Analytics Governance Exceptions", { reason: "Needs the usage and access-denial reports first." }],
]);

/**
 * A report that has a declarative query takes everything about how it behaves from that query's own metadata. This is
 * what makes "available" mean "has a tested query behind it": a report cannot be listed as available without one, and a
 * query cannot exist for a report the catalog still shows as planned.
 */
const finalDefs: ReportDefinition[] = defs.map((d) => {
  const m = REPORT_META[d.id];
  if (!m) return d;
  return {
    ...d,
    status: "available",
    statusReason: null,
    description: m.description,
    filters: m.filters,
    visualizations: m.viz,
    tags: m.tags.length > 0 ? m.tags : d.tags,
    lifecycle: "published",
    domain: m.domain ?? d.domain,
    sensitivity: m.sensitivity ?? d.sensitivity,
    extraPermissions: m.needs ?? d.extraPermissions,
    sourceTables: m.tables ?? d.sourceTables,
  };
});

export const REPORT_CATALOG: readonly ReportDefinition[] = Object.freeze(finalDefs);
export const REPORT_BY_ID: ReadonlyMap<string, ReportDefinition> = new Map(finalDefs.map((d) => [d.id, d]));
export const REPORT_ID_PATTERN = /^[A-O](0[1-9]|1[0-5])$/;
