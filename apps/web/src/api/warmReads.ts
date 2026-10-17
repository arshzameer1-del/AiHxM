/**
 * The reads each kind of login's screens make, recorded by opening every screen of the app once per role
 * (a temporary crawl). They are what the app loads in the background after sign-in. Screens that are not
 * listed here still work and are learned the first time they are opened (see `noteRouteRead` in client.ts).
 */
export const WARM_READS_BY_ROLE: Record<string, string[]> = {
  "hr_admin": [
    "/starter-setup",
    "/organization/command-center",
    "/employees",
    "/payroll/dashboard",
    "/payroll/runs",
    "/payroll/areas",
    "/employees/hiring/drafts",
    "/employees/analytics/summary",
    "/organization/structure",
    "/organization/cost-centers",
    "/organization/profit-centers",
    "/organization/jobs",
    "/organization/relationships",
    "/organization/positions",
    "/organization/units",
    "/organization/locations/tree",
    "/organization/reorganizations",
    "/organization/legacy-reconciliation",
    "/configuration-center",
    "/employee-groups",
    "/leave-policies",
    "/hr-administration/reference-catalog/types",
    "/hr-administration/reference-catalog/employment_type",
    "/leave-requests",
    "/attendance-corrections/pending",
    "/expense-claims",
    "/courses",
    "/job-requisitions",
    "/review-cycles",
    "/payroll/areas?includeInactive=true"
  ],
  "line_manager": [
    "/employees",
    "/employees/me/org-chart",
    "/leave-requests",
    "/attendance-corrections/pending",
    "/expense-claims",
    "/courses",
    "/job-requisitions/mine",
    "/interviews/mine",
    "/review-cycles"
  ],
  "employee_self_service": [
    "/payroll/dashboard",
    "/payroll/runs",
    "/payroll/areas",
    "/employees",
    "/employees/me/org-chart",
    "/expense-claims",
    "/courses",
    "/review-cycles",
    "/payslips",
    "/payroll/my-documents",
    "/holidays",
    "/leave-types"
  ],
  "system_admin": [
    "/starter-setup",
    "/configuration-center",
    "/workflow/templates",
    "/system-admin/roles",
    "/system-admin/assignable-users",
    "/expense-claims",
    "/employees",
    "/courses",
    "/review-cycles"
  ]
};
