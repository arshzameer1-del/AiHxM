/**
 * Task #52 (Decision #20) — the fixed, small set of object keys the
 * workflow engine actually has real callers for today
 * (`LeaveRequestsService`/`RecruitmentService`'s own hardcoded
 * `WORKFLOW_TEMPLATE_KEY`/`WORKFLOW_OBJECT_KEY` constants). Deliberately
 * NOT a free-text field on the create form — a System Admin typing an
 * arbitrary key would create a template nothing ever routes through,
 * which is a worse failure mode (a silently unused config) than a fixed
 * picker. Add an entry here only when a real module gains a new
 * workflow-routed object.
 */
export const KNOWN_WORKFLOWS = [
  {
    key: "leave_request",
    objectKey: "leave_request",
    label: "Leave & Attendance approval",
    description: "Routes every leave request submitted through the Leave & Attendance module.",
  },
  {
    key: "job_requisition",
    objectKey: "job_requisition",
    label: "Recruitment requisition approval",
    description: "Routes every job requisition submitted for approval through Recruitment.",
  },
] as const;

export type ApproverTypeOption = "role" | "specific_user" | "manager_of_submitter";

export const APPROVER_TYPE_LABELS: Record<ApproverTypeOption, string> = {
  role: "Anyone holding a role",
  specific_user: "A specific person",
  manager_of_submitter: "The submitter's manager",
};
