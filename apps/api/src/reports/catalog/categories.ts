import type { CategoryDefinition, DomainPolicy, ReportDomain } from "./report-catalog.types";

export const CATEGORIES: readonly CategoryDefinition[] = [
  { key: "A", label: "Executive and business overview", blurb: "Headcount, movement and workforce health at a glance." },
  { key: "B", label: "Employee and organisation", blurb: "Who works where, in which role, and how complete the records are." },
  { key: "C", label: "Recruitment and onboarding", blurb: "Requisitions, candidates, offers and new-joiner progress." },
  { key: "D", label: "Attendance and time management", blurb: "Presence, lateness, overtime and timesheets." },
  { key: "E", label: "Leave and absence", blurb: "Balances, requests, approvals and absence patterns." },
  { key: "F", label: "Payroll and compensation", blurb: "Payroll runs, registers, variances and exceptions." },
  { key: "G", label: "Performance and goals", blurb: "Review cycles, goals, ratings and completion." },
  { key: "H", label: "Workflow and approvals", blurb: "Pending work, turnaround and bottlenecks." },
  { key: "I", label: "ESS/MSS and employee service", blurb: "Self-service adoption and service requests." },
  { key: "J", label: "Audit, compliance and security", blurb: "Access, authentication and change evidence." },
  { key: "K", label: "Finance and cost analytics", blurb: "People cost by department, cost centre and period." },
  { key: "L", label: "Learning, skills and talent", blurb: "Training, skills, certifications and succession." },
  { key: "M", label: "Organisation planning and workforce analytics", blurb: "Capacity, vacancies, tenure and movement." },
  { key: "N", label: "Platform operations and tenant administration", blurb: "Jobs, exports, integrations and configuration health." },
  { key: "O", label: "Report builder, data quality and governance", blurb: "How reports are used, and how reliable the data behind them is." },
];

/**
 * Domain -> permission map. `team` permissions only ever give direct reports (the product's existing `.team` meaning).
 * Attendance has no permission of its own yet, so it borrows the leave request keys; that is an interim mapping and is
 * called out in docs/reports-analytics/SECURITY_MODEL.md.
 */
export const DOMAIN_POLICIES: Record<ReportDomain, DomainPolicy> = {
  workforce: { label: "Employees and organisation", module: "employee", tenantPermissions: ["employee.view.all"], teamPermissions: ["employee.view.team"] },
  // Company-wide structure (positions, units, layers, restructures). There is no team view of the organisation as a whole.
  organization: { label: "Organisation structure", module: "employee", tenantPermissions: ["employee.view.all"], teamPermissions: [] },
  recruitment: { label: "Recruitment", module: "recruitment", tenantPermissions: ["recruitment.manage.all"], teamPermissions: [] },
  attendance: { label: "Attendance and time", module: "leave", tenantPermissions: ["leave_request.view.all"], teamPermissions: ["leave_request.view.team"] },
  leave: { label: "Leave", module: "leave", tenantPermissions: ["leave_request.view.all"], teamPermissions: ["leave_request.view.team"] },
  payroll: {
    label: "Payroll",
    module: "payroll",
    tenantPermissions: [
      "payroll.calculate.all",
      "payroll.finalize.all",
      "payroll.disburse.all",
      "payroll.calculate.scoped",
      "payroll.finalize.scoped",
      "payroll.disburse.scoped",
    ],
    teamPermissions: [],
  },
  performance: { label: "Performance", module: "performance", tenantPermissions: ["performance_review.view.all"], teamPermissions: ["performance_review.view.team"] },
  workflow: { label: "Workflow", module: null, tenantPermissions: ["workflow_template.manage.all"], teamPermissions: [] },
  learning: { label: "Learning", module: "learning", tenantPermissions: ["employee.manage.all"], teamPermissions: [] },
  governance: { label: "Administration", module: null, tenantPermissions: ["employee.manage.all"], teamPermissions: [] },
  // Platform-operator metadata. Tenant users never see these; they belong in the Platform Admin console.
  platform: { label: "Platform operations", module: null, tenantPermissions: [], teamPermissions: [] },
};

export const REPORTS_VIEW = "reports.view";
export const REPORTS_VIEW_SENSITIVE = "reports.view.sensitive";
export const REPORTS_EXPORT = "reports.export";
export const REPORTS_EXPORT_SENSITIVE = "reports.export.sensitive";
