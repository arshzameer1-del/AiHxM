import type { BuilderFieldType, ReportSensitivity } from "@aihxm/shared-types";
import type { ReportDomain } from "../catalog/report-catalog.types";

/**
 * The Report Builder never sees a table or column name from a user. Everything it can touch is listed here: a dataset is a
 * fixed FROM clause plus a map of fields, each a fixed SQL expression. A saved definition refers to datasets and fields by
 * key only; a key that is not in this file is an error, never a guess. Free-text fields (reasons, comments, assessments),
 * contact details, ID numbers and bank details are deliberately absent.
 */
export type FieldDef = {
  key: string;
  label: string;
  type: BuilderFieldType;
  /** Fixed SQL for the value. Never built from user input. CURRENT_DATE is the company's date (the session time zone is set per run). */
  expr: string;
  groupable?: boolean;
  measure?: boolean;
  options?: string[];
  /** Date fields can also be grouped by month or year. */
  buckets?: boolean;
};

export type DatasetDef = {
  key: string;
  label: string;
  description: string;
  domain: ReportDomain;
  sensitivity: ReportSensitivity;
  /** `employee`: rows belong to an employee (alias `e`), so the caller's team scope applies. `company`: rows are company-level only. */
  scopeKind: "employee" | "company";
  /** Alias of the fact table; its company_id is always constrained. */
  alias: string;
  from: string;
  /** Extra fixed conditions, e.g. "real payslips only". */
  where?: string[];
  /** Alias of the payroll_runs table when payroll-area scope must be applied. */
  payrollRunAlias?: string;
  fields: FieldDef[];
};

const NAME = (a: string) => `TRIM(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, ''))`;
const PRETTY = (c: string) => `INITCAP(REPLACE(${c}, '_', ' '))`;

const f = (key: string, label: string, type: BuilderFieldType, expr: string, o: Partial<FieldDef> = {}): FieldDef => ({ key, label, type, expr, ...o });
const dim = (key: string, label: string, expr: string, o: Partial<FieldDef> = {}) => f(key, label, "text", expr, { groupable: true, ...o });
const num = (key: string, label: string, expr: string, o: Partial<FieldDef> = {}) => f(key, label, "number", expr, { measure: true, ...o });
const date = (key: string, label: string, expr: string, o: Partial<FieldDef> = {}) => f(key, label, "date", expr, { groupable: true, buckets: true, ...o });

const EMP_JOIN = "JOIN employees e ON e.id = {a}.employee_id AND e.company_id = {a}.company_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id";
const empJoin = (a: string) => EMP_JOIN.replace(/\{a\}/g, a);
const PEOPLE = (): FieldDef[] => [
  f("employee_number", "Employee number", "text", "e.employee_number"),
  f("employee", "Employee", "text", NAME("e")),
  dim("department", "Department", "COALESCE(ou.name, 'Not set')"),
];

export const DATASETS: DatasetDef[] = [
  {
    key: "employees",
    label: "Employees",
    description: "One row per employee: unit, position, location, type and dates. Contact, ID and pay details are not available.",
    domain: "workforce",
    sensitivity: "internal",
    scopeKind: "employee",
    alias: "e",
    from: "employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id LEFT JOIN positions p ON p.id = e.position_id LEFT JOIN locations l ON l.id = e.location_id",
    fields: [
      f("employee_number", "Employee number", "text", "e.employee_number"),
      f("employee", "Name", "text", NAME("e")),
      dim("department", "Department", "COALESCE(ou.name, 'Not set')"),
      dim("position", "Position", "COALESCE(p.position_title, e.designation, 'Not set')"),
      dim("location", "Location", "COALESCE(l.name, 'Not set')"),
      dim("employment_type", "Employment type", PRETTY("e.employment_type")),
      dim("employment_status", "Employment status", PRETTY("e.employment_status")),
      date("joined", "Joining date", "e.date_of_joining"),
      date("left", "Termination date", "e.termination_date"),
      num("months_of_service", "Months of service", "(DATE_PART('year', AGE(COALESCE(e.termination_date, CURRENT_DATE), e.date_of_joining)) * 12 + DATE_PART('month', AGE(COALESCE(e.termination_date, CURRENT_DATE), e.date_of_joining)))::int"),
    ],
  },
  {
    key: "leave_requests",
    label: "Leave requests",
    description: "One row per leave request: who, which leave type, the dates, days and status. Reasons and attachments are not available.",
    domain: "leave",
    sensitivity: "internal",
    scopeKind: "employee",
    alias: "lr",
    from: `leave_requests lr ${empJoin("lr")} LEFT JOIN leave_types lt ON lt.company_id = lr.company_id AND lt.code = lr.leave_type`,
    fields: [
      ...PEOPLE(),
      dim("leave_type", "Leave type", "COALESCE(lt.name, lr.leave_type)"),
      dim("status", "Status", PRETTY("lr.status")),
      date("start_date", "Start date", "lr.start_date"),
      date("end_date", "End date", "lr.end_date"),
      date("submitted", "Submitted on", "lr.created_at::date"),
      num("days", "Days requested", "lr.days_requested"),
    ],
  },
  {
    key: "leave_balances",
    label: "Leave balances",
    description: "One row per employee, leave type and year with entitlement, usage and what is left.",
    domain: "leave",
    sensitivity: "internal",
    scopeKind: "employee",
    alias: "lb",
    from: `leave_balances lb ${empJoin("lb")} LEFT JOIN leave_types lt ON lt.company_id = lb.company_id AND lt.code = lb.leave_type`,
    fields: [
      ...PEOPLE(),
      dim("leave_type", "Leave type", "COALESCE(lt.name, lb.leave_type)"),
      f("year", "Year", "number", "lb.year", { groupable: true }),
      num("entitled", "Entitled days", "lb.entitled_days"),
      num("used", "Used days", "lb.used_days"),
      num("remaining", "Remaining days (entitled minus used)", "lb.entitled_days - lb.used_days"),
      num("opening", "Opening days", "lb.opening_days"),
      num("accrued", "Accrued days", "lb.accrued_days"),
      num("carried_forward", "Carried forward days", "lb.carried_forward_days"),
      num("encashed", "Encashed days", "lb.encashed_days"),
      num("expired", "Expired days", "lb.expired_days"),
    ],
  },
  {
    key: "attendance_days",
    label: "Daily attendance",
    description: "One row per employee per working day with the evaluated status, hours worked and lateness.",
    domain: "attendance",
    sensitivity: "internal",
    scopeKind: "employee",
    alias: "r",
    from: `attendance_daily_results r ${empJoin("r")}`,
    fields: [
      ...PEOPLE(),
      date("work_date", "Date", "r.work_date"),
      dim("status", "Attendance status", PRETTY("r.status")),
      num("scheduled_hours", "Scheduled hours", "ROUND(r.scheduled_minutes / 60.0, 2)"),
      num("worked_hours", "Worked hours", "ROUND(r.worked_minutes / 60.0, 2)"),
      num("late_minutes", "Late minutes", "r.late_minutes"),
      num("early_leave_minutes", "Early-leave minutes", "r.early_leave_minutes"),
    ],
  },
  {
    key: "performance_reviews",
    label: "Performance reviews",
    description: "One row per employee per review cycle with status and ratings. Written assessments are not available.",
    domain: "performance",
    sensitivity: "sensitive",
    scopeKind: "employee",
    alias: "pr",
    from: `performance_reviews pr ${empJoin("pr")} JOIN review_cycles rc ON rc.id = pr.review_cycle_id AND rc.company_id = pr.company_id`,
    fields: [
      ...PEOPLE(),
      dim("cycle", "Review cycle", "rc.name"),
      dim("status", "Review status", PRETTY("pr.status")),
      num("manager_rating", "Manager rating", "pr.manager_rating", { groupable: true }),
      num("final_rating", "Final rating (released reviews only)", "CASE WHEN pr.released_at IS NOT NULL THEN pr.final_rating END", { groupable: true }),
    ],
  },
  {
    key: "payslips",
    label: "Payslips",
    description: "One row per employee per real (non-simulation) payroll run: gross, tax, EOBI and net pay. Bank details are not available.",
    domain: "payroll",
    sensitivity: "sensitive",
    scopeKind: "employee",
    alias: "ps",
    from: `payslips ps JOIN payroll_runs pr ON pr.id = ps.payroll_run_id AND pr.company_id = ps.company_id ${empJoin("ps")}`,
    where: ["pr.is_simulation = false", "ps.status <> 'voided'"],
    payrollRunAlias: "pr",
    fields: [
      ...PEOPLE(),
      dim("period", "Payroll month", "to_char(pr.period_start, 'YYYY-MM')"),
      dim("run_status", "Run status", PRETTY("pr.status")),
      num("paid_days", "Paid days", "ps.paid_days"),
      num("unpaid_leave_days", "Unpaid leave days", "ps.unpaid_leave_days"),
      num("gross_pay", "Gross pay (PKR)", "ps.gross_pay"),
      num("income_tax", "Income tax (PKR)", "ps.income_tax_monthly"),
      num("eobi_employee", "EOBI employee share (PKR)", "ps.eobi_employee_contribution"),
      num("net_pay", "Net pay (PKR)", "ps.net_pay"),
      num("employer_cost", "Employer cost (PKR)", "COALESCE(ps.employer_cost, 0)"),
    ],
  },
  {
    key: "applications",
    label: "Job applications",
    description: "One row per application: the job, its department, stage and source. Candidate names and contact details are not available.",
    domain: "recruitment",
    sensitivity: "internal",
    scopeKind: "company",
    alias: "ap",
    from: "applications ap JOIN job_requisitions jr ON jr.id = ap.requisition_id AND jr.company_id = ap.company_id",
    fields: [
      dim("job", "Job title", "jr.title"),
      dim("department", "Department", "COALESCE(NULLIF(jr.department, ''), 'Not set')"),
      dim("stage", "Stage", PRETTY("ap.stage")),
      dim("source", "Source", "COALESCE(NULLIF(ap.source, ''), 'Not recorded')"),
      date("applied", "Applied on", "ap.created_at::date"),
      date("rejected", "Rejected on", "ap.rejected_at::date"),
    ],
  },
];

export const DATASET_BY_KEY = new Map(DATASETS.map((d) => [d.key, d]));
