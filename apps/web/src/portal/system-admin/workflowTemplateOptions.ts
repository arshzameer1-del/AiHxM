import type { ApproverType, EscalationApproverType, WorkflowFallbackType } from "@aihxm/shared-types";

/**
 * Every process the platform can send through an approval route, with plain names, what the person sees, and the facts the
 * request carries (so a route or a step can say "only when the amount is 100000 or more"). `fixedKey` processes always use
 * the template with their own key; the others use whichever active template matches (BACKLOG58).
 */
export type WorkflowField = { key: string; label: string; kind: "number" | "text" };
export type KnownWorkflow = {
  key: string;
  objectKey: string;
  label: string;
  description: string;
  group: "Time and leave" | "Pay" | "Hiring and organisation" | "Privacy";
  fields: WorkflowField[];
};

export const KNOWN_WORKFLOWS: readonly KnownWorkflow[] = [
  { key: "leave_request", objectKey: "leave_request", label: "Leave request approval", group: "Time and leave", description: "Routes every leave request submitted through Leave Management.",
    fields: [{ key: "daysRequested", label: "Days requested", kind: "number" }, { key: "leaveType", label: "Leave type", kind: "text" }, { key: "department", label: "Department", kind: "text" }] },
  { key: "attendance_correction", objectKey: "attendance_correction", label: "Attendance correction approval", group: "Time and leave", description: "A correction to a day's clock-in / clock-out. Without a route here, HR decides it directly.",
    fields: [] },
  { key: "overtime_claim", objectKey: "overtime_claim", label: "Overtime claim approval", group: "Time and leave", description: "Overtime worked and claimed. Without a route here, the manager or HR decides it directly.",
    fields: [{ key: "overtimeMinutes", label: "Overtime minutes", kind: "number" }, { key: "dayType", label: "Day type", kind: "text" }] },
  { key: "on_duty_request", objectKey: "on_duty_request", label: "On-duty request approval", group: "Time and leave", description: "Working away from the office on company business.",
    fields: [{ key: "location", label: "Location", kind: "text" }] },
  { key: "timesheet", objectKey: "timesheet", label: "Timesheet approval", group: "Time and leave", description: "A submitted weekly timesheet.",
    fields: [{ key: "totalMinutes", label: "Total minutes", kind: "number" }] },
  { key: "expense_claim", objectKey: "expense_claim", label: "Expense claim approval", group: "Pay", description: "Routes every expense claim.",
    fields: [{ key: "amount", label: "Amount", kind: "number" }, { key: "category", label: "Category", kind: "text" }] },
  { key: "employee_loan", objectKey: "employee_loan", label: "Loan approval", group: "Pay", description: "A loan or salary advance requested for an employee.",
    fields: [{ key: "principalAmount", label: "Loan amount", kind: "number" }, { key: "loanType", label: "Loan type", kind: "text" }] },
  { key: "additional_payment", objectKey: "additional_payment", label: "Additional payment approval", group: "Pay", description: "A bonus or other extra payment added to a pay run.",
    fields: [{ key: "amount", label: "Amount", kind: "number" }, { key: "paymentType", label: "Payment type", kind: "text" }] },
  { key: "off_cycle_payment", objectKey: "off_cycle_payment", label: "Off-cycle payment approval", group: "Pay", description: "A payment made outside the normal pay run.",
    fields: [{ key: "amount", label: "Amount", kind: "number" }, { key: "paymentType", label: "Payment type", kind: "text" }] },
  { key: "payroll_run", objectKey: "payroll_run", label: "Payroll run approval", group: "Pay",
    description: "Routes a calculated payroll run to whoever should sign off before it can be finalized and disbursed. Point this at the Payroll Approver role for real segregation of duties.",
    fields: [] },
  { key: "job_requisition", objectKey: "job_requisition", label: "Recruitment requisition approval", group: "Hiring and organisation", description: "Routes every job requisition submitted for approval through Recruitment.",
    fields: [{ key: "headcount", label: "Headcount", kind: "number" }, { key: "department", label: "Department", kind: "text" }, { key: "salaryBand", label: "Salary band", kind: "text" }] },
  { key: "offer", objectKey: "offer", label: "Job offer approval", group: "Hiring and organisation", description: "An offer to a candidate, before it is sent.",
    fields: [{ key: "salary", label: "Offered salary", kind: "number" }] },
  { key: "hire_process", objectKey: "hire_process", label: "Hiring approval", group: "Hiring and organisation", description: "A new hire submitted for approval before the employee record is created.",
    fields: [] },
  { key: "position", objectKey: "position", label: "New position approval", group: "Hiring and organisation", description: "A new position in the organisation chart.",
    fields: [{ key: "headcountFte", label: "Headcount (FTE)", kind: "number" }] },
  { key: "org_reorganization", objectKey: "org_reorganization", label: "Reorganization approval", group: "Hiring and organisation", description: "A planned change to units, positions and reporting lines.",
    fields: [{ key: "affectedEmployeeCount", label: "Employees affected", kind: "number" }, { key: "affectedPositionCount", label: "Positions affected", kind: "number" }] },
  { key: "data_subject_request", objectKey: "data_subject_request", label: "Data subject request approval", group: "Privacy", description: "A privacy request (access, correction, deletion) before it is carried out.",
    fields: [{ key: "requestType", label: "Request type", kind: "text" }] },
];

/** Processes that always read the template with their own key; for the rest any matching active template is used. */
export const FIXED_KEY_WORKFLOWS = new Set(["leave_request", "expense_claim", "job_requisition", "payroll_run", "org_reorganization", "data_subject_request"]);

export const APPROVER_TYPE_LABELS: Record<ApproverType, string> = {
  role: "Anyone holding a role",
  specific_user: "A specific person",
  manager_of_submitter: "The requester's manager",
  manager_of_manager: "The requester's manager's manager",
  dotted_line_manager: "The requester's dotted-line manager",
  org_unit_head: "The head of the requester's unit",
  position: "Whoever holds a position",
  group: "A member of an employee group",
};

/** Approver types that are found from the organisation, so they can come up empty and may have a fallback. */
export const FALLBACK_APPLIES_TO: ApproverType[] = ["manager_of_submitter", "manager_of_manager", "dotted_line_manager", "org_unit_head", "position"];

export const FALLBACK_LABELS: Record<WorkflowFallbackType, string> = {
  skip: "Skip this approval",
  role: "Ask anyone holding a role",
  specific_user: "Ask a specific person",
  submitter_manager: "Ask the requester's direct manager",
};

export const ESCALATION_LABELS: Record<EscalationApproverType, string> = {
  role: "Anyone holding a role",
  specific_user: "A specific person",
  manager_of_approver: "The approver's manager",
};
